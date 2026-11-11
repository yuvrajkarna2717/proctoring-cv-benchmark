import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerformanceMonitor } from "../../src/benchmark/PerformanceMonitor.js";
import { LabError } from "../../src/utils/errors.js";

const CONFIG = {
  latencyWindowSize: 100,
  fpsWindowMs: 5000,
  eventLoopProbeIntervalMs: 100,
  stallThresholdMs: 250,
  uiRefreshIntervalMs: 500,
};

function createMonitor() {
  let now = 0;
  const monitor = new PerformanceMonitor(CONFIG, { now: () => now, environment: {} });
  monitor.registerEngine("e1", { label: "Engine 1", kind: "fake" });
  return { monitor, setNow: (value) => (now = value) };
}

function result(
  processingTimeMs,
  timings = { preprocessMs: 1, inferenceMs: processingTimeMs - 2, postprocessMs: 1 },
) {
  return { processingTimeMs, timings };
}

const TIMING = { captureMs: 2, roundTripMs: 20, endToEndMs: 60, queueDelayMs: 1, frameAgeMs: 30 };

describe("PerformanceMonitor", () => {
  it("summarizes recorded latencies per series", () => {
    const { monitor } = createMonitor();
    monitor.markStarted(0);
    [10, 20, 30, 40].forEach((ms, index) =>
      monitor.recordResult("e1", result(ms), TIMING, 100 * (index + 1)),
    );
    const engine = monitor.getSnapshot(1000).engines.e1;
    expect(engine.counters.results).toBe(4);
    expect(engine.latency.engineMs).toMatchObject({
      count: 4,
      mean: 25,
      median: 25,
      min: 10,
      max: 40,
    });
    expect(engine.latency.inferenceMs.mean).toBe(23);
    // transport = round trip - engine time
    expect(engine.latency.transportMs.mean).toBe(20 - 25);
    expect(engine.latency.endToEndMs.mean).toBe(60);
    expect(engine.samplesInWindow).toBe(4);
    expect(engine.lastResultAt).toBe(400);
  });

  it("computes effective FPS from completions in the window", () => {
    const { monitor } = createMonitor();
    monitor.markStarted(0);
    for (let t = 200; t <= 2000; t += 200) monitor.recordResult("e1", result(5), TIMING, t);
    expect(monitor.getSnapshot(2000).engines.e1.effectiveFps).toBeCloseTo(5, 10);
  });

  it("reports null FPS before any measurement window starts", () => {
    const { monitor } = createMonitor();
    expect(monitor.getSnapshot(1000).engines.e1.effectiveFps).toBeNull();
  });

  it("computes average FPS between the first and last result only", () => {
    const { monitor } = createMonitor();
    monitor.markStarted(0);
    // The engine starts 5 s into the window, runs at 5 FPS for 2 s, and detection stops.
    for (let t = 5000; t <= 7000; t += 200) monitor.recordResult("e1", result(5), TIMING, t);
    const later = monitor.getSnapshot(20_000).engines.e1;
    expect(later.averageFps).toBeCloseTo(5, 10);
    expect(later.firstResultAt).toBe(5000);
    expect(later.lastResultAt).toBe(7000);
    // The live rate drops to zero once results stop; the run average does not.
    expect(later.effectiveFps).toBe(0);
  });

  it("reports null average FPS with fewer than two results", () => {
    const { monitor } = createMonitor();
    monitor.markStarted(0);
    expect(monitor.getSnapshot(1000).engines.e1.averageFps).toBeNull();
    monitor.recordResult("e1", result(5), TIMING, 100);
    expect(monitor.getSnapshot(1000).engines.e1.averageFps).toBeNull();
  });

  it("ignores outcomes of frames dispatched before the current window", () => {
    const { monitor } = createMonitor();
    monitor.reset(1000);
    // Dispatched at 990, just before the reset, and settled afterwards.
    monitor.recordResult("e1", result(5), TIMING, 1010, 990);
    monitor.recordDrop("e1", { reason: "stale" }, 990);
    monitor.recordFailure("e1", new LabError("late", { code: "LATE" }), 990);
    expect(() => monitor.recordDrop("e1", { reason: "mystery" }, 990)).toThrow();
    let engine = monitor.getSnapshot(1100).engines.e1;
    expect(engine.counters).toMatchObject({ results: 0, droppedStale: 0, failures: 0 });
    expect(engine.latency.engineMs.count).toBe(0);
    expect(engine.firstResultAt).toBeNull();
    expect(engine.lastError).toBeNull();
    // Dispatched at or after the reset: recorded. 5 FPS from the first in-window result on.
    monitor.recordResult("e1", result(5), TIMING, 1060, 1000);
    monitor.recordResult("e1", result(5), TIMING, 1260, 1200);
    engine = monitor.getSnapshot(1300).engines.e1;
    expect(engine.counters.results).toBe(2);
    expect(engine.averageFps).toBeCloseTo(5, 10);
  });

  it("counts stale and aborted drops separately and rejects unknown reasons", () => {
    const { monitor } = createMonitor();
    monitor.recordDrop("e1", { reason: "stale" });
    monitor.recordDrop("e1", { reason: "stale" });
    monitor.recordDrop("e1", { reason: "aborted" });
    expect(monitor.getSnapshot().engines.e1.counters).toMatchObject({
      droppedStale: 2,
      droppedAborted: 1,
    });
    expect(() => monitor.recordDrop("e1", { reason: "mystery" })).toThrow();
  });

  it("records failures with the serialized error", () => {
    const { monitor } = createMonitor();
    monitor.recordFailure("e1", new LabError("bad frame", { code: "BAD" }));
    const engine = monitor.getSnapshot().engines.e1;
    expect(engine.counters.failures).toBe(1);
    expect(engine.lastError).toMatchObject({ name: "LabError", code: "BAD", message: "bad frame" });
  });

  it("records initialization details", () => {
    const { monitor } = createMonitor();
    monitor.recordInit("e1", {
      spawnToReadyMs: 42,
      hostInitMs: 30,
      initTimings: { moduleLoadMs: 5, modelFetchMs: 10, totalMs: 25 },
      executionProvider: "wasm",
      model: { id: "m", version: "1", runtime: "r" },
    });
    const engine = monitor.getSnapshot().engines.e1;
    expect(engine.init).toEqual({
      spawnToReadyMs: 42,
      hostInitMs: 30,
      moduleLoadMs: 5,
      modelFetchMs: 10,
      totalMs: 25,
    });
    expect(engine.executionProvider).toBe("wasm");
  });

  it("reset clears samples and counters but keeps init records", () => {
    const { monitor } = createMonitor();
    monitor.recordInit("e1", {
      spawnToReadyMs: 1,
      hostInitMs: 1,
      initTimings: { totalMs: 1 },
      executionProvider: "js",
      model: null,
    });
    monitor.recordResult("e1", result(5), TIMING, 10);
    monitor.recordRestart("e1");
    monitor.reset(100);
    const engine = monitor.getSnapshot(200).engines.e1;
    expect(engine.counters).toEqual({
      results: 0,
      failures: 0,
      droppedStale: 0,
      droppedAborted: 0,
      restarts: 0,
    });
    expect(engine.latency.engineMs.count).toBe(0);
    expect(engine.init.spawnToReadyMs).toBe(1);
  });

  it("summarizes engine-reported breakdown parts and clears them on reset", () => {
    const { monitor } = createMonitor();
    const withParts = (detectorMs, recognizerMs) =>
      result(detectorMs + recognizerMs + 2, {
        preprocessMs: 1,
        inferenceMs: detectorMs + recognizerMs,
        postprocessMs: 1,
        breakdownMs: { detectorMs, recognizerMs },
      });
    expect(monitor.getSnapshot(0).engines.e1.breakdownMs).toEqual({});
    monitor.recordResult("e1", withParts(10, 30), TIMING, 10);
    monitor.recordResult("e1", withParts(14, 34), TIMING, 20);
    expect(monitor.getSnapshot(30).engines.e1.breakdownMs).toMatchObject({
      detectorMs: { count: 2, mean: 12 },
      recognizerMs: { count: 2, mean: 32 },
    });
    monitor.reset(100);
    expect(monitor.getSnapshot(200).engines.e1.breakdownMs).toEqual({});
    monitor.recordResult("e1", withParts(11, 31), TIMING, 210, 150);
    expect(monitor.getSnapshot(300).engines.e1.breakdownMs.detectorMs.count).toBe(1);
  });

  it("bounds the latency window", () => {
    const { monitor } = createMonitor();
    for (let i = 0; i < 250; i += 1) monitor.recordResult("e1", result(i + 3), TIMING, i);
    expect(monitor.getSnapshot().engines.e1.latency.engineMs.count).toBe(CONFIG.latencyWindowSize);
  });

  it("produces a JSON-serializable snapshot", () => {
    const { monitor } = createMonitor();
    monitor.markStarted(0);
    monitor.recordResult("e1", result(5), TIMING, 10);
    const snapshot = monitor.getSnapshot(100);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("rejects unregistered engines", () => {
    const { monitor } = createMonitor();
    expect(() => monitor.recordResult("nope", result(1), TIMING, 0)).toThrow(/not registered/);
  });

  it("reports memory as unavailable when no API exists (Node test environment)", async () => {
    const { monitor } = createMonitor();
    const sample = await monitor.measureMemory();
    expect(sample.method).toBe("unavailable");
    expect(monitor.getSnapshot().memory).toEqual(sample);
  });
});

describe("PerformanceMonitor main-thread stalls and page events", () => {
  const EPOCH = 1_000_000;
  let clock;
  let doc;
  let win;
  let monitor;
  let events;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    win = new EventTarget();
    monitor = new PerformanceMonitor(CONFIG, {
      now: () => EPOCH + clock,
      monotonicNow: () => clock,
      environment: { document: doc, window: win },
    });
    events = [];
    monitor.onMainThreadEvent((event) => events.push(event));
    monitor.reset(EPOCH);
    monitor.startMainThreadProbes();
  });

  afterEach(() => {
    monitor.stopMainThreadProbes();
    vi.useRealTimers();
  });

  /** Normal progress: the 100 ms probe fires on time. */
  const step = (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      clock += 100;
      vi.advanceTimersByTime(100);
    }
  };
  /** The next probe fires `ms - 100` ms late (main thread blocked or timers throttled). */
  const late = (ms) => {
    clock += ms;
    vi.advanceTimersByTime(100);
  };
  const setVisibility = (state) => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  const mainThread = () => monitor.getSnapshot().mainThread;

  it("records a stall with timestamps and notifies listeners", () => {
    step(300);
    late(1000);
    const { stalls, eventLoopLagMs } = mainThread();
    expect(stalls.count).toBe(1);
    expect(stalls.maxMs).toBe(900);
    expect(stalls.recent[0]).toEqual({
      startedAt: EPOCH + 1300 - 900,
      endedAt: EPOCH + 1300,
      durationMs: 900,
      pageHiddenDuringGap: false,
      windowBlurredDuringGap: false,
    });
    expect(eventLoopLagMs.max).toBe(900);
    expect(events).toEqual([{ type: "stall", stall: stalls.recent[0] }]);
  });

  it("does not record lateness below the stall threshold as a stall", () => {
    step(200);
    late(300); // 200 ms late, threshold 250 ms
    const { stalls, eventLoopLagMs } = mainThread();
    expect(stalls).toEqual({ count: 0, maxMs: null, hiddenPageGaps: 0, recent: [] });
    expect(eventLoopLagMs.max).toBe(200);
  });

  it("excludes gaps caused by a hidden page from the lag statistics and the stall count", () => {
    step(200);
    setVisibility("hidden");
    late(1000); // throttled probes while hidden: excluded, no stall events
    late(1000);
    setVisibility("visible");
    late(700); // first probe after the page is visible again
    const { stalls, eventLoopLagMs, hiddenSamplesExcluded, pageEvents } = mainThread();
    expect(eventLoopLagMs.count).toBe(2); // only the two on-time probes
    expect(eventLoopLagMs.max).toBe(0);
    expect(hiddenSamplesExcluded).toBe(3);
    expect(stalls).toMatchObject({ count: 0, maxMs: null, hiddenPageGaps: 1 });
    expect(stalls.recent).toEqual([
      expect.objectContaining({ durationMs: 600, pageHiddenDuringGap: true }),
    ]);
    expect(events.filter((event) => event.type === "stall")).toHaveLength(1);
    expect(pageEvents.recent.map((event) => event.type)).toEqual(["hidden", "visible"]);
    expect(pageEvents.counts).toEqual({ hidden: 1, visible: 1, blur: 0, focus: 0 });
  });

  it("flags stalls during which the window lost focus but keeps them in the statistics", () => {
    step(200);
    win.dispatchEvent(new Event("blur"));
    late(1000);
    win.dispatchEvent(new Event("focus"));
    const { stalls, eventLoopLagMs, pageEvents } = mainThread();
    expect(stalls.count).toBe(1);
    expect(stalls.recent[0]).toMatchObject({
      windowBlurredDuringGap: true,
      pageHiddenDuringGap: false,
    });
    expect(eventLoopLagMs.max).toBe(900);
    expect(pageEvents.recent.map((event) => event.type)).toEqual(["blur", "focus"]);
    expect(events.filter((event) => event.type === "page")).toHaveLength(2);
  });

  it("flags a stall while the window stays unfocused long after it lost focus", () => {
    win.dispatchEvent(new Event("blur"));
    step(2000);
    late(500);
    expect(mainThread().stalls.recent[0]).toMatchObject({ windowBlurredDuringGap: true });
    win.dispatchEvent(new Event("focus"));
    step(2000);
    late(500);
    expect(mainThread().stalls.recent[1]).toMatchObject({ windowBlurredDuringGap: false });
  });

  it("uses document.hasFocus() for the focus state when probes start", () => {
    monitor.stopMainThreadProbes();
    doc.hasFocus = () => false;
    monitor.startMainThreadProbes();
    step(200);
    late(500);
    expect(mainThread().stalls.recent[0]).toMatchObject({ windowBlurredDuringGap: true });
  });

  it("stops listening to the page when probes stop, and reset clears events", () => {
    step(100);
    late(1000);
    setVisibility("hidden");
    monitor.stopMainThreadProbes();
    setVisibility("visible");
    expect(mainThread().pageEvents.recent.map((event) => event.type)).toEqual(["hidden"]);
    monitor.reset(EPOCH + clock);
    expect(mainThread()).toMatchObject({
      stalls: { count: 0, maxMs: null, hiddenPageGaps: 0, recent: [] },
      pageEvents: { counts: { hidden: 0, visible: 0, blur: 0, focus: 0 }, recent: [] },
      hiddenSamplesExcluded: 0,
    });
  });
});
