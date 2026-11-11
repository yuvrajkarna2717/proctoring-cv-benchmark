import { describe, expect, it } from "vitest";
import { AttentionManager } from "../../src/attention/AttentionManager.js";
import { attentionConfig, attentionResult, frame } from "../helpers/attention.js";

function setup(overrides = {}) {
  const clock = { t: 0 };
  const manager = new AttentionManager({
    config: attentionConfig({ baseline: { learnMs: 1000, minSamples: 3 }, ...overrides }),
    now: () => clock.t,
  });
  const events = [];
  manager.onEvent((event) => events.push(event));
  /** @param {Parameters<typeof frame>[0]} options */
  const observe = (options) => {
    clock.t = options.at ?? clock.t;
    return manager.observe(attentionResult(frame(options)));
  };
  return { clock, manager, events, observe };
}

describe("AttentionManager", () => {
  it("learns a baseline from the first frames, then classifies against it", () => {
    const { manager, events, observe } = setup();
    const early = observe({ at: 0, gazeYaw: 2 });
    expect(early.gaze).toMatchObject({ state: "undecided", reason: "no baseline yet" });
    for (let at = 200; at <= 1000; at += 200) observe({ at, gazeYaw: 2 });
    const snapshot = manager.getSnapshot();
    expect(snapshot.profile).toMatchObject({ source: "learned", gazeCenter: { yawDeg: 2 } });
    expect(events.some((e) => e.type === "profile-changed")).toBe(true);
    expect(events.find((e) => e.type === "log").message).toMatch(/Baseline learned/);
    const away = observe({ at: 1200, gazeYaw: 30 });
    expect(away).toMatchObject({
      baseline: "learned",
      gaze: { state: "away", direction: "right" },
    });
    expect(manager.getSnapshot().trail.at(-1)).toMatchObject({ state: "away", yawDeg: 28 });
  });

  it("ignores results of other engines", () => {
    const { manager } = setup();
    expect(manager.observe(attentionResult(frame(), "face-verifier"))).toBeNull();
  });

  it("does not evaluate frames during calibration, and uses the calibration afterwards", () => {
    const { manager, clock, observe } = setup();
    manager.startCalibration({ width: 100, height: 100, fullscreen: true });
    const gaze = {
      center: [0, -10],
      "top-left": [-15, 0],
      "top-right": [15, 0],
      "bottom-right": [15, -20],
      "bottom-left": [-15, -20],
      "center-again": [0, -10],
    };
    while (manager.getSnapshot().calibration.status === "running") {
      const id = manager.getSnapshot().calibration.target.id;
      const start = clock.t;
      for (let k = 0; k < 6; k += 1) {
        const sample = observe({
          at: start + 900 + k * 200,
          gazeYaw: gaze[id][0],
          gazePitch: gaze[id][1],
        });
        expect(sample).toBeNull();
      }
      clock.t = start + 2400;
      manager.tick();
    }
    const snapshot = manager.getSnapshot();
    expect(snapshot.calibration.status).toBe("done");
    expect(snapshot.profile.source).toBe("calibration");
    expect(snapshot.limits.rightDeg).toBeCloseTo(15 / 0.88 + 5, 1);
    expect(observe({ at: clock.t + 200, gazeYaw: 10 }).baseline).toBe("calibration");
    // A new detection session keeps the calibration (same person and setup).
    manager.startSession();
    expect(manager.getSnapshot().profile.source).toBe("calibration");
  });

  it("keeps a calibration across sessions but learns a learned baseline again", () => {
    const { manager, observe } = setup();
    for (let at = 0; at <= 1000; at += 200) observe({ at });
    expect(manager.getSnapshot().profile.source).toBe("learned");
    manager.startSession();
    expect(manager.getSnapshot().profile).toBeNull();
    expect(manager.getSnapshot().stats.frames).toBe(0);
  });

  it("counts short closures as blinks and long ones separately", () => {
    const { manager, observe } = setup();
    for (let at = 0; at <= 1000; at += 200) observe({ at });
    const closed = { blink: 0.9, ear: 0.05 };
    // 0 ms closure (one frame): a blink. 600 ms (four frames): longer than blinkMaxMs (500).
    observe({ at: 1200, ...closed });
    observe({ at: 1400 });
    observe({ at: 1600, ...closed });
    observe({ at: 1800, ...closed });
    observe({ at: 2000, ...closed });
    observe({ at: 2200, ...closed });
    observe({ at: 2400 });
    expect(manager.getSnapshot().stats).toMatchObject({ blinks: 1, longClosures: 1 });
  });

  it("merges nested configuration patches and validates them", () => {
    const { manager } = setup();
    const config = manager.updateConfig({ head: { maxYawDeg: 40 }, preset: "custom" });
    expect(config.head).toEqual({ maxYawDeg: 40, maxPitchUpDeg: 20, maxPitchDownDeg: 25 });
    expect(config.preset).toBe("custom");
    expect(() => manager.updateConfig({ marginDeg: -1 })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
    );
  });

  it("drops the baseline on reset", () => {
    const { manager, events, observe } = setup();
    for (let at = 0; at <= 1000; at += 200) observe({ at });
    manager.resetBaseline();
    expect(manager.getSnapshot().profile).toBeNull();
    expect(events.filter((e) => e.type === "profile-changed").at(-1).profile).toBeNull();
  });
});
