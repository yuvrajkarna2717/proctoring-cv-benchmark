import { validateQualityGate } from "../config/schema.js";
import { LabError, describeError } from "../utils/errors.js";
import {
  CALIBRATION_PROTOCOL,
  describeComposition,
  groupCaptures,
  scoreCaptures,
  verificationMetrics,
} from "./calibration.js";
import { dot, meanTemplate, sampleAgreement } from "./embeddings.js";
import { evaluateGate, mostFrequentFailure } from "./qualityGate.js";

const REFERENCE_VERSION = 1;
const RECENT_GATES = 50;
const MAX_PERSON_LABEL = 40;

/**
 * @typedef {import('./IdentityStore.js').ReferenceRecord} ReferenceRecord
 * @typedef {import('./calibration.js').CalibrationSample} CalibrationSample
 * @typedef {{ id: string, sha256: string | null }} ModelRef
 *
 * @typedef {Object} EmbeddedFrameData one face-verifier result, as the identity layer sees it
 * @property {number} at frame capture time, epoch ms
 * @property {number} faceCount
 * @property {'face' | 'center-crop' | null} source
 * @property {Float32Array | null} vector
 * @property {Record<string, any>} quality
 * @property {ModelRef | null} recognizer
 * @property {ModelRef | null} detector
 *
 * @typedef {'idle' | 'collecting' | 'saving' | 'done' | 'failed' | 'cancelled'} SessionStatus
 *
 * @typedef {Object} CollectSession enrollment or calibration capture in progress
 * @property {SessionStatus} status
 * @property {number} required
 * @property {number | null} startedAt
 * @property {Array<{ vector: Float32Array, quality: Record<string, any>, at: number }>} accepted
 * @property {number} framesOffered
 * @property {number} framesRejected frames that failed the gate
 * @property {number} framesSkipped frames inside minIntervalMs of the previous accepted one
 * @property {number | null} lastAcceptedAt
 * @property {import('./qualityGate.js').GateResult | null} lastGate
 * @property {import('./qualityGate.js').GateResult[]} recentGates
 * @property {ModelRef | null} recognizer
 * @property {ModelRef | null} detector
 * @property {string | null} failure
 * @property {Record<string, unknown> | null} result
 * @property {{ captureId: string, person: string, conditions: Record<string, string>,
 *   camera: { label: string, width: number, height: number } | null } | null} capture
 *
 * @typedef {'compared' | 'no-face' | 'gate-failed' | 'model-mismatch'} ComparisonStatus
 * @typedef {{ at: number, similarity: number | null, status: ComparisonStatus }} Comparison
 *
 * @typedef {{ type: 'log', level: 'info' | 'warn' | 'error', message: string }
 *   | { type: 'reference-changed', reason: 'enrolled' | 'replaced' | 'deleted' }
 *   | { type: 'changed' }} IdentityEvent
 */

/** @returns {CollectSession} */
function idleSession() {
  return {
    status: "idle",
    required: 0,
    startedAt: null,
    accepted: [],
    framesOffered: 0,
    framesRejected: 0,
    framesSkipped: 0,
    lastAcceptedAt: null,
    lastGate: null,
    recentGates: [],
    recognizer: null,
    detector: null,
    failure: null,
    result: null,
    capture: null,
  };
}

/**
 * @param {ModelRef | null} a
 * @param {ModelRef | null} b
 */
function sameModel(a, b) {
  return Boolean(a && b && a.id === b.id && (!a.sha256 || !b.sha256 || a.sha256 === b.sha256));
}

/**
 * Reads what the identity layer needs from a face-verifier result. Returns null for results of
 * other engines.
 *
 * @param {import('../engines/EngineContract.js').DetectionResult} result
 * @returns {EmbeddedFrameData | null}
 */
export function readEmbeddedFrame(result) {
  const payload =
    /** @type {import('../engines/verification/FaceVerificationEngine.js').FaceVerifierPayload | undefined} */ (
      result.payload
    );
  if (!payload || payload.format !== "face-verifier") return null;
  const faceCount = Number(result.observations.find((o) => o.type === "FACE_COUNT")?.value ?? 0);
  const observation = result.observations.find((o) => o.type === "FACE_EMBEDDING");
  const embedding = payload.embedding;
  const components = result.model?.components ?? [];
  /** @param {string | undefined} id */
  const ref = (id) => {
    const component = components.find((c) => c.id === id);
    return id ? { id, sha256: component?.sha256 ?? null } : null;
  };
  return {
    at: result.frameCaptureTime,
    faceCount,
    source: embedding?.source ?? null,
    vector: embedding?.vector ?? null,
    quality: /** @type {Record<string, any>} */ (observation?.metadata?.quality ?? {}),
    recognizer: embedding ? ref(embedding.recognizer) : null,
    detector: components[0] ? ref(components[0].id) : null,
  };
}

/**
 * Main-thread identity layer: enrollment of one reference template, comparison of live
 * embeddings with it, and calibration captures. Embeddings stay inside this object and the
 * store; snapshots, logs, and reports contain only metadata, similarities, and rates.
 */
export class IdentityManager {
  /** @type {import('../config/schema.js').IdentityConfig} */
  #config;
  #store;
  #now;
  #getCamera;
  /** @type {Set<(event: IdentityEvent) => void>} */
  #listeners = new Set();
  /** @type {ReferenceRecord | null} */
  #reference = null;
  /** @type {'loading' | 'ready' | 'error'} */
  #loadState = "loading";
  /** @type {string | null} */
  #storageError = null;
  /** @type {{ ok: boolean, ms: number, error?: string, at: number } | null} */
  #selfTest = null;
  #enrollment = idleSession();
  #capture = idleSession();
  /** @type {Comparison[]} */
  #comparisons = [];
  /** @type {(Comparison & { failedChecks?: string[] }) | null} */
  #lastComparison = null;
  #comparisonCounts = { compared: 0, "no-face": 0, "gate-failed": 0, "model-mismatch": 0 };
  /** @type {CalibrationSample[]} */
  #samples = [];
  #revision = 0;
  /** @type {{ key: string, value: unknown } | null} */
  #calibrationCache = null;
  /** @type {{ revision: number, value: ReturnType<IdentityManager['calibrationCaptures']> } | null} */
  #capturesCache = null;

  /**
   * @param {Object} options
   * @param {import('../config/schema.js').IdentityConfig} options.config validated
   * @param {import('./IdentityStore.js').IdentityStore} options.store
   * @param {() => number} options.now epoch ms
   * @param {() => ({ label: string, width: number, height: number } | null)} [options.getCamera]
   */
  constructor({ config, store, now, getCamera = () => null }) {
    this.#config = structuredClone(config);
    this.#store = store;
    this.#now = now;
    this.#getCamera = getCamera;
  }

  get sourceEngineId() {
    return this.#config.sourceEngineId;
  }

  get hasReference() {
    return this.#reference !== null;
  }

  /**
   * @param {(event: IdentityEvent) => void} listener
   * @returns {() => void}
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Reads the stored reference and calibration samples. */
  async load() {
    try {
      this.#reference = await this.#store.getReference();
      this.#samples = await this.#store.listCalibrationSamples();
      this.#revision += 1;
      this.#loadState = "ready";
      this.#storageError = null;
      if (this.#reference) {
        this.#log(
          "info",
          `Stored reference loaded (${this.#reference.samples} samples, ${this.#reference.recognizer.id}, enrolled ${this.#reference.createdAt})`,
        );
      }
    } catch (error) {
      this.#loadState = "error";
      this.#storageError = describeError(error);
      this.#log("error", `Identity storage unavailable: ${this.#storageError}`);
    }
    this.#emit({ type: "changed" });
  }

  /**
   * Feeds one face-verifier result. Returns the similarity sample for the FACE_MISMATCH rule
   * when the frame was compared with the reference.
   *
   * @param {import('../engines/EngineContract.js').DetectionResult} result
   * @returns {{ at: number, similarity: number } | null}
   */
  observe(result) {
    const frame = readEmbeddedFrame(result);
    if (!frame) return null;
    const sample = this.#compare(frame);
    this.#feed(
      this.#enrollment,
      frame,
      this.#config.enrollment.gate,
      this.#config.enrollment.minIntervalMs,
    );
    this.#feed(
      this.#capture,
      frame,
      this.#config.verification.gate,
      this.#config.calibration.minIntervalMs,
    );
    return sample;
  }

  /**
   * Ends sessions that ran out of time; call periodically.
   * @param {number} now epoch ms
   */
  tick(now) {
    for (const [session, timeoutMs, label] of /** @type {const} */ ([
      [this.#enrollment, this.#config.enrollment.timeoutMs, "Enrollment"],
      [this.#capture, this.#config.calibration.timeoutMs, "Calibration capture"],
    ])) {
      if (session.status !== "collecting" || session.startedAt === null) continue;
      if (now - session.startedAt <= timeoutMs) continue;
      const common = mostFrequentFailure(session.recentGates);
      this.#fail(
        session,
        `${label} timed out after ${Math.round(timeoutMs / 1000)} s with ${session.accepted.length} of ${session.required} samples` +
          (session.framesOffered === 0
            ? "; no face-verifier results arrived (is detection running?)"
            : common
              ? `; most frequent failed check: ${common.label}`
              : ""),
      );
    }
  }

  // ---- enrollment -------------------------------------------------------------------------

  startEnrollment() {
    this.#assertIdle();
    this.#enrollment = {
      ...idleSession(),
      status: "collecting",
      required: this.#config.enrollment.samples,
      startedAt: this.#now(),
    };
    this.#log(
      "info",
      `Enrollment started: ${this.#enrollment.required} samples that pass the enrollment gate`,
    );
    this.#emit({ type: "changed" });
  }

  cancelEnrollment() {
    if (this.#enrollment.status !== "collecting") return;
    this.#enrollment = { ...this.#enrollment, status: "cancelled", accepted: [] };
    this.#log("info", "Enrollment cancelled");
    this.#emit({ type: "changed" });
  }

  async deleteReference() {
    await this.#store.deleteReference();
    const had = this.#reference !== null;
    this.#reference = null;
    this.clearComparisons();
    if (had) {
      this.#log("info", "Reference deleted from this browser");
      this.#emit({ type: "reference-changed", reason: "deleted" });
    }
    this.#emit({ type: "changed" });
  }

  // ---- calibration --------------------------------------------------------------------------

  /**
   * @param {{ person: string, conditions?: Record<string, string> }} options
   */
  startCalibrationCapture({ person, conditions = {} }) {
    this.#assertIdle();
    const label = String(person ?? "").trim();
    if (!label || label.length > MAX_PERSON_LABEL) {
      throw new LabError(`Enter a person label of 1–${MAX_PERSON_LABEL} characters`, {
        code: "INVALID_INPUT",
      });
    }
    const cleanConditions = Object.fromEntries(
      Object.entries(conditions)
        .map(([key, value]) => [
          key,
          String(value ?? "")
            .trim()
            .slice(0, MAX_PERSON_LABEL),
        ])
        .filter(([, value]) => value),
    );
    this.#capture = {
      ...idleSession(),
      status: "collecting",
      required: this.#config.calibration.samplesPerCapture,
      startedAt: this.#now(),
      capture: {
        captureId: `cap-${crypto.randomUUID()}`,
        person: label,
        conditions: cleanConditions,
        camera: this.#getCamera(),
      },
    };
    this.#log("info", `Calibration capture started for "${label}"`);
    this.#emit({ type: "changed" });
  }

  cancelCalibrationCapture() {
    if (this.#capture.status !== "collecting") return;
    this.#capture = { ...this.#capture, status: "cancelled", accepted: [] };
    this.#log("info", "Calibration capture cancelled");
    this.#emit({ type: "changed" });
  }

  /** @param {string} captureId */
  async deleteCalibrationCapture(captureId) {
    await this.#store.deleteCalibrationCapture(captureId);
    this.#samples = this.#samples.filter((sample) => sample.captureId !== captureId);
    this.#revision += 1;
    this.#emit({ type: "changed" });
  }

  async clearCalibration() {
    await this.#store.clearCalibration();
    this.#samples = [];
    this.#revision += 1;
    this.#log("info", "Calibration samples deleted from this browser");
    this.#emit({ type: "changed" });
  }

  /** Deletes the reference, every calibration sample, and the database itself. */
  async deleteAll() {
    this.cancelEnrollment();
    this.cancelCalibrationCapture();
    const had = this.#reference !== null;
    await this.#store.destroy();
    this.#reference = null;
    this.#samples = [];
    this.#revision += 1;
    this.clearComparisons();
    this.#log(
      "info",
      "All identity data deleted from this browser (reference and calibration samples)",
    );
    if (had) this.#emit({ type: "reference-changed", reason: "deleted" });
    this.#emit({ type: "changed" });
  }

  async testStorage() {
    const result = await this.#store.selfTest();
    this.#selfTest = { ...result, at: this.#now() };
    this.#emit({ type: "changed" });
    return this.#selfTest;
  }

  /**
   * @param {'enrollment' | 'verification'} kind
   * @param {Record<string, unknown>} patch
   */
  updateGate(kind, patch) {
    const section = kind === "enrollment" ? this.#config.enrollment : this.#config.verification;
    section.gate = validateQualityGate({ ...section.gate, ...patch }, `${kind} quality gate`);
    this.#emit({ type: "changed" });
    return { ...section.gate };
  }

  clearComparisons() {
    this.#comparisons = [];
    this.#lastComparison = null;
    this.#comparisonCounts = { compared: 0, "no-face": 0, "gate-failed": 0, "model-mismatch": 0 };
  }

  /** Captures without embeddings, newest first. */
  calibrationCaptures() {
    if (this.#capturesCache?.revision === this.#revision) return this.#capturesCache.value;
    const value = groupCaptures(this.#samples)
      .map((capture) => ({
        id: capture.id,
        person: capture.person,
        conditions: capture.conditions,
        camera: capture.camera,
        capturedAt: capture.capturedAt,
        samples: capture.samples.length,
        recognizer: capture.samples[0]?.recognizer ?? null,
        captureStats: capture.captureStats,
      }))
      .sort((a, b) => b.capturedAt - a.capturedAt);
    this.#capturesCache = { revision: this.#revision, value };
    return value;
  }

  /**
   * FAR/FRR/EER/ROC for the stored captures of one recognizer model, at `threshold`.
   *
   * @param {number} threshold
   * @param {string} recognizerId
   */
  calibrationResults(threshold, recognizerId) {
    const key = `${this.#revision}|${threshold}|${recognizerId}`;
    if (this.#calibrationCache?.key === key) {
      return /** @type {ReturnType<IdentityManager['computeCalibration']>} */ (
        this.#calibrationCache.value
      );
    }
    const value = this.computeCalibration(threshold, recognizerId);
    this.#calibrationCache = { key, value };
    return value;
  }

  /**
   * @param {number} threshold
   * @param {string} recognizerId
   */
  computeCalibration(threshold, recognizerId) {
    const samples = this.#samples.filter((sample) => sample.recognizer.id === recognizerId);
    const excluded = this.#samples.length - samples.length;
    const captures = groupCaptures(samples);
    const composition = describeComposition(captures);
    const base = {
      recognizer: recognizerId,
      protocol: CALIBRATION_PROTOCOL,
      composition,
      excludedOtherModel: excluded,
    };
    if (captures.length < 2) {
      return { ...base, ready: false, reason: "At least two captures are needed", metrics: null };
    }
    const { genuine, impostor } = scoreCaptures(captures);
    const metrics = verificationMetrics(genuine, impostor, threshold);
    /** @type {string | null} */
    let reason = null;
    if (genuine.length === 0) reason = "No genuine pairs: capture at least one person twice";
    else if (impostor.length === 0)
      reason = "No impostor pairs: capture at least two different persons";
    return { ...base, ready: reason === null, reason, metrics };
  }

  /**
   * Export of a calibration run: composition, per-capture metadata, all scored pairs, and the
   * metrics. No embeddings.
   *
   * @param {number} threshold
   * @param {string} recognizerId
   */
  exportCalibration(threshold, recognizerId) {
    const samples = this.#samples.filter((sample) => sample.recognizer.id === recognizerId);
    const captures = groupCaptures(samples);
    const scored = captures.length >= 2 ? scoreCaptures(captures) : { pairs: [] };
    return {
      ...this.computeCalibration(threshold, recognizerId),
      captures: captures.map((capture) => ({
        id: capture.id,
        person: capture.person,
        conditions: capture.conditions,
        camera: capture.camera,
        capturedAt: new Date(capture.capturedAt).toISOString(),
        captureStats: capture.captureStats,
        samples: capture.samples.map((sample) => ({ id: sample.id, quality: sample.quality })),
      })),
      pairs: scored.pairs,
    };
  }

  getSnapshot() {
    const reference = this.#reference;
    const recent = this.#comparisons.slice(-this.#config.verification.historySize);
    const similarities = recent
      .map((comparison) => comparison.similarity)
      .filter((value) => value !== null);
    return {
      sourceEngineId: this.#config.sourceEngineId,
      storage: {
        kind: this.#store.kind,
        loadState: this.#loadState,
        error: this.#storageError,
        selfTest: this.#selfTest,
      },
      config: structuredClone(this.#config),
      reference: reference
        ? {
            createdAt: reference.createdAt,
            recognizer: reference.recognizer,
            detector: reference.detector,
            samples: reference.samples,
            sampleSimilarity: reference.sampleSimilarity,
            quality: reference.quality,
            camera: reference.camera,
          }
        : null,
      enrollment: sessionSnapshot(this.#enrollment),
      calibrationCapture: sessionSnapshot(this.#capture),
      verification: {
        last: this.#lastComparison,
        recent,
        counts: { ...this.#comparisonCounts },
        recentSimilarity:
          similarities.length > 0
            ? {
                n: similarities.length,
                min: Math.min(.../** @type {number[]} */ (similarities)),
                mean:
                  /** @type {number[]} */ (similarities).reduce((sum, value) => sum + value, 0) /
                  similarities.length,
                max: Math.max(.../** @type {number[]} */ (similarities)),
              }
            : null,
      },
      calibration: {
        sampleCount: this.#samples.length,
        captures: this.calibrationCaptures(),
      },
    };
  }

  // ---- internals ----------------------------------------------------------------------------

  /** @param {EmbeddedFrameData} frame */
  #compare(frame) {
    const reference = this.#reference;
    if (!reference) return null;
    const gate = evaluateGate(frame, this.#config.verification.gate);
    /** @type {Comparison & { failedChecks?: string[] }} */
    let entry;
    if (frame.source !== "face" || !frame.vector) {
      entry = { at: frame.at, similarity: null, status: "no-face" };
    } else if (!sameModel(frame.recognizer, reference.recognizer)) {
      entry = { at: frame.at, similarity: null, status: "model-mismatch" };
    } else if (!gate.passed) {
      entry = {
        at: frame.at,
        similarity: null,
        status: "gate-failed",
        failedChecks: gate.checks.filter((check) => !check.passed).map((check) => check.label),
      };
    } else {
      entry = {
        at: frame.at,
        similarity: dot(frame.vector, reference.embedding),
        status: "compared",
      };
    }
    this.#comparisonCounts[entry.status] += 1;
    this.#comparisons.push({ at: entry.at, similarity: entry.similarity, status: entry.status });
    const limit = this.#config.verification.historySize;
    if (this.#comparisons.length > limit * 2) this.#comparisons = this.#comparisons.slice(-limit);
    this.#lastComparison = entry;
    return entry.status === "compared"
      ? { at: entry.at, similarity: /** @type {number} */ (entry.similarity) }
      : null;
  }

  /**
   * @param {CollectSession} session
   * @param {EmbeddedFrameData} frame
   * @param {import('../config/schema.js').QualityGate} gateConfig
   * @param {number} minIntervalMs
   */
  #feed(session, frame, gateConfig, minIntervalMs) {
    if (session.status !== "collecting") return;
    session.framesOffered += 1;
    if (session.lastAcceptedAt !== null && frame.at - session.lastAcceptedAt < minIntervalMs) {
      session.framesSkipped += 1;
      return;
    }
    const gate = evaluateGate(frame, gateConfig);
    if (gate.passed && session.recognizer && !sameModel(session.recognizer, frame.recognizer)) {
      gate.passed = false;
      gate.checks.push({
        id: "model",
        label: "Same recognizer model as the earlier samples",
        value: frame.recognizer?.id ?? null,
        limit: session.recognizer.id,
        passed: false,
      });
    }
    session.lastGate = gate;
    session.recentGates.push(gate);
    if (session.recentGates.length > RECENT_GATES) session.recentGates.shift();
    if (!gate.passed) {
      session.framesRejected += 1;
      return;
    }
    session.recognizer ??= frame.recognizer;
    session.detector ??= frame.detector;
    session.accepted.push({
      vector: Float32Array.from(/** @type {Float32Array} */ (frame.vector)),
      quality: frame.quality,
      at: frame.at,
    });
    session.lastAcceptedAt = frame.at;
    if (session.accepted.length >= session.required) {
      session.status = "saving";
      void (session === this.#enrollment ? this.#finishEnrollment() : this.#finishCapture());
    }
    this.#emit({ type: "changed" });
  }

  async #finishEnrollment() {
    const session = this.#enrollment;
    try {
      const vectors = session.accepted.map((sample) => sample.vector);
      const template = meanTemplate(vectors);
      const agreement = sampleAgreement(vectors, template);
      const minimum = this.#config.enrollment.minSampleSimilarity;
      if (agreement.min < minimum) {
        this.#fail(
          session,
          `Enrollment refused: the samples disagree (lowest similarity to their mean ${agreement.min.toFixed(3)}, required ${minimum}). Was another person in view? Try again.`,
        );
        return;
      }
      /** @type {ReferenceRecord} */
      const record = {
        version: REFERENCE_VERSION,
        createdAt: new Date(this.#now()).toISOString(),
        recognizer: /** @type {ModelRef} */ (session.recognizer),
        detector: session.detector,
        embedding: template,
        samples: vectors.length,
        sampleSimilarity: agreement,
        quality: meanQuality(session.accepted.map((sample) => sample.quality)),
        camera: this.#getCamera(),
      };
      await this.#store.putReference(record);
      const replaced = this.#reference !== null;
      this.#reference = record;
      this.clearComparisons();
      this.#enrollment = {
        ...session,
        status: "done",
        accepted: [],
        result: { samples: vectors.length, sampleSimilarity: agreement, replaced },
      };
      this.#log(
        "info",
        `Reference ${replaced ? "replaced" : "enrolled"}: ${vectors.length} samples, similarity to their mean ${agreement.min.toFixed(3)}–${agreement.mean.toFixed(3)} (min–mean), stored in this browser`,
      );
      this.#emit({ type: "reference-changed", reason: replaced ? "replaced" : "enrolled" });
    } catch (error) {
      this.#fail(session, `Enrollment failed: ${describeError(error)}`);
    }
    this.#emit({ type: "changed" });
  }

  async #finishCapture() {
    const session = this.#capture;
    const info = /** @type {NonNullable<CollectSession['capture']>} */ (session.capture);
    try {
      const captureStats = {
        framesOffered: session.framesOffered,
        framesRejected: session.framesRejected,
      };
      /** @type {CalibrationSample[]} */
      const samples = session.accepted.map((sample, index) => ({
        id: `${info.captureId}-${index}`,
        captureId: info.captureId,
        person: info.person,
        conditions: info.conditions,
        camera: info.camera,
        capturedAt: sample.at,
        recognizer: /** @type {ModelRef} */ (session.recognizer),
        embedding: sample.vector,
        quality: sample.quality,
        captureStats,
      }));
      await this.#store.addCalibrationSamples(samples);
      this.#samples = [...this.#samples, ...samples];
      this.#revision += 1;
      this.#capture = {
        ...session,
        status: "done",
        accepted: [],
        result: { captureId: info.captureId, person: info.person, samples: samples.length },
      };
      this.#log("info", `Calibration capture saved: "${info.person}", ${samples.length} samples`);
    } catch (error) {
      this.#fail(session, `Calibration capture failed: ${describeError(error)}`);
    }
    this.#emit({ type: "changed" });
  }

  /**
   * @param {CollectSession} session
   * @param {string} message
   */
  #fail(session, message) {
    const failed = {
      ...session,
      status: /** @type {SessionStatus} */ ("failed"),
      accepted: [],
      failure: message,
    };
    if (session === this.#enrollment) this.#enrollment = failed;
    else this.#capture = failed;
    this.#log("warn", message);
    this.#emit({ type: "changed" });
  }

  #assertIdle() {
    if (this.#enrollment.status === "collecting" || this.#enrollment.status === "saving") {
      throw new LabError("An enrollment is in progress", { code: "BUSY" });
    }
    if (this.#capture.status === "collecting" || this.#capture.status === "saving") {
      throw new LabError("A calibration capture is in progress", { code: "BUSY" });
    }
  }

  /**
   * @param {'info' | 'warn' | 'error'} level
   * @param {string} message
   */
  #log(level, message) {
    this.#emit({ type: "log", level, message });
  }

  /** @param {IdentityEvent} event */
  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Identity listener failed", error);
      }
    }
  }
}

/** @param {CollectSession} session */
function sessionSnapshot(session) {
  const common = mostFrequentFailure(session.recentGates);
  return {
    status: session.status,
    required: session.required,
    accepted: session.status === "done" ? session.required : session.accepted.length,
    startedAt: session.startedAt,
    framesOffered: session.framesOffered,
    framesRejected: session.framesRejected,
    framesSkipped: session.framesSkipped,
    lastGate: session.lastGate,
    mostFrequentFailure: common,
    failure: session.failure,
    result: session.result,
    capture: session.capture
      ? { person: session.capture.person, conditions: session.capture.conditions }
      : null,
  };
}

/**
 * Mean of each numeric quality measurement over samples.
 *
 * @param {Record<string, unknown>[]} qualities
 */
function meanQuality(qualities) {
  /** @type {Record<string, number[]>} */
  const values = {};
  for (const quality of qualities) {
    for (const [key, value] of Object.entries(quality)) {
      if (typeof value === "number" && Number.isFinite(value)) (values[key] ??= []).push(value);
    }
  }
  return Object.fromEntries(
    Object.entries(values).map(([key, list]) => [
      key,
      Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 1000) / 1000,
    ]),
  );
}
