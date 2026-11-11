import { mean, median, round, usableForBaseline } from "./attentionModel.js";

/**
 * Guided calibration of the person's screen area. A dot appears at the centre, the four
 * corners, and the centre again; the person looks at it. For each target the gaze is sampled
 * after a settling time; a target is repeated if too few usable frames arrived or the gaze
 * moved too much. The result is an AttentionProfile with the person's gaze direction at the
 * screen centre, the measured extent to each edge, the head pose at the centre, and the
 * open-eye aspect ratio.
 *
 * Driven by frames (`observe`) and the clock (`tick`); pure logic, no DOM. The UI draws the
 * target at `state.target` (fractions of the viewport).
 *
 * @typedef {{ id: string, x: number, y: number }} CalibrationTarget x, y in 0–1 before inset
 *
 * @typedef {Object} TargetResult
 * @property {string} id
 * @property {number} samples
 * @property {number} attempts
 * @property {number} gazeYawDeg median
 * @property {number} gazePitchDeg
 * @property {number} spreadDeg larger standard deviation of gaze yaw and pitch
 * @property {number} headYawDeg
 * @property {number} headPitchDeg
 * @property {number | null} ear
 *
 * @typedef {Object} CalibrationState
 * @property {'idle' | 'running' | 'done' | 'failed' | 'cancelled'} status
 * @property {number} index current target, 0-based
 * @property {number} total
 * @property {{ id: string, x: number, y: number } | null} target viewport fractions with inset
 * @property {'settle' | 'sample' | null} phase
 * @property {number} attempt
 * @property {string | null} message instruction or the reason for a repeat or failure
 * @property {TargetResult[]} results
 * @property {string[]} warnings
 * @property {{ width: number, height: number, fullscreen: boolean } | null} viewport
 */

/** @type {readonly CalibrationTarget[]} */
export const CALIBRATION_TARGETS = Object.freeze([
  { id: "center", x: 0.5, y: 0.5 },
  { id: "top-left", x: 0, y: 0 },
  { id: "top-right", x: 1, y: 0 },
  { id: "bottom-right", x: 1, y: 1 },
  { id: "bottom-left", x: 0, y: 1 },
  { id: "center-again", x: 0.5, y: 0.5 },
]);

/** Frames still in flight when a sampling window closes are waited for this long. */
const LATE_FRAME_MS = 300;

export class AttentionCalibration {
  /** @type {import('../config/schema.js').AttentionConfig['calibration']} */
  #config;
  /** @type {import('../config/schema.js').AttentionConfig['defaultScreen']} */
  #defaultScreen;
  /** @type {() => number} */
  #now;
  /** @type {CalibrationState} */
  #state = idleState();
  #targetStartedAt = 0;
  /** @type {Array<{ gazeYaw: number, gazePitch: number, headYaw: number, headPitch: number, ear: number | null }>} */
  #samples = [];
  /** @type {import('./attentionModel.js').AttentionProfile | null} */
  #profile = null;

  /**
   * @param {{ config: import('../config/schema.js').AttentionConfig, now: () => number }} options
   */
  constructor({ config, now }) {
    this.#config = config.calibration;
    this.#defaultScreen = config.defaultScreen;
    this.#now = now;
  }

  /** @param {import('../config/schema.js').AttentionConfig} config applies to the next run */
  setConfig(config) {
    this.#config = config.calibration;
    this.#defaultScreen = config.defaultScreen;
  }

  /** @returns {CalibrationState} */
  get state() {
    return structuredClone(this.#state);
  }

  get running() {
    return this.#state.status === "running";
  }

  /** The profile of the last successful run. */
  get profile() {
    return this.#profile;
  }

  /** @param {{ width: number, height: number, fullscreen: boolean }} viewport */
  start(viewport) {
    this.#state = {
      ...idleState(),
      status: "running",
      total: CALIBRATION_TARGETS.length,
      viewport: { ...viewport },
    };
    this.#profile = null;
    this.#beginTarget(0, 1);
  }

  cancel() {
    if (this.#state.status !== "running") return;
    this.#state = {
      ...this.#state,
      status: "cancelled",
      target: null,
      phase: null,
      message: "Calibration cancelled",
    };
  }

  /** @param {import('./attentionModel.js').AttentionFrame} frame */
  observe(frame) {
    if (this.#state.status !== "running") return;
    const { settleMs, sampleMs } = this.#config;
    const from = this.#targetStartedAt + settleMs;
    if (frame.at >= from && frame.at <= from + sampleMs && usableForBaseline(frame)) {
      const ears = [frame.eyes?.earLeft, frame.eyes?.earRight].filter(
        (value) => typeof value === "number",
      );
      this.#samples.push({
        gazeYaw: /** @type {any} */ (frame.gaze).yawDeg,
        gazePitch: /** @type {any} */ (frame.gaze).pitchDeg,
        headYaw: /** @type {any} */ (frame.head).yawDeg,
        headPitch: /** @type {any} */ (frame.head).pitchDeg,
        ear: ears.length > 0 ? mean(/** @type {number[]} */ (ears)) : null,
      });
    }
    this.tick();
  }

  /**
   * Advances phases and targets by the clock.
   * @returns {import('./attentionModel.js').AttentionProfile | null} the profile when the run
   *   finished successfully on this call
   */
  tick() {
    if (this.#state.status !== "running") return null;
    const { settleMs, sampleMs } = this.#config;
    const elapsed = this.#now() - this.#targetStartedAt;
    if (elapsed < settleMs) return null;
    if (this.#state.phase === "settle") {
      this.#state = { ...this.#state, phase: "sample", message: "Keep looking at the dot" };
    }
    if (elapsed < settleMs + sampleMs + LATE_FRAME_MS) return null;
    return this.#finishTarget();
  }

  #finishTarget() {
    const { minSamples, maxSpreadDeg, maxAttempts } = this.#config;
    const samples = this.#samples;
    const target = CALIBRATION_TARGETS[this.#state.index];
    const spread =
      samples.length > 1
        ? Math.max(sd(samples.map((s) => s.gazeYaw)), sd(samples.map((s) => s.gazePitch)))
        : 0;
    /** @type {string | null} */
    let problem = null;
    if (samples.length < minSamples) {
      problem = `only ${samples.length} usable frames of ${minSamples} needed: keep your face in view, alone, with open eyes`;
    } else if (spread > maxSpreadDeg) {
      problem = `the gaze moved ${round(spread, 1)}° (limit ${maxSpreadDeg}°): hold your gaze on the dot`;
    }
    if (problem) {
      if (this.#state.attempt >= maxAttempts) {
        this.#fail(`Target "${target.id}" failed ${maxAttempts} times: ${problem}`);
        return null;
      }
      this.#beginTarget(this.#state.index, this.#state.attempt + 1, `Again: ${problem}`);
      return null;
    }
    const ears = samples.map((s) => s.ear).filter((value) => value !== null);
    /** @type {TargetResult} */
    const result = {
      id: target.id,
      samples: samples.length,
      attempts: this.#state.attempt,
      gazeYawDeg: round(median(samples.map((s) => s.gazeYaw))),
      gazePitchDeg: round(median(samples.map((s) => s.gazePitch))),
      spreadDeg: round(spread),
      headYawDeg: round(median(samples.map((s) => s.headYaw))),
      headPitchDeg: round(median(samples.map((s) => s.headPitch))),
      ear: ears.length > 0 ? round(median(/** @type {number[]} */ (ears)), 4) : null,
    };
    this.#state = { ...this.#state, results: [...this.#state.results, result] };
    if (this.#state.index + 1 < CALIBRATION_TARGETS.length) {
      this.#beginTarget(this.#state.index + 1, 1);
      return null;
    }
    return this.#complete();
  }

  #complete() {
    const byId = Object.fromEntries(this.#state.results.map((result) => [result.id, result]));
    const centers = [byId.center, byId["center-again"]];
    const center = {
      yawDeg: mean(centers.map((c) => c.gazeYawDeg)),
      pitchDeg: mean(centers.map((c) => c.gazePitchDeg)),
    };
    // Targets sit insetRatio in from the edges; extrapolate the extent to the viewport edge.
    const scale = 0.5 / (0.5 - this.#config.insetRatio);
    const side = (/** @type {string[]} */ ids, /** @type {'gazeYawDeg' | 'gazePitchDeg'} */ key) =>
      mean(ids.map((id) => byId[id][key]));
    const measured = {
      rightDeg: (side(["top-right", "bottom-right"], "gazeYawDeg") - center.yawDeg) * scale,
      leftDeg: (center.yawDeg - side(["top-left", "bottom-left"], "gazeYawDeg")) * scale,
      upDeg: (side(["top-left", "top-right"], "gazePitchDeg") - center.pitchDeg) * scale,
      downDeg: (center.pitchDeg - side(["bottom-left", "bottom-right"], "gazePitchDeg")) * scale,
    };
    const wrong = Object.entries(measured).filter(([, value]) => value < 1);
    if (wrong.length > 0) {
      const names = wrong.map(([key, value]) => `${key.replace("Deg", "")} ${round(value, 1)}°`);
      this.#fail(
        `The gaze did not move toward every edge (${names.join(", ")}; at least 1° needed). Follow the dot with your eyes and calibrate again.`,
      );
      return null;
    }
    const warnings = [];
    const drift = Math.hypot(
      centers[0].gazeYawDeg - centers[1].gazeYawDeg,
      centers[0].gazePitchDeg - centers[1].gazePitchDeg,
    );
    if (drift > 2 * this.#config.maxSpreadDeg) {
      warnings.push(
        `The two centre measurements differ by ${round(drift, 1)}°; the position may have changed during calibration.`,
      );
    }
    const viewport = this.#state.viewport;
    if (viewport && !viewport.fullscreen) {
      warnings.push(
        "Calibrated in a browser window, not full screen: the measured area is the window, not the whole screen.",
      );
    }
    const ears = centers.map((c) => c.ear).filter((value) => value !== null);
    /** @type {import('./attentionModel.js').AttentionProfile} */
    const profile = {
      source: "calibration",
      createdAt: this.#now(),
      gazeCenter: { yawDeg: round(center.yawDeg), pitchDeg: round(center.pitchDeg) },
      screen: {
        leftDeg: round(Math.min(measured.leftDeg, 60)),
        rightDeg: round(Math.min(measured.rightDeg, 60)),
        upDeg: round(Math.min(measured.upDeg, 60)),
        downDeg: round(Math.min(measured.downDeg, 60)),
      },
      headCenter: {
        yawDeg: round(mean(centers.map((c) => c.headYawDeg))),
        pitchDeg: round(mean(centers.map((c) => c.headPitchDeg))),
      },
      openEar: ears.length > 0 ? round(mean(/** @type {number[]} */ (ears)), 4) : null,
      samples: this.#state.results.reduce((sum, result) => sum + result.samples, 0),
      details: {
        targets: this.#state.results,
        centerDriftDeg: round(drift),
        insetRatio: this.#config.insetRatio,
        viewport,
        defaultScreen: { ...this.#defaultScreen },
      },
    };
    this.#profile = profile;
    this.#state = {
      ...this.#state,
      status: "done",
      target: null,
      phase: null,
      warnings,
      message: "Calibration complete",
    };
    return profile;
  }

  /** @param {string} message */
  #fail(message) {
    this.#state = { ...this.#state, status: "failed", target: null, phase: null, message };
  }

  /**
   * @param {number} index
   * @param {number} attempt
   * @param {string} [message]
   */
  #beginTarget(index, attempt, message) {
    const target = CALIBRATION_TARGETS[index];
    const inset = this.#config.insetRatio;
    this.#targetStartedAt = this.#now();
    this.#samples = [];
    this.#state = {
      ...this.#state,
      index,
      attempt,
      phase: "settle",
      target: {
        id: target.id,
        x: inset + target.x * (1 - 2 * inset),
        y: inset + target.y * (1 - 2 * inset),
      },
      message: message ?? "Look at the dot",
    };
  }
}

/** @returns {CalibrationState} */
function idleState() {
  return {
    status: "idle",
    index: 0,
    total: CALIBRATION_TARGETS.length,
    target: null,
    phase: null,
    attempt: 0,
    message: null,
    results: [],
    warnings: [],
    viewport: null,
  };
}

/** @param {number[]} values */
function sd(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}
