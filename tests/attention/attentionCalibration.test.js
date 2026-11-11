import { describe, expect, it } from "vitest";
import {
  AttentionCalibration,
  CALIBRATION_TARGETS,
} from "../../src/attention/attentionCalibration.js";
import { attentionConfig, frame } from "../helpers/attention.js";

/** Gaze (camera-relative) of a person whose screen centre is at (0, −10). */
const GAZE = {
  center: [0, -10],
  "top-left": [-15, 0],
  "top-right": [15, 0],
  "bottom-right": [15, -20],
  "bottom-left": [-15, -20],
  "center-again": [0.5, -10],
};

function setup(overrides = {}) {
  const clock = { t: 0 };
  const config = attentionConfig(overrides);
  const calibration = new AttentionCalibration({ config, now: () => clock.t });
  /**
   * Feeds one target: six frames inside the sampling window, then the clock past its end.
   * @param {(id: string, k: number) => Partial<Parameters<typeof frame>[0]>} [frameFor]
   */
  const runTarget = (frameFor = (id) => ({ gazeYaw: GAZE[id][0], gazePitch: GAZE[id][1] })) => {
    const id = calibration.state.target.id;
    const start = clock.t;
    for (let k = 0; k < 6; k += 1) {
      clock.t = start + 900 + k * 200;
      calibration.observe(frame({ at: clock.t, ...frameFor(id, k) }));
    }
    clock.t = start + 2400;
    return calibration.tick();
  };
  return { clock, config, calibration, runTarget };
}

describe("AttentionCalibration", () => {
  it("walks through the targets and builds the person's screen area", () => {
    const { calibration, runTarget } = setup();
    calibration.start({ width: 1600, height: 900, fullscreen: true });
    expect(calibration.state).toMatchObject({
      status: "running",
      index: 0,
      phase: "settle",
      target: { id: "center", x: 0.5, y: 0.5 },
    });
    let profile = null;
    const seen = [];
    while (calibration.running) {
      seen.push(calibration.state.target.id);
      profile = runTarget();
    }
    expect(seen).toEqual(CALIBRATION_TARGETS.map((t) => t.id));
    expect(calibration.state.status).toBe("done");
    expect(calibration.state.warnings).toEqual([]);
    // Targets sit 6% in from the edges, so extents are extrapolated by 0.5 / 0.44.
    const scale = 0.5 / 0.44;
    expect(profile).toMatchObject({
      source: "calibration",
      gazeCenter: { yawDeg: 0.25, pitchDeg: -10 },
      headCenter: { yawDeg: 0, pitchDeg: -5 },
      openEar: 0.3,
      samples: 36,
    });
    expect(profile.screen.rightDeg).toBeCloseTo((15 - 0.25) * scale, 1);
    expect(profile.screen.leftDeg).toBeCloseTo((15 + 0.25) * scale, 1);
    expect(profile.screen.upDeg).toBeCloseTo(10 * scale, 1);
    expect(profile.screen.downDeg).toBeCloseTo(10 * scale, 1);
    expect(calibration.profile).toBe(profile);
  });

  it("places corner targets insetRatio in from the viewport edges", () => {
    const { calibration, runTarget } = setup();
    calibration.start({ width: 100, height: 100, fullscreen: true });
    runTarget();
    expect(calibration.state.target).toEqual({ id: "top-left", x: 0.06, y: 0.06 });
  });

  it("ignores frames during the settling time", () => {
    const { calibration, clock } = setup();
    calibration.start({ width: 100, height: 100, fullscreen: true });
    for (let t = 0; t < 800; t += 100) {
      clock.t = t;
      calibration.observe(frame({ at: t, gazeYaw: 30 }));
    }
    clock.t = 2400;
    calibration.tick();
    // No usable frame in the sampling window: the target is repeated.
    expect(calibration.state).toMatchObject({ index: 0, attempt: 2 });
    expect(calibration.state.message).toMatch(/only 0 usable frames/);
  });

  it("repeats a target when the gaze moved, and fails after maxAttempts", () => {
    const { calibration, runTarget } = setup();
    calibration.start({ width: 100, height: 100, fullscreen: true });
    const wandering = (/** @type {string} */ _id, /** @type {number} */ k) => ({ gazeYaw: k * 3 });
    runTarget(wandering);
    expect(calibration.state).toMatchObject({ status: "running", index: 0, attempt: 2 });
    expect(calibration.state.message).toMatch(/hold your gaze on the dot/);
    runTarget(wandering);
    runTarget(wandering);
    expect(calibration.state.status).toBe("failed");
    expect(calibration.state.message).toMatch(/"center" failed 3 times/);
    expect(calibration.profile).toBeNull();
  });

  it("does not count frames with closed eyes or several faces", () => {
    const { calibration, runTarget } = setup();
    calibration.start({ width: 100, height: 100, fullscreen: true });
    runTarget((id, k) => ({ ...(k < 4 ? { blink: 0.9 } : {}), gazeYaw: GAZE[id][0] }));
    // Two usable frames of three needed.
    expect(calibration.state.message).toMatch(/only 2 usable frames of 3/);
  });

  it("fails when the gaze did not move toward the edges", () => {
    const { calibration, runTarget } = setup();
    calibration.start({ width: 100, height: 100, fullscreen: true });
    while (calibration.running) runTarget(() => ({ gazeYaw: 1, gazePitch: -10 }));
    expect(calibration.state.status).toBe("failed");
    expect(calibration.state.message).toMatch(/did not move toward every edge/);
  });

  it("warns about a calibration in a window and about drift between the two centres", () => {
    const { calibration, runTarget } = setup();
    calibration.start({ width: 1600, height: 900, fullscreen: false });
    while (calibration.running) {
      runTarget((id) =>
        id === "center-again"
          ? { gazeYaw: 9, gazePitch: -10 }
          : { gazeYaw: GAZE[id][0], gazePitch: GAZE[id][1] },
      );
    }
    expect(calibration.state.status).toBe("done");
    expect(calibration.state.warnings).toEqual([
      expect.stringMatching(/centre measurements differ by 9/),
      expect.stringMatching(/not full screen/),
    ]);
  });

  it("can be cancelled", () => {
    const { calibration } = setup();
    calibration.start({ width: 100, height: 100, fullscreen: true });
    calibration.cancel();
    expect(calibration.state).toMatchObject({ status: "cancelled", target: null });
    expect(calibration.running).toBe(false);
  });
});
