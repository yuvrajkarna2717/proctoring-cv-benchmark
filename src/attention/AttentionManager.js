import { validateAttentionConfig } from "../config/schema.js";
import { AttentionCalibration } from "./attentionCalibration.js";
import {
  AttentionClassifier,
  BaselineLearner,
  gazeLimits,
  readAttentionFrame,
} from "./attentionModel.js";

/**
 * Main-thread attention layer. Consumes face-landmarker results while detection runs, keeps
 * the person's baseline (calibration, or a baseline learned at the start), classifies every
 * frame, and returns samples for the violation engine. Engines only measure; the decision
 * "looking away" is made here, against this person's own screen area.
 *
 * Nothing here is stored beyond the page: the profile holds angles only and is part of
 * exported reports.
 *
 * @typedef {import('./attentionModel.js').AttentionSample} AttentionSample
 * @typedef {import('./attentionModel.js').AttentionProfile} AttentionProfile
 *
 * @typedef {{ type: 'log', level: 'info' | 'warn' | 'error', message: string }
 *   | { type: 'profile-changed', profile: AttentionProfile | null }
 *   | { type: 'calibration', state: import('./attentionCalibration.js').CalibrationState }} AttentionEvent
 */
export class AttentionManager {
  /** @type {import('../config/schema.js').AttentionConfig} */
  #config;
  #classifier;
  #learner;
  #calibration;
  /** @type {AttentionProfile | null} */
  #profile = null;
  /** @type {AttentionSample | null} */
  #last = null;
  /** @type {Array<{ at: number, yawDeg: number, pitchDeg: number, state: string }>} */
  #trail = [];
  #stats = emptyStats();
  /** @type {number | null} first closed frame of the current closure */
  #closedSince = null;
  /** @type {number | null} */
  #lastClosedAt = null;
  /** @type {Set<(event: AttentionEvent) => void>} */
  #listeners = new Set();

  /**
   * @param {{ config: import('../config/schema.js').AttentionConfig, now?: () => number }} options
   */
  constructor({ config, now = Date.now }) {
    this.#config = validateAttentionConfig(structuredClone(config));
    this.#classifier = new AttentionClassifier(this.#config);
    this.#learner = new BaselineLearner(this.#config);
    this.#calibration = new AttentionCalibration({ config: this.#config, now });
  }

  get sourceEngineId() {
    return this.#config.sourceEngineId;
  }

  get config() {
    return structuredClone(this.#config);
  }

  /** @param {(event: AttentionEvent) => void} listener */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Classifies one face-landmarker result. Also feeds a running calibration and, without a
   * calibration, the baseline learner.
   *
   * @param {Pick<import('../engines/EngineContract.js').DetectionResult, 'engine' | 'frameCaptureTime' | 'observations'>} result
   * @returns {AttentionSample | null} null for other engines, while calibrating, or without
   *   attention observations
   */
  observe(result) {
    if (result.engine !== this.#config.sourceEngineId) return null;
    const frame = readAttentionFrame(result);
    if (!frame) return null;
    if (this.#calibration.running) {
      this.#calibration.observe(frame);
      this.#afterCalibrationStep();
      // The person follows a dot during calibration; those frames are not evaluated.
      return null;
    }
    if (!this.#profile) {
      const learned = this.#learner.observe(frame);
      if (learned) {
        this.#setProfile(learned);
        this.#emit({
          type: "log",
          level: "info",
          message: `Baseline learned from ${learned.samples} frames (no calibration): gaze centre ${fmt(learned.gazeCenter.yawDeg)}° / ${fmt(learned.gazeCenter.pitchDeg)}°, default screen size`,
        });
      }
    }
    const sample = this.#classifier.classify(frame, this.#profile);
    this.#record(sample);
    return sample;
  }

  /**
   * Starts the guided calibration. Detection must be running (checked by the caller).
   *
   * @param {{ width: number, height: number, fullscreen: boolean }} viewport
   */
  startCalibration(viewport) {
    this.#calibration.setConfig(this.#config);
    this.#calibration.start(viewport);
    this.#emit({ type: "log", level: "info", message: "Attention calibration started" });
    this.#emit({ type: "calibration", state: this.#calibration.state });
  }

  cancelCalibration() {
    if (!this.#calibration.running) return;
    this.#calibration.cancel();
    this.#emit({ type: "log", level: "info", message: "Attention calibration cancelled" });
    this.#emit({ type: "calibration", state: this.#calibration.state });
  }

  /** Drops the calibration or learned baseline; a new baseline is learned from now on. */
  resetBaseline() {
    this.#learner.reset();
    this.#setProfile(null);
    this.#emit({ type: "log", level: "info", message: "Attention baseline reset" });
  }

  /**
   * Called when detection starts. A calibration is kept (same person, same setup); a learned
   * baseline is learned again, since the camera or seat may have changed.
   */
  startSession() {
    this.#classifier.reset();
    this.#learner.reset();
    this.#stats = emptyStats();
    this.#trail = [];
    this.#last = null;
    this.#closedSince = null;
    this.#lastClosedAt = null;
    if (this.#profile?.source === "learned") this.#setProfile(null);
  }

  /**
   * Applies a partial configuration (for example a preset's tolerances). Nested objects are
   * merged one level deep.
   *
   * @param {Record<string, any>} patch
   */
  updateConfig(patch) {
    const merged = { ...this.#config };
    for (const [key, value] of Object.entries(patch)) {
      const current = /** @type {Record<string, any>} */ (merged)[key];
      /** @type {Record<string, any>} */ (merged)[key] =
        value && typeof value === "object" && !Array.isArray(value) && current
          ? { ...current, ...value }
          : value;
    }
    this.#config = validateAttentionConfig(merged);
    this.#classifier.setConfig(this.#config);
    this.#learner.setConfig(this.#config);
    return this.config;
  }

  /** Advances a running calibration by the clock (call periodically). */
  tick() {
    if (!this.#calibration.running) return;
    this.#calibration.tick();
    this.#afterCalibrationStep();
  }

  getSnapshot() {
    const profile = this.#profile;
    return {
      sourceEngineId: this.#config.sourceEngineId,
      config: this.config,
      profile: profile ? structuredClone(profile) : null,
      limits: profile ? gazeLimits(profile, this.#config) : null,
      learning: profile ? null : this.#learner.progress,
      calibration: this.#calibration.state,
      last: this.#last ? structuredClone(this.#last) : null,
      trail: [...this.#trail],
      stats: { ...this.#stats, gaze: { ...this.#stats.gaze }, eyes: { ...this.#stats.eyes } },
    };
  }

  #afterCalibrationStep() {
    const state = this.#calibration.state;
    const profile = this.#calibration.profile;
    if (state.status === "running") {
      this.#emit({ type: "calibration", state });
      return;
    }
    if (state.status === "done" && profile && profile !== this.#profile) {
      this.#classifier.reset();
      this.#setProfile(profile);
      const { screen } = profile;
      this.#emit({
        type: "log",
        level: "info",
        message: `Attention calibrated: screen ${fmt(screen.leftDeg)}° left, ${fmt(screen.rightDeg)}° right, ${fmt(screen.upDeg)}° up, ${fmt(screen.downDeg)}° down of the centre`,
      });
      for (const warning of state.warnings) {
        this.#emit({ type: "log", level: "warn", message: `Calibration: ${warning}` });
      }
    } else if (state.status === "failed") {
      this.#emit({ type: "log", level: "warn", message: `Calibration failed: ${state.message}` });
    }
    this.#emit({ type: "calibration", state });
  }

  /** @param {AttentionProfile | null} profile */
  #setProfile(profile) {
    this.#profile = profile;
    this.#classifier.reset();
    this.#emit({ type: "profile-changed", profile });
  }

  /** @param {AttentionSample} sample */
  #record(sample) {
    this.#last = sample;
    const stats = this.#stats;
    stats.frames += 1;
    stats.gaze[sample.gaze.state] += 1;
    stats.eyes[sample.eyes.state] += 1;
    if (sample.gaze.yawDeg !== null && sample.gaze.pitchDeg !== null) {
      this.#trail.push({
        at: sample.at,
        yawDeg: sample.gaze.yawDeg,
        pitchDeg: sample.gaze.pitchDeg,
        state: sample.gaze.state,
      });
      if (this.#trail.length > this.#config.trailSize) this.#trail.shift();
    }
    // Blinks: closures shorter than blinkMaxMs. At 5 FPS most blinks (100–400 ms) fall between
    // frames, so this count is a lower bound.
    if (sample.eyes.state === "closed") {
      if (this.#closedSince === null) this.#closedSince = sample.at;
      this.#lastClosedAt = sample.at;
    } else if (sample.eyes.state === "open" && this.#closedSince !== null) {
      const duration = /** @type {number} */ (this.#lastClosedAt) - this.#closedSince;
      if (duration <= this.#config.eyes.blinkMaxMs) stats.blinks += 1;
      else stats.longClosures += 1;
      this.#closedSince = null;
      this.#lastClosedAt = null;
    }
    if (stats.firstAt === null) stats.firstAt = sample.at;
    stats.lastAt = sample.at;
  }

  /** @param {AttentionEvent} event */
  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Attention listener failed", error);
      }
    }
  }
}

function emptyStats() {
  return {
    frames: 0,
    gaze: { on: 0, away: 0, undecided: 0 },
    eyes: { open: 0, closed: 0, undecided: 0 },
    blinks: 0,
    longClosures: 0,
    /** @type {number | null} */
    firstAt: null,
    /** @type {number | null} */
    lastAt: null,
  };
}

/** @param {number} value */
function fmt(value) {
  return value.toFixed(1);
}
