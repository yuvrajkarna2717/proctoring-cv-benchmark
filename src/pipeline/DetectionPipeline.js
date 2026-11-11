import { closeFrame } from "../engines/EngineContract.js";
import { epochNow } from "../utils/clock.js";

/** Error codes meaning a frame was abandoned on purpose (restart/unload), not a failure. */
const ABORT_CODES = new Set(["RESTARTED", "DISPOSED"]);

/**
 * @typedef {Object} PipelineEngine
 * @property {boolean} isReady
 * @property {(frame: ImageBitmap, meta: import('../engines/EngineContract.js').FrameMeta) => Promise<import('../workers/WorkerEngineClient.js').DetectResponse>} detect
 *
 * @typedef {Object} PipelineEntry
 * @property {string} id engine instance id
 * @property {PipelineEngine} client usually a WorkerEngineClient
 * @property {import('../capture/FrameScheduler.js').FrameScheduler} scheduler
 * @property {{ maxInputWidth: number | null }} capture
 *
 * @typedef {Object} FrameSource
 * @property {(listener: (tick: import('../capture/VideoFrameSource.js').FrameTick) => void) => () => void} subscribe
 * @property {(options: { maxWidth?: number | null }) => Promise<import('../capture/VideoFrameSource.js').CapturedFrame>} captureBitmap
 * @property {number | null} frameIntervalMs
 *
 * @typedef {Object} ResultTiming
 * @property {number} captureMs createImageBitmap on the main thread
 * @property {number} roundTripMs main-thread dispatch → response received
 * @property {number} endToEndMs camera capture timestamp → response received
 * @property {number} queueDelayMs main-thread dispatch → worker started handling the request
 * @property {number} frameAgeMs camera capture timestamp → worker started handling the request
 *
 * @typedef {{ type: 'result', engineId: string, result: import('../engines/EngineContract.js').DetectionResult, timing: ResultTiming, receivedAt: number }
 *   | { type: 'dropped', engineId: string, frameId: number, reason: string, frameAgeMs: number }
 *   | { type: 'error', engineId: string, frameId: number, error: unknown }} PipelineEvent
 *
 * Every record call ends with `dispatchedAt`, the epoch ms at which the scheduler dispatched the
 * frame, so the monitor can leave out frames dispatched before its current measurement window.
 *
 * @typedef {Object} PipelineMonitor
 * @property {(engineId: string, result: import('../engines/EngineContract.js').DetectionResult, timing: ResultTiming, receivedAt: number, dispatchedAt: number) => void} recordResult
 * @property {(engineId: string, drop: { reason: string, frameAgeMs: number, queueDelayMs: number }, dispatchedAt: number) => void} recordDrop
 * @property {(engineId: string, error: unknown, dispatchedAt: number) => void} recordFailure
 */

/**
 * Connects a frame source to independently scheduled engines.
 *
 * For every source frame the engines are evaluated in priority order (highest first). Each
 * scheduler decides on its own whether its engine is due; the pipeline captures a fresh bitmap
 * only for engines that are due and idle and hands it over without waiting, so a slow engine
 * never delays the camera preview or another engine. A lower-priority engine configured with
 * `yieldToHigherPriority` skips its slot while a higher-priority engine is still in flight.
 *
 * The pipeline produces observations only. Interpreting them (temporal evaluation, violations)
 * belongs to later layers that subscribe through onEvent().
 */
export class DetectionPipeline {
  #frameSource;
  #monitor;
  #now;
  #defaultFrameIntervalMs;
  /** @type {Map<string, PipelineEntry>} */
  #entries = new Map();
  #running = false;
  /** @type {(() => void) | null} */
  #unsubscribe = null;
  /** @type {Set<(event: PipelineEvent) => void>} */
  #listeners = new Set();

  /**
   * @param {Object} options
   * @param {FrameSource} options.frameSource
   * @param {PipelineMonitor} [options.monitor]
   * @param {() => number} [options.now]
   * @param {number} [options.defaultFrameIntervalMs] used until the source has measured its rate
   */
  constructor({ frameSource, monitor, now = epochNow, defaultFrameIntervalMs = 1000 / 30 }) {
    this.#frameSource = frameSource;
    this.#monitor = monitor;
    this.#now = now;
    this.#defaultFrameIntervalMs = defaultFrameIntervalMs;
  }

  /** @returns {boolean} */
  get isRunning() {
    return this.#running;
  }

  /** @param {PipelineEntry} entry */
  addEngine(entry) {
    if (this.#entries.has(entry.id)) throw new Error(`Engine "${entry.id}" is already registered`);
    this.#entries.set(entry.id, entry);
  }

  /** @param {string} id */
  removeEngine(id) {
    this.#entries.delete(id);
  }

  /**
   * @param {(event: PipelineEvent) => void} listener
   * @returns {() => void} unsubscribe
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start() {
    if (this.#running) return;
    for (const entry of this.#entries.values()) entry.scheduler.reset();
    this.#unsubscribe = this.#frameSource.subscribe((tick) => this.#onTick(tick));
    this.#running = true;
  }

  /** Stops dispatching. Frames already in flight settle normally and are still recorded. */
  stop() {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** @param {import('../capture/VideoFrameSource.js').FrameTick} tick */
  #onTick(tick) {
    if (!this.#running) return;
    const now = this.#now();
    const sourceFrameIntervalMs = this.#frameSource.frameIntervalMs ?? this.#defaultFrameIntervalMs;
    const ordered = [...this.#entries.values()].sort(
      (a, b) => b.scheduler.config.priority - a.scheduler.config.priority,
    );
    let highestBusyPriority = -Infinity;
    for (const entry of ordered) {
      const priority = entry.scheduler.config.priority;
      const decision = entry.scheduler.evaluate(now, {
        sourceFrameIntervalMs,
        engineReady: entry.client.isReady,
        higherPriorityInFlight: highestBusyPriority > priority,
      });
      if (decision === "dispatch") {
        entry.scheduler.markDispatched(now);
        void this.#dispatch(entry, tick, now);
      }
      if (entry.scheduler.inFlight) highestBusyPriority = Math.max(highestBusyPriority, priority);
    }
  }

  /**
   * Captures, sends, and records one frame for one engine. Never rejects.
   *
   * @param {PipelineEntry} entry
   * @param {import('../capture/VideoFrameSource.js').FrameTick} tick
   * @param {number} dispatchedAt epoch ms at which the scheduler dispatched the frame
   */
  async #dispatch(entry, tick, dispatchedAt) {
    const { id, client, scheduler, capture } = entry;
    /** @type {ImageBitmap | null} */
    let bitmap = null;
    try {
      const captured = await this.#frameSource.captureBitmap({ maxWidth: capture.maxInputWidth });
      bitmap = captured.bitmap;
      if (!this.#running) return; // stopped while capturing; the bitmap is closed below
      /** @type {import('../engines/EngineContract.js').FrameMeta} */
      const meta = {
        frameId: tick.frameId,
        captureTime: tick.captureTime,
        captureTimeSource: tick.captureTimeSource,
        mediaTime: tick.mediaTime,
        sourceWidth: captured.sourceWidth,
        sourceHeight: captured.sourceHeight,
        width: captured.width,
        height: captured.height,
        maxFrameAgeMs: scheduler.config.maxFrameAgeMs,
        dispatchTime: this.#now(),
      };
      const owned = bitmap;
      bitmap = null; // ownership passes to the client, which transfers or closes it
      const response = await client.detect(owned, meta);
      const receivedAt = this.#now();
      if (response.dropped) {
        this.#monitor?.recordDrop(id, response, dispatchedAt);
        this.#emit({
          type: "dropped",
          engineId: id,
          frameId: tick.frameId,
          reason: response.reason,
          frameAgeMs: response.frameAgeMs,
        });
        return;
      }
      /** @type {ResultTiming} */
      const timing = {
        captureMs: captured.captureMs,
        roundTripMs: receivedAt - meta.dispatchTime,
        endToEndMs: receivedAt - tick.captureTime,
        queueDelayMs: response.queueDelayMs,
        frameAgeMs: response.frameAgeMs,
      };
      this.#monitor?.recordResult(id, response.result, timing, receivedAt, dispatchedAt);
      this.#emit({ type: "result", engineId: id, result: response.result, timing, receivedAt });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code !== undefined && ABORT_CODES.has(code)) {
        // The worker was restarted or disposed on purpose while this frame was in flight.
        this.#monitor?.recordDrop(
          id,
          { reason: "aborted", frameAgeMs: NaN, queueDelayMs: NaN },
          dispatchedAt,
        );
        this.#emit({
          type: "dropped",
          engineId: id,
          frameId: tick.frameId,
          reason: "aborted",
          frameAgeMs: NaN,
        });
      } else {
        this.#monitor?.recordFailure(id, error, dispatchedAt);
        this.#emit({ type: "error", engineId: id, frameId: tick.frameId, error });
      }
    } finally {
      closeFrame(bitmap);
      scheduler.markCompleted();
    }
  }

  /** @param {PipelineEvent} event */
  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Pipeline event listener failed", error);
      }
    }
  }
}
