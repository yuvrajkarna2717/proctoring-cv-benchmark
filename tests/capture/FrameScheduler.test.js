import { describe, expect, it } from "vitest";
import { FrameScheduler } from "../../src/capture/FrameScheduler.js";
import { ConfigValidationError } from "../../src/utils/errors.js";

const BASE = {
  enabled: true,
  targetFps: 5,
  priority: 5,
  maxFrameAgeMs: 500,
  yieldToHigherPriority: false,
  maxYieldMs: 10_000,
};

/**
 * Drives a scheduler with camera ticks on a fixed grid. Each dispatched frame completes after
 * `inferenceMs` (0 = before the next tick).
 */
function simulate({
  config = {},
  cameraFps = 30,
  durationMs = 10_000,
  inferenceMs = 0,
  higherBusy = () => false,
}) {
  const scheduler = new FrameScheduler({ ...BASE, ...config });
  const frameInterval = 1000 / cameraFps;
  const dispatchTimes = [];
  let completesAt = null;
  let maxInFlight = 0;
  for (let now = 0; now <= durationMs; now += frameInterval) {
    if (completesAt !== null && now >= completesAt) {
      scheduler.markCompleted();
      completesAt = null;
    }
    const decision = scheduler.evaluate(now, {
      sourceFrameIntervalMs: frameInterval,
      engineReady: true,
      higherPriorityInFlight: higherBusy(now),
    });
    if (decision === "dispatch") {
      scheduler.markDispatched(now);
      dispatchTimes.push(now);
      if (inferenceMs === 0) scheduler.markCompleted();
      else completesAt = now + inferenceMs;
    }
    maxInFlight = Math.max(maxInFlight, scheduler.inFlight ? 1 : 0);
  }
  return { scheduler, dispatchTimes, maxInFlight };
}

describe("FrameScheduler rate control", () => {
  it.each([
    [30, 5],
    [20, 5],
    [30, 7],
    [24, 1],
    [30, 15],
  ])("holds the target rate (camera %i fps, target %i fps)", (cameraFps, targetFps) => {
    const { dispatchTimes } = simulate({ config: { targetFps }, cameraFps, durationMs: 20_000 });
    const achievedFps =
      (dispatchTimes.length - 1) / ((dispatchTimes.at(-1) - dispatchTimes[0]) / 1000);
    expect(achievedFps).toBeGreaterThan(targetFps * 0.97);
    expect(achievedFps).toBeLessThan(targetFps * 1.03);
  });

  it("is capped by the camera rate when the target is higher", () => {
    const { dispatchTimes } = simulate({
      config: { targetFps: 60 },
      cameraFps: 30,
      durationMs: 5000,
    });
    expect(dispatchTimes.length).toBeLessThanOrEqual(151);
    expect(dispatchTimes.length).toBeGreaterThanOrEqual(149);
  });

  it("dispatches the first frame immediately", () => {
    const { dispatchTimes } = simulate({ durationMs: 100 });
    expect(dispatchTimes[0]).toBe(0);
  });
});

describe("FrameScheduler backpressure", () => {
  it("never has more than one frame in flight and never bursts after a slow frame", () => {
    const { dispatchTimes, maxInFlight, scheduler } = simulate({
      config: { targetFps: 5 },
      cameraFps: 30,
      durationMs: 10_000,
      inferenceMs: 450,
    });
    expect(maxInFlight).toBe(1);
    const gaps = dispatchTimes.slice(1).map((t, i) => t - dispatchTimes[i]);
    // Each gap is at least the inference time: no queued frame is released in a burst.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(450);
    // 450 ms inference + up to one camera interval before the next frame is taken.
    const rate = dispatchTimes.length / 10;
    expect(rate).toBeGreaterThan(1.9);
    expect(rate).toBeLessThan(2.3);
    const counters = scheduler.getCounters();
    expect(counters.skippedBusy).toBeGreaterThan(0);
    expect(counters.skippedYield).toBe(0);
    expect(counters.dispatched).toBe(dispatchTimes.length);
  });

  it("reports busy while a frame is in flight", () => {
    const scheduler = new FrameScheduler(BASE);
    const context = {
      sourceFrameIntervalMs: 33.3,
      engineReady: true,
      higherPriorityInFlight: false,
    };
    expect(scheduler.evaluate(0, context)).toBe("dispatch");
    scheduler.markDispatched(0);
    expect(scheduler.evaluate(250, context)).toBe("busy");
    expect(() => scheduler.markDispatched(250)).toThrow();
  });

  it("does not count slots missed while the engine was not ready", () => {
    const scheduler = new FrameScheduler(BASE);
    const ready = { sourceFrameIntervalMs: 33.3, engineReady: true, higherPriorityInFlight: false };
    scheduler.evaluate(0, ready);
    scheduler.markDispatched(0);
    scheduler.markCompleted();
    for (let now = 200; now < 3000; now += 33.3) {
      expect(scheduler.evaluate(now, { ...ready, engineReady: false })).toBe("not-ready");
    }
    expect(scheduler.evaluate(3000, ready)).toBe("dispatch");
    scheduler.markDispatched(3000);
    expect(scheduler.getCounters().skippedBusy).toBe(0);
  });
});

describe("FrameScheduler priority yielding", () => {
  it("yields while a higher-priority engine is busy and counts the skipped slots", () => {
    const { scheduler, dispatchTimes } = simulate({
      config: { targetFps: 5, yieldToHigherPriority: true },
      durationMs: 3000,
      // Higher-priority engine busy for the first 1 s.
      higherBusy: (now) => now < 1000,
    });
    expect(dispatchTimes.every((t) => t >= 1000)).toBe(true);
    expect(scheduler.getCounters().skippedYield).toBeGreaterThan(0);
  });

  it("cannot be starved: dispatches once a slot is overdue by maxYieldMs", () => {
    const { dispatchTimes, scheduler } = simulate({
      config: { targetFps: 1, yieldToHigherPriority: true, maxYieldMs: 300 },
      durationMs: 5000,
      higherBusy: () => true, // a higher-priority engine is always in flight
    });
    // One dispatch per second, each at most maxYieldMs (plus one camera frame) late.
    expect(dispatchTimes.length).toBeGreaterThanOrEqual(4);
    expect(dispatchTimes[0]).toBeGreaterThanOrEqual(300);
    expect(dispatchTimes[0]).toBeLessThanOrEqual(300 + 1000 / 30 + 1e-6);
    expect(scheduler.getCounters().skippedYield).toBe(0);
  });

  it("ignores higher-priority activity when yielding is disabled", () => {
    const { dispatchTimes } = simulate({
      config: { targetFps: 5, yieldToHigherPriority: false },
      durationMs: 1000,
      higherBusy: () => true,
    });
    expect(dispatchTimes[0]).toBe(0);
  });
});

describe("FrameScheduler configuration", () => {
  it("returns disabled when not enabled", () => {
    const scheduler = new FrameScheduler({ ...BASE, enabled: false });
    expect(
      scheduler.evaluate(0, {
        sourceFrameIntervalMs: 33,
        engineReady: true,
        higherPriorityInFlight: false,
      }),
    ).toBe("disabled");
  });

  it("validates configuration", () => {
    expect(() => new FrameScheduler({ ...BASE, targetFps: 0 })).toThrow(ConfigValidationError);
    expect(() => new FrameScheduler({ ...BASE, targetFps: -1 })).toThrow(ConfigValidationError);
    expect(() => new FrameScheduler({ ...BASE, extra: true })).toThrow(ConfigValidationError);
    const scheduler = new FrameScheduler(BASE);
    expect(() => scheduler.updateConfig({ priority: 1.5 })).toThrow(ConfigValidationError);
    expect(scheduler.config.priority).toBe(BASE.priority);
  });

  it("re-phases when the target rate changes", () => {
    const scheduler = new FrameScheduler(BASE);
    const context = {
      sourceFrameIntervalMs: 33.3,
      engineReady: true,
      higherPriorityInFlight: false,
    };
    scheduler.evaluate(0, context);
    scheduler.markDispatched(0);
    scheduler.markCompleted();
    expect(scheduler.evaluate(50, context)).toBe("not-due");
    scheduler.updateConfig({ targetFps: 1 });
    expect(scheduler.evaluate(50, context)).toBe("dispatch");
  });

  it("excludes a frame in flight across reset() from the new window's counters", () => {
    const scheduler = new FrameScheduler(BASE);
    const context = {
      sourceFrameIntervalMs: 33.3,
      engineReady: true,
      higherPriorityInFlight: false,
    };
    scheduler.evaluate(0, context);
    scheduler.markDispatched(0);
    scheduler.reset();
    expect(scheduler.inFlight).toBe(true);
    scheduler.markCompleted();
    expect(scheduler.getCounters()).toMatchObject({ dispatched: 0, completed: 0 });
    expect(scheduler.evaluate(10, context)).toBe("dispatch");
    scheduler.markDispatched(10);
    scheduler.markCompleted();
    expect(scheduler.getCounters()).toMatchObject({ dispatched: 1, completed: 1 });
  });

  it("reset clears counters", () => {
    const { scheduler } = simulate({ durationMs: 1000, inferenceMs: 450 });
    scheduler.reset();
    expect(scheduler.getCounters()).toEqual({
      dispatched: 0,
      completed: 0,
      skippedBusy: 0,
      skippedYield: 0,
    });
  });
});
