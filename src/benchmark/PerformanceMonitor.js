import { epochNow } from "../utils/clock.js";
import { serializeError } from "../utils/errors.js";
import { RingBuffer, SlidingWindowRate, summarize } from "./stats.js";

/**
 * Latency series recorded per engine (all in milliseconds):
 * - engineMs: total time inside the engine's detect() in the worker
 * - preprocessMs / inferenceMs / postprocessMs: engine-reported stage split of engineMs
 * - captureMs: createImageBitmap on the main thread
 * - roundTripMs: main-thread dispatch → response received
 * - transportMs: roundTripMs - engineMs (postMessage both ways + worker queueing)
 * - queueDelayMs: main-thread dispatch → worker started handling the request
 * - frameAgeMs: camera capture timestamp → worker started handling the request (how old the
 *   frame is when inference starts; stays bounded when there is no backlog)
 * - endToEndMs: camera capture timestamp → result available on the main thread
 */
export const LATENCY_SERIES = Object.freeze([
  "engineMs",
  "preprocessMs",
  "inferenceMs",
  "postprocessMs",
  "captureMs",
  "roundTripMs",
  "transportMs",
  "queueDelayMs",
  "frameAgeMs",
  "endToEndMs",
]);

/** Recent stalls and page events kept for display and export. */
const MAX_RECENT_EVENTS = 50;

/**
 * @typedef {Object} EngineInitRecord
 * @property {number | null} spawnToReadyMs worker creation → engine ready, as seen by the main thread
 * @property {number | null} hostInitMs engine module load + initialize() inside the worker
 * @property {number=} moduleLoadMs
 * @property {number=} modelFetchMs
 * @property {number=} modelInitMs
 * @property {number=} warmupMs
 * @property {number=} totalMs initialize() only
 *
 * @typedef {{ method: 'measureUserAgentSpecificMemory', measuredAt: number, durationMs: number,
 *   totalBytes: number, contexts: Array<{ scope: string, url: string, bytes: number, shared: boolean, entries: number }> }
 *   | { method: 'performance.memory', measuredAt: number, usedJSHeapSize: number,
 *   totalJSHeapSize: number, jsHeapSizeLimit: number, note: string }
 *   | { method: 'unavailable', measuredAt: number, note: string }} MemorySample
 *
 * @typedef {Object} MainThreadStall
 * @property {number} startedAt epoch ms at which the late timer should have fired
 * @property {number} endedAt epoch ms at which the late timer fired
 * @property {number} durationMs how late the probe timer fired
 * @property {boolean} pageHiddenDuringGap the page was hidden at some point during the gap.
 *   Browsers throttle timers of hidden pages, so such a gap is not counted as a stall.
 * @property {boolean} windowBlurredDuringGap the window did not have focus at some point during
 *   the gap (it stays visible, and timers are not throttled for that reason alone)
 *
 * @typedef {'hidden' | 'visible' | 'blur' | 'focus'} PageEventType
 * @typedef {{ at: number, type: PageEventType }} PageEvent
 *
 * @typedef {{ type: 'stall', stall: MainThreadStall } | { type: 'page', event: PageEvent }} MainThreadEvent
 */

/**
 * Collects measured performance data. It never estimates: a metric without samples is reported
 * as null (or count 0), not as a guess.
 *
 * Live statistics use bounded windows (`latencyWindowSize` samples per series, `fpsWindowMs` for
 * rates) so long sessions do not grow memory. Counters cover the whole run since the last
 * reset().
 */
export class PerformanceMonitor {
  /** @type {import('../config/schema.js').MonitorConfig} */
  #config;
  #now;
  #monotonicNow;
  #environment;
  /** @type {Map<string, EngineStats>} */
  #engines = new Map();
  /** @type {number | null} */
  #startedAt = null;
  #eventLoopLag;
  /** @type {ReturnType<typeof setInterval> | null} */
  #eventLoopTimer = null;
  #longTasks = { supported: false, count: 0, totalMs: 0, maxMs: 0 };
  /** @type {PerformanceObserver | null} */
  #longTaskObserver = null;
  /** @type {MemorySample | null} */
  #memory = null;
  /** @type {Array<() => void>} */
  #probeCleanups = [];
  #stalls = emptyStalls();
  /** @type {PageEvent[]} */
  #pageEvents = [];
  #pageEventCounts = emptyPageEventCounts();
  #hiddenSamplesExcluded = 0;
  /**
   * Latest time of each page event; kept across reset() because it describes page state.
   * @type {Record<PageEventType, number | null>}
   */
  #lastPageEventAt = { hidden: null, visible: null, blur: null, focus: null };
  #windowFocused = true;
  #probeSkippedWhileHidden = false;
  /** @type {Set<(event: MainThreadEvent) => void>} */
  #listeners = new Set();

  /**
   * @param {import('../config/schema.js').MonitorConfig} config
   * @param {Object} [dependencies]
   * @param {() => number} [dependencies.now] epoch clock for timestamps
   * @param {() => number} [dependencies.monotonicNow] clock for the event-loop probe
   * @param {{ document?: { visibilityState?: string, hasFocus?: () => boolean } & EventTarget, window?: EventTarget }} [dependencies.environment]
   *   page objects watched for visibility and focus changes
   */
  constructor(
    config,
    {
      now = epochNow,
      monotonicNow = () => performance.now(),
      environment = { document: globalThis.document, window: globalThis.window },
    } = {},
  ) {
    this.#config = config;
    this.#now = now;
    this.#monotonicNow = monotonicNow;
    this.#environment = environment;
    this.#eventLoopLag = new RingBuffer(config.latencyWindowSize);
  }

  /**
   * @param {string} engineId
   * @param {{ label: string, kind: string }} info
   */
  registerEngine(engineId, info) {
    this.#engines.set(engineId, createEngineStats(info, this.#config));
  }

  /**
   * Main-thread stalls and page visibility/focus changes, as they happen.
   *
   * @param {(event: MainThreadEvent) => void} listener
   * @returns {() => void} unsubscribe
   */
  onMainThreadEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts the measurement window (FPS rates are computed from this moment). */
  markStarted(now = this.#now()) {
    this.#startedAt = now;
    for (const stats of this.#engines.values()) stats.completions.reset(now);
  }

  /**
   * Clears samples, counters, and events for a new measurement run; keeps init records. Frames
   * dispatched before this moment are not recorded in the new run when they settle.
   */
  reset(now = this.#now()) {
    for (const stats of this.#engines.values()) {
      for (const series of Object.values(stats.series)) series.clear();
      stats.breakdown.clear();
      stats.counters = emptyCounters();
      stats.firstResultAt = null;
      stats.lastResultAt = null;
      stats.lastError = null;
    }
    this.#eventLoopLag.clear();
    this.#longTasks = { ...this.#longTasks, count: 0, totalMs: 0, maxMs: 0 };
    this.#stalls = emptyStalls();
    this.#pageEvents = [];
    this.#pageEventCounts = emptyPageEventCounts();
    this.#hiddenSamplesExcluded = 0;
    this.markStarted(now);
  }

  /**
   * @param {string} engineId
   * @param {import('../workers/WorkerEngineClient.js').ClientStatus} status
   */
  recordInit(engineId, status) {
    const stats = this.#get(engineId);
    stats.init = {
      spawnToReadyMs: status.spawnToReadyMs,
      hostInitMs: status.hostInitMs,
      ...(status.initTimings ?? {}),
    };
    stats.executionProvider = status.executionProvider;
    stats.model = status.model;
  }

  /** @param {string} engineId */
  recordRestart(engineId) {
    this.#get(engineId).counters.restarts += 1;
  }

  /**
   * @param {string} engineId
   * @param {import('../engines/EngineContract.js').DetectionResult} result
   * @param {import('../pipeline/DetectionPipeline.js').ResultTiming} timing
   * @param {number} receivedAt
   * @param {number} [dispatchedAt] epoch ms at which the frame was scheduled. Outcomes of frames
   *   dispatched before the current measurement window started are ignored (see reset()).
   */
  recordResult(engineId, result, timing, receivedAt, dispatchedAt) {
    const stats = this.#get(engineId);
    if (this.#beforeWindow(dispatchedAt)) return;
    const { series } = stats;
    series.engineMs.push(result.processingTimeMs);
    series.preprocessMs.push(result.timings.preprocessMs);
    series.inferenceMs.push(result.timings.inferenceMs);
    series.postprocessMs.push(result.timings.postprocessMs);
    series.captureMs.push(timing.captureMs);
    series.roundTripMs.push(timing.roundTripMs);
    series.transportMs.push(timing.roundTripMs - result.processingTimeMs);
    series.queueDelayMs.push(timing.queueDelayMs);
    series.frameAgeMs.push(timing.frameAgeMs);
    series.endToEndMs.push(timing.endToEndMs);
    for (const [part, value] of Object.entries(result.timings.breakdownMs ?? {})) {
      let partSeries = stats.breakdown.get(part);
      if (!partSeries) {
        partSeries = new RingBuffer(this.#config.latencyWindowSize);
        stats.breakdown.set(part, partSeries);
      }
      partSeries.push(value);
    }
    stats.completions.record(receivedAt);
    stats.counters.results += 1;
    if (stats.firstResultAt === null) stats.firstResultAt = receivedAt;
    stats.lastResultAt = receivedAt;
  }

  /**
   * Records a frame that was dispatched but produced no result for a non-error reason:
   * "stale" (too old when the worker picked it up) or "aborted" (worker restarted or disposed
   * while the frame was in flight).
   *
   * @param {string} engineId
   * @param {{ reason: string }} drop
   * @param {number} [dispatchedAt] see recordResult()
   */
  recordDrop(engineId, drop, dispatchedAt) {
    const { counters } = this.#get(engineId);
    if (drop.reason !== "stale" && drop.reason !== "aborted") {
      throw new Error(`PerformanceMonitor: unknown drop reason "${drop.reason}"`);
    }
    if (this.#beforeWindow(dispatchedAt)) return;
    if (drop.reason === "stale") counters.droppedStale += 1;
    else counters.droppedAborted += 1;
  }

  /**
   * @param {string} engineId
   * @param {unknown} error
   * @param {number} [dispatchedAt] see recordResult()
   */
  recordFailure(engineId, error, dispatchedAt) {
    const stats = this.#get(engineId);
    if (this.#beforeWindow(dispatchedAt)) return;
    stats.counters.failures += 1;
    stats.lastError = serializeError(error);
  }

  /**
   * Starts main-thread responsiveness probes:
   * - an event-loop lag sampler (all browsers): how late a fixed-interval timer fires;
   * - stall detection: a probe late by at least `stallThresholdMs` is recorded with timestamps
   *   and with whether the page was hidden or the window was unfocused during the gap;
   * - page visibility and window focus events (all browsers);
   * - a Long Tasks observer (Chromium only).
   *
   * Browsers throttle timers on hidden pages (about once per second), so lag samples taken while
   * the page is hidden, or whose gap spans a hidden period, are excluded from the lag statistics
   * and counted in `hiddenSamplesExcluded` instead. A late probe whose gap spans a hidden period
   * is listed with the stalls (flagged) but counted in `hiddenPageGaps`, not in the stall count.
   */
  startMainThreadProbes() {
    if (this.#eventLoopTimer !== null) return;
    const interval = this.#config.eventLoopProbeIntervalMs;
    let expected = this.#monotonicNow() + interval;
    this.#eventLoopTimer = setInterval(() => {
      const monotonic = this.#monotonicNow();
      const lagMs = Math.max(0, monotonic - expected);
      expected = monotonic + interval;
      this.#onProbe(lagMs, interval);
    }, interval);
    this.#watchPage();

    const supportsLongTasks =
      typeof PerformanceObserver === "function" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask");
    this.#longTasks.supported = Boolean(supportsLongTasks);
    if (supportsLongTasks) {
      this.#longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.#longTasks.count += 1;
          this.#longTasks.totalMs += entry.duration;
          this.#longTasks.maxMs = Math.max(this.#longTasks.maxMs, entry.duration);
        }
      });
      this.#longTaskObserver.observe({ type: "longtask" });
    }
  }

  stopMainThreadProbes() {
    if (this.#eventLoopTimer !== null) clearInterval(this.#eventLoopTimer);
    this.#eventLoopTimer = null;
    this.#longTaskObserver?.disconnect();
    this.#longTaskObserver = null;
    for (const cleanup of this.#probeCleanups.splice(0)) cleanup();
  }

  /**
   * Measures memory with the best API available. measureUserAgentSpecificMemory() requires
   * cross-origin isolation, covers workers, and may take several seconds because it waits for
   * garbage collection. performance.memory (Chromium) only covers the main-thread JS heap.
   * GPU memory is not observable from web content.
   *
   * @returns {Promise<MemorySample>}
   */
  async measureMemory() {
    const measuredAt = this.#now();
    /** @type {MemorySample} */
    let sample;
    const perf =
      /** @type {Performance & { measureUserAgentSpecificMemory?: () => Promise<any>, memory?: any }} */ (
        performance
      );
    if (
      typeof perf.measureUserAgentSpecificMemory === "function" &&
      globalThis.crossOriginIsolated
    ) {
      const startedAt = performance.now();
      const result = await perf.measureUserAgentSpecificMemory();
      // Entries are grouped by (scope, script URL). Engine instances of the same kind share a
      // worker script URL, so their memory is reported together; `entries` says how many
      // breakdown entries were merged.
      /** @type {Map<string, { scope: string, url: string, bytes: number, shared: boolean, entries: number }>} */
      const contexts = new Map();
      for (const entry of result.breakdown) {
        if (entry.bytes === 0) continue;
        const attribution = entry.attribution ?? [];
        const first = attribution[0];
        const scope = first?.scope ?? "unattributed";
        const url = first?.url ?? "";
        const key = `${scope}|${url}|${attribution.length > 1}`;
        const existing = contexts.get(key) ?? {
          scope,
          url,
          bytes: 0,
          shared: attribution.length > 1,
          entries: 0,
        };
        existing.bytes += entry.bytes;
        existing.entries += 1;
        contexts.set(key, existing);
      }
      sample = {
        method: "measureUserAgentSpecificMemory",
        measuredAt,
        durationMs: performance.now() - startedAt,
        totalBytes: result.bytes,
        contexts: [...contexts.values()].sort((a, b) => b.bytes - a.bytes),
      };
    } else if (perf.memory) {
      sample = {
        method: "performance.memory",
        measuredAt,
        usedJSHeapSize: perf.memory.usedJSHeapSize,
        totalJSHeapSize: perf.memory.totalJSHeapSize,
        jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
        note: "Main-thread JS heap only; worker, WASM and GPU memory are not included.",
      };
    } else {
      sample = {
        method: "unavailable",
        measuredAt,
        note: "No memory measurement API is available in this browser context.",
      };
    }
    this.#memory = sample;
    return sample;
  }

  /**
   * JSON-serializable view of everything measured so far.
   * @param {number} [now]
   */
  getSnapshot(now = this.#now()) {
    /** @type {Record<string, unknown>} */
    const engines = {};
    for (const [engineId, stats] of this.#engines) {
      const { results } = stats.counters;
      const resultSpanMs =
        stats.firstResultAt !== null && stats.lastResultAt !== null
          ? stats.lastResultAt - stats.firstResultAt
          : 0;
      engines[engineId] = {
        label: stats.info.label,
        kind: stats.info.kind,
        init: stats.init,
        executionProvider: stats.executionProvider,
        model: stats.model,
        // Live rate over the last fpsWindowMs (quantized to 1 result per window).
        effectiveFps: stats.completions.rate(now),
        // Rate between the first and the last result since the last reset. Time before the
        // engine produced its first result and after detection stopped is not counted.
        averageFps: results >= 2 && resultSpanMs > 0 ? ((results - 1) * 1000) / resultSpanMs : null,
        counters: { ...stats.counters },
        latency: Object.fromEntries(
          LATENCY_SERIES.map((name) => [name, summarize(stats.series[name].toArray())]),
        ),
        // Engine-reported parts of engineMs, for example each model of a two-model engine.
        breakdownMs: Object.fromEntries(
          [...stats.breakdown].map(([part, series]) => [part, summarize(series.toArray())]),
        ),
        samplesInWindow: stats.series.engineMs.size,
        firstResultAt: stats.firstResultAt,
        lastResultAt: stats.lastResultAt,
        lastError: stats.lastError,
      };
    }
    return {
      capturedAt: now,
      startedAt: this.#startedAt,
      elapsedMs: this.#startedAt === null ? null : now - this.#startedAt,
      engines,
      mainThread: {
        eventLoopProbeIntervalMs: this.#config.eventLoopProbeIntervalMs,
        eventLoopLagMs: summarize(this.#eventLoopLag.toArray()),
        hiddenSamplesExcluded: this.#hiddenSamplesExcluded,
        stallThresholdMs: this.#config.stallThresholdMs,
        stalls: {
          // Late probes while the page stayed visible.
          count: this.#stalls.count,
          maxMs: this.#stalls.count > 0 ? this.#stalls.maxMs : null,
          // Late probes whose gap spanned a hidden page (timer throttling, not blocking).
          hiddenPageGaps: this.#stalls.hiddenPageGaps,
          // The latest MAX_RECENT_EVENTS of both kinds, oldest first.
          recent: this.#stalls.recent.map((stall) => ({ ...stall })),
        },
        pageEvents: {
          counts: { ...this.#pageEventCounts },
          recent: this.#pageEvents.map((event) => ({ ...event })),
        },
        longTasks: { ...this.#longTasks },
      },
      memory: this.#memory,
    };
  }

  /** @param {string} engineId */
  #get(engineId) {
    const stats = this.#engines.get(engineId);
    if (!stats) throw new Error(`PerformanceMonitor: engine "${engineId}" is not registered`);
    return stats;
  }

  /**
   * A frame that was in flight when the window started belongs to the previous window, like in
   * the scheduler's counters. Counting its result would add a result the window never dispatched
   * and, because the scheduler dispatches again right after it, shorten the first interval.
   *
   * @param {number | undefined} dispatchedAt
   */
  #beforeWindow(dispatchedAt) {
    return dispatchedAt !== undefined && this.#startedAt !== null && dispatchedAt < this.#startedAt;
  }

  /**
   * @param {number} lagMs how late the probe fired
   * @param {number} intervalMs probe interval
   */
  #onProbe(lagMs, intervalMs) {
    if (this.#isPageHidden()) {
      // Timers of hidden pages are throttled; these samples say nothing about blocking.
      this.#hiddenSamplesExcluded += 1;
      this.#probeSkippedWhileHidden = true;
      return;
    }
    const endedAt = this.#now();
    // The gap runs from the previous probe (gapStart) to this one.
    const gapStart = endedAt - lagMs - intervalMs;
    const last = this.#lastPageEventAt;
    const since = (/** @type {number | null} */ at) => at !== null && at >= gapStart;
    // Hidden during the gap: the previous probe ran while hidden, or the page was hidden or
    // became visible again since the previous probe.
    const pageHiddenDuringGap =
      this.#probeSkippedWhileHidden || since(last.hidden) || since(last.visible);
    // Unfocused during the gap: unfocused now, or focus was lost or regained since then.
    const windowBlurredDuringGap = !this.#windowFocused || since(last.blur) || since(last.focus);
    this.#probeSkippedWhileHidden = false;
    if (pageHiddenDuringGap) this.#hiddenSamplesExcluded += 1;
    else this.#eventLoopLag.push(lagMs);
    if (lagMs < this.#config.stallThresholdMs) return;

    /** @type {MainThreadStall} */
    const stall = {
      startedAt: endedAt - lagMs,
      endedAt,
      durationMs: lagMs,
      pageHiddenDuringGap,
      windowBlurredDuringGap,
    };
    if (pageHiddenDuringGap) {
      this.#stalls.hiddenPageGaps += 1;
    } else {
      this.#stalls.count += 1;
      this.#stalls.maxMs = Math.max(this.#stalls.maxMs, lagMs);
    }
    this.#stalls.recent.push(stall);
    if (this.#stalls.recent.length > MAX_RECENT_EVENTS) this.#stalls.recent.shift();
    this.#emit({ type: "stall", stall });
  }

  #watchPage() {
    const { document: doc, window: win } = this.#environment ?? {};
    /**
     * @param {EventTarget} target
     * @param {string} type
     * @param {() => void} handler
     */
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      this.#probeCleanups.push(() => target.removeEventListener(type, handler));
    };
    if (doc && typeof doc.addEventListener === "function") {
      listen(doc, "visibilitychange", () =>
        this.#recordPageEvent(doc.visibilityState === "hidden" ? "hidden" : "visible"),
      );
    }
    // Without document.hasFocus() the window is assumed focused, so nothing is flagged.
    this.#windowFocused = typeof doc?.hasFocus === "function" ? doc.hasFocus() : true;
    if (win && typeof win.addEventListener === "function") {
      listen(win, "blur", () => this.#recordPageEvent("blur"));
      listen(win, "focus", () => this.#recordPageEvent("focus"));
    }
  }

  /** @param {PageEventType} type */
  #recordPageEvent(type) {
    /** @type {PageEvent} */
    const event = { at: this.#now(), type };
    this.#lastPageEventAt[type] = event.at;
    if (type === "blur") this.#windowFocused = false;
    if (type === "focus") this.#windowFocused = true;
    this.#pageEventCounts[type] += 1;
    this.#pageEvents.push(event);
    if (this.#pageEvents.length > MAX_RECENT_EVENTS) this.#pageEvents.shift();
    this.#emit({ type: "page", event });
  }

  #isPageHidden() {
    return this.#environment?.document?.visibilityState === "hidden";
  }

  /** @param {MainThreadEvent} event */
  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Main-thread event listener failed", error);
      }
    }
  }
}

/**
 * @typedef {Object} EngineStats
 * @property {{ label: string, kind: string }} info
 * @property {EngineInitRecord | null} init
 * @property {string | null} executionProvider
 * @property {import('../engines/EngineContract.js').ModelInfo | null} model
 * @property {Record<string, RingBuffer>} series
 * @property {Map<string, RingBuffer>} breakdown engine-reported parts (`timings.breakdownMs`)
 * @property {SlidingWindowRate} completions
 * @property {ReturnType<typeof emptyCounters>} counters
 * @property {number | null} firstResultAt
 * @property {number | null} lastResultAt
 * @property {import('../utils/errors.js').SerializedError | null} lastError
 */

function emptyCounters() {
  return { results: 0, failures: 0, droppedStale: 0, droppedAborted: 0, restarts: 0 };
}

/** @returns {{ count: number, maxMs: number, hiddenPageGaps: number, recent: MainThreadStall[] }} */
function emptyStalls() {
  return { count: 0, maxMs: 0, hiddenPageGaps: 0, recent: [] };
}

/** @returns {Record<PageEventType, number>} */
function emptyPageEventCounts() {
  return { hidden: 0, visible: 0, blur: 0, focus: 0 };
}

/**
 * @param {{ label: string, kind: string }} info
 * @param {import('../config/schema.js').MonitorConfig} config
 * @returns {EngineStats}
 */
function createEngineStats(info, config) {
  return {
    info,
    init: null,
    executionProvider: null,
    model: null,
    series: Object.fromEntries(
      LATENCY_SERIES.map((name) => [name, new RingBuffer(config.latencyWindowSize)]),
    ),
    breakdown: new Map(),
    completions: new SlidingWindowRate(config.fpsWindowMs),
    counters: emptyCounters(),
    firstResultAt: null,
    lastResultAt: null,
    lastError: null,
  };
}
