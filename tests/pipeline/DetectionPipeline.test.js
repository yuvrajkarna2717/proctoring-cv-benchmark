import { describe, expect, it, vi } from "vitest";
import { FrameScheduler } from "../../src/capture/FrameScheduler.js";
import { DetectionPipeline } from "../../src/pipeline/DetectionPipeline.js";
import { LabError } from "../../src/utils/errors.js";
import { createFakeFrame, deferred, flush } from "../helpers/fakes.js";

const FRAME_INTERVAL = 1000 / 30;

function createFrameSource() {
  const listeners = new Set();
  const captured = [];
  return {
    frameIntervalMs: FRAME_INTERVAL,
    captured,
    failNextCapture: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async captureBitmap({ maxWidth }) {
      if (this.failNextCapture) {
        this.failNextCapture = false;
        throw new LabError("no frame", { code: "NO_FRAME" });
      }
      const frame = createFakeFrame(maxWidth ?? 640, 480);
      captured.push(frame);
      return {
        bitmap: frame,
        width: frame.width,
        height: 480,
        sourceWidth: 640,
        sourceHeight: 480,
        captureMs: 1,
      };
    },
    emit(tick) {
      for (const listener of listeners) listener(tick);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function result(meta) {
  return {
    dropped: false,
    frameAgeMs: 5,
    queueDelayMs: 1,
    result: {
      engine: "x",
      kind: "fake",
      frameId: meta.frameId,
      frameCaptureTime: meta.captureTime,
      startedAt: 0,
      completedAt: 2,
      processingTimeMs: 2,
      timings: { preprocessMs: 0.5, inferenceMs: 1, postprocessMs: 0.5 },
      observations: [],
      model: null,
      executionProvider: "fake",
    },
  };
}

/** Client whose detect() resolves immediately, or stays pending when `manual` is set. */
function createClient({ manual = false } = {}) {
  const pending = [];
  const client = {
    isReady: true,
    calls: 0,
    maxConcurrent: 0,
    active: 0,
    pending,
    detect: vi.fn(async (frame, meta) => {
      client.calls += 1;
      client.active += 1;
      client.maxConcurrent = Math.max(client.maxConcurrent, client.active);
      try {
        if (manual) {
          const gate = deferred();
          pending.push({ gate, meta, frame });
          return await gate.promise;
        }
        frame.close();
        return result(meta);
      } finally {
        client.active -= 1;
      }
    }),
  };
  return client;
}

function createMonitor() {
  return { recordResult: vi.fn(), recordDrop: vi.fn(), recordFailure: vi.fn() };
}

function setup(engines) {
  let now = 0;
  const frameSource = createFrameSource();
  const monitor = createMonitor();
  const pipeline = new DetectionPipeline({ frameSource, monitor, now: () => now });
  for (const engine of engines) {
    pipeline.addEngine({
      id: engine.id,
      client: engine.client,
      scheduler: new FrameScheduler({
        enabled: true,
        targetFps: 5,
        priority: 5,
        maxFrameAgeMs: 500,
        yieldToHigherPriority: false,
        maxYieldMs: 10_000,
        ...engine.scheduler,
      }),
      capture: { maxInputWidth: engine.maxInputWidth ?? null },
    });
  }
  let frameId = 0;
  const tick = async () => {
    frameId += 1;
    frameSource.emit({
      frameId,
      callbackTime: now,
      captureTime: now,
      captureTimeSource: "callbackTime",
      mediaTime: null,
      presentedFrames: frameId,
      width: 640,
      height: 480,
    });
    await flush();
    now += FRAME_INTERVAL;
  };
  return {
    pipeline,
    frameSource,
    monitor,
    tick,
    setNow: (value) => (now = value),
    getNow: () => now,
  };
}

describe("DetectionPipeline", () => {
  it("dispatches each engine at its own rate and records results", async () => {
    const fast = createClient();
    const slow = createClient();
    const { pipeline, tick, monitor } = setup([
      { id: "fast", client: fast, scheduler: { targetFps: 5 } },
      { id: "slow", client: slow, scheduler: { targetFps: 1 } },
    ]);
    pipeline.start();
    for (let i = 0; i < 60; i += 1) await tick(); // 2 s of camera frames
    expect(fast.calls).toBe(10);
    expect(slow.calls).toBe(2);
    expect(monitor.recordResult).toHaveBeenCalledTimes(12);
    const [engineId, , timing] = monitor.recordResult.mock.calls[0];
    expect(engineId).toBe("fast");
    expect(timing).toMatchObject({ captureMs: 1, queueDelayMs: 1, frameAgeMs: 5 });
  });

  it("never sends a second frame while one is in flight (no backlog)", async () => {
    const client = createClient({ manual: true });
    const { pipeline, tick, frameSource } = setup([{ id: "busy", client }]);
    pipeline.start();
    for (let i = 0; i < 30; i += 1) await tick(); // 1 s with the first frame still pending
    expect(client.calls).toBe(1);
    expect(frameSource.captured).toHaveLength(1);
    const { gate, meta } = client.pending[0];
    gate.resolve(result(meta));
    await flush();
    await tick();
    expect(client.calls).toBe(2);
    expect(client.maxConcurrent).toBe(1);
  });

  it("lets a lower-priority engine yield while a higher-priority engine is busy", async () => {
    const high = createClient({ manual: true });
    const low = createClient();
    const { pipeline, tick } = setup([
      // 1 FPS so the high-priority engine is not due again when it finishes its first frame.
      { id: "high", client: high, scheduler: { priority: 10, targetFps: 1 } },
      { id: "low", client: low, scheduler: { priority: 1, yieldToHigherPriority: true } },
    ]);
    pipeline.start();
    for (let i = 0; i < 10; i += 1) await tick();
    expect(high.calls).toBe(1);
    expect(low.calls).toBe(0);
    high.pending[0].gate.resolve(result(high.pending[0].meta));
    await flush();
    await tick();
    expect(low.calls).toBe(1);
  });

  it("records failures and keeps scheduling", async () => {
    const client = createClient();
    client.detect.mockRejectedValueOnce(new LabError("inference failed", { code: "BOOM" }));
    const { pipeline, tick, monitor } = setup([{ id: "flaky", client }]);
    const events = [];
    pipeline.onEvent((event) => events.push(event.type));
    pipeline.start();
    for (let i = 0; i < 30; i += 1) await tick();
    expect(monitor.recordFailure).toHaveBeenCalledTimes(1);
    expect(monitor.recordFailure.mock.calls[0][1]).toMatchObject({ code: "BOOM" });
    expect(monitor.recordResult).toHaveBeenCalledTimes(4);
    expect(events[0]).toBe("error");
  });

  it("classifies restart/unload aborts as drops, not failures", async () => {
    const client = createClient();
    client.detect.mockRejectedValueOnce(new LabError("restarted", { code: "RESTARTED" }));
    const { pipeline, tick, monitor } = setup([{ id: "restarting", client }]);
    pipeline.start();
    await tick();
    expect(monitor.recordFailure).not.toHaveBeenCalled();
    expect(monitor.recordDrop).toHaveBeenCalledWith(
      "restarting",
      expect.objectContaining({ reason: "aborted" }),
      0,
    );
  });

  it("records stale drops reported by the worker", async () => {
    const client = createClient();
    client.detect.mockResolvedValueOnce({
      dropped: true,
      reason: "stale",
      frameId: 1,
      frameAgeMs: 900,
      queueDelayMs: 1,
    });
    const { pipeline, tick, monitor } = setup([{ id: "stale", client }]);
    pipeline.start();
    await tick();
    expect(monitor.recordDrop).toHaveBeenCalledWith(
      "stale",
      expect.objectContaining({ reason: "stale" }),
      0,
    );
  });

  it("reports the scheduler's dispatch time with every recorded outcome", async () => {
    const client = createClient();
    client.detect.mockRejectedValueOnce(new LabError("inference failed", { code: "BOOM" }));
    const { pipeline, tick, monitor, setNow } = setup([{ id: "timed", client }]);
    setNow(5000);
    pipeline.start();
    // 5 FPS on a 30 fps grid: dispatches at 5000 (fails) and on the frame at 5200 ms.
    for (let i = 0; i < 7; i += 1) await tick();
    expect(monitor.recordFailure.mock.calls[0][2]).toBe(5000);
    expect(monitor.recordResult).toHaveBeenCalledTimes(1);
    expect(monitor.recordResult.mock.calls[0][4]).toBeCloseTo(5200, 6);
  });

  it("records capture failures without calling the engine", async () => {
    const client = createClient();
    const { pipeline, tick, monitor, frameSource } = setup([{ id: "cap", client }]);
    frameSource.failNextCapture = true;
    pipeline.start();
    await tick();
    expect(client.calls).toBe(0);
    expect(monitor.recordFailure.mock.calls[0][1]).toMatchObject({ code: "NO_FRAME" });
  });

  it("passes the capture width limit and frame metadata to the engine", async () => {
    const client = createClient();
    const { pipeline, tick } = setup([{ id: "small", client, maxInputWidth: 320 }]);
    pipeline.start();
    await tick();
    const [frame, meta] = client.detect.mock.calls[0];
    expect(frame.width).toBe(320);
    expect(meta).toMatchObject({ frameId: 1, width: 320, sourceWidth: 640, maxFrameAgeMs: 500 });
  });

  it("stops dispatching after stop() and closes frames captured during shutdown", async () => {
    const client = createClient();
    const { pipeline, tick, frameSource } = setup([{ id: "stop", client }]);
    pipeline.start();
    await tick();
    pipeline.stop();
    expect(frameSource.listenerCount).toBe(0);
    for (let i = 0; i < 30; i += 1) await tick();
    expect(client.calls).toBe(1);
    expect(frameSource.captured.every((frame) => frame.closed)).toBe(true);
  });

  it("does not dispatch to engines that are not ready", async () => {
    const client = createClient();
    client.isReady = false;
    const { pipeline, tick } = setup([{ id: "loading", client }]);
    pipeline.start();
    for (let i = 0; i < 10; i += 1) await tick();
    expect(client.calls).toBe(0);
    client.isReady = true;
    await tick();
    expect(client.calls).toBe(1);
  });
});
