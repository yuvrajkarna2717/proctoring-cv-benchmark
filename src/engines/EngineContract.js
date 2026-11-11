/**
 * Detection engine contract shared by every engine, the worker host, and the main-thread proxy.
 *
 * Engines return observations only. They never decide whether something is a violation; the
 * temporal evaluation layer (Phase 2+) interprets observations over time. This keeps raw model
 * output separable from interpretation, so models can be compared without changing the
 * evaluation logic.
 *
 * @typedef {'uninitialized'|'initializing'|'ready'|'error'|'disposed'} EngineState
 *
 * @typedef {Object} ModelInfo
 * @property {string} id registry id, see docs/MODEL_LICENSES.md; "a+b" for engines that chain
 *   models
 * @property {string} version
 * @property {string} runtime runtime and version, e.g. "@mediapipe/tasks-vision@1.2.2"
 * @property {string=} file model file name
 * @property {string=} sha256 SHA-256 of the model bytes the engine loaded
 * @property {Array<{ id: string, version: string, file: string, sha256?: string }>=} components
 *   one entry per model, for engines that chain models (detector + recognizer)
 *
 * @typedef {Object} EngineInitTimings
 * @property {number=} moduleLoadMs dynamic import of the engine code inside the worker
 * @property {number=} modelFetchMs download or cache read of the model bytes
 * @property {number=} modelInitMs runtime session / graph creation
 * @property {number=} warmupMs first inference, excluded from latency statistics
 * @property {number} totalMs whole initialize() call
 *
 * @typedef {Object} EngineStatus
 * @property {string} kind
 * @property {EngineState} state
 * @property {ModelInfo | null} model
 * @property {string | null} executionProvider e.g. "wasm", "webgpu", "mediapipe-gpu", "js"
 * @property {EngineInitTimings | null} initTimings
 * @property {number} detectCount successful detect() calls
 * @property {number} errorCount failed detect() calls
 * @property {import('../utils/errors.js').SerializedError | null} lastError
 * @property {Record<string, unknown> | null} [details] engine-specific status (JSON-serializable)
 *
 * @typedef {Object} FrameMeta
 * @property {number} frameId increasing id assigned by the frame source
 * @property {number} captureTime epoch ms of capture (best estimate, see captureTimeSource)
 * @property {'captureTime'|'presentationTime'|'callbackTime'} captureTimeSource
 * @property {number | null} mediaTime media timeline position in seconds (used for replay)
 * @property {number} dispatchTime epoch ms at which the main thread posted the frame
 * @property {number} sourceWidth native frame width
 * @property {number} sourceHeight native frame height
 * @property {number} width width of the transferred image (after optional downscaling)
 * @property {number} height height of the transferred image
 * @property {number} maxFrameAgeMs frames older than this are dropped before inference
 * @property {Record<string, unknown> | null=} hints data from other engines that the main
 *   thread passes along (structured-cloneable), e.g. `{ face: { box, at, sourceEngineId } }`
 *   for the image-quality engine
 *
 * @typedef {Object} StageTimings
 * @property {number} preprocessMs
 * @property {number} inferenceMs
 * @property {number} postprocessMs
 * @property {Record<string, number>=} breakdownMs named parts of the detect() call that an
 *   engine measures in addition to the stages, e.g. one model's run in a two-model engine
 *
 * @typedef {Object} Observation
 * @property {string} type e.g. "FRAME_PROBE" (diagnostic), "FACE_COUNT" and "FACE" (face engines)
 * @property {boolean} detected
 * @property {number=} confidence raw model score. Not a calibrated probability unless the
 *   engine documents a calibration.
 * @property {number|string|boolean=} value
 * @property {Record<string, unknown>=} metadata
 *
 * @typedef {Object} DetectionResult
 * @property {string} engine engine instance id (added by the worker host)
 * @property {string} kind
 * @property {number} frameId
 * @property {number} frameCaptureTime epoch ms
 * @property {number} startedAt epoch ms when the engine started processing
 * @property {number} completedAt epoch ms when the engine finished
 * @property {number} processingTimeMs completedAt - startedAt
 * @property {StageTimings} timings
 * @property {Observation[]} observations
 * @property {ModelInfo | null} model
 * @property {string | null} executionProvider
 * @property {unknown=} payload engine-specific raw output (landmarks, boxes) for overlays/replay.
 *   Typed arrays in it are transferred to the main thread, not copied, so engines must allocate
 *   them per result (never a view of WASM memory).
 *
 * @typedef {Object} DetectionEngine
 * @property {() => Promise<void>} initialize
 * @property {(frame: ImageBitmap | VideoFrame, meta: FrameMeta) => Promise<Omit<DetectionResult, 'engine'>>} detect
 *   The caller keeps ownership of `frame` and closes it after detect() settles. Engines must
 *   not retain the frame.
 * @property {(patch: Record<string, unknown>) => Promise<Record<string, unknown>>} configure
 *   Applies a partial engine configuration without reloading the model, or rejects with
 *   code CONFIGURE_UNSUPPORTED.
 * @property {() => Promise<void>} dispose
 * @property {() => EngineStatus} getStatus
 */

import { LabError } from "../utils/errors.js";

export const ENGINE_STATE = Object.freeze({
  UNINITIALIZED: "uninitialized",
  INITIALIZING: "initializing",
  READY: "ready",
  ERROR: "error",
  DISPOSED: "disposed",
});

const STAGES = /** @type {const} */ (["preprocess", "inference", "postprocess"]);

/** @typedef {typeof STAGES[number]} Stage */

/**
 * Accumulates time spent in the preprocess / inference / postprocess stages of one detect()
 * call. Starting a stage ends the previous one, so engines can call start() at each boundary.
 */
export class StageTimer {
  #now;
  /** @type {Record<Stage, number>} */
  #totals = { preprocess: 0, inference: 0, postprocess: 0 };
  /** @type {Stage | null} */
  #current = null;
  #currentStart = 0;
  /** @type {Record<string, number>} */
  #breakdown = {};

  /** @param {() => number} now */
  constructor(now) {
    this.#now = now;
  }

  /**
   * Adds the duration of a named part (for example one model's run) to the breakdown. Parts
   * overlap the stages; they do not change the stage totals.
   *
   * @param {string} part
   * @param {number} durationMs
   */
  record(part, durationMs) {
    this.#breakdown[part] = (this.#breakdown[part] ?? 0) + durationMs;
  }

  /** @param {Stage} stage */
  start(stage) {
    if (!STAGES.includes(stage)) throw new RangeError(`Unknown stage "${stage}"`);
    this.end();
    this.#current = stage;
    this.#currentStart = this.#now();
  }

  end() {
    if (this.#current !== null) {
      this.#totals[this.#current] += this.#now() - this.#currentStart;
      this.#current = null;
    }
  }

  /** @returns {StageTimings} */
  toTimings() {
    this.end();
    return {
      preprocessMs: this.#totals.preprocess,
      inferenceMs: this.#totals.inference,
      postprocessMs: this.#totals.postprocess,
      ...(Object.keys(this.#breakdown).length > 0 ? { breakdownMs: { ...this.#breakdown } } : {}),
    };
  }
}

/**
 * Structural check of an engine result at the worker boundary. Cheap enough for every frame;
 * it does not inspect `payload`, which engines validate themselves.
 *
 * @param {unknown} result
 * @throws {LabError} code INVALID_RESULT
 */
export function validateDetectionResult(result) {
  const problems = [];
  if (result === null || typeof result !== "object") {
    problems.push("result is not an object");
  } else {
    const r = /** @type {Record<string, unknown>} */ (result);
    if (typeof r.kind !== "string") problems.push("kind must be a string");
    for (const key of ["frameId", "startedAt", "completedAt", "processingTimeMs"]) {
      if (!Number.isFinite(r[key])) problems.push(`${key} must be a finite number`);
    }
    const timings = /** @type {Record<string, unknown> | undefined} */ (r.timings);
    if (!timings || typeof timings !== "object") {
      problems.push("timings must be an object");
    } else {
      for (const key of ["preprocessMs", "inferenceMs", "postprocessMs"]) {
        if (!Number.isFinite(timings[key])) problems.push(`timings.${key} must be a finite number`);
      }
      if (timings.breakdownMs !== undefined) {
        const parts = timings.breakdownMs;
        if (!parts || typeof parts !== "object") {
          problems.push("timings.breakdownMs must be an object");
        } else {
          for (const [part, value] of Object.entries(parts)) {
            if (!Number.isFinite(value))
              problems.push(`timings.breakdownMs.${part} must be a finite number`);
          }
        }
      }
    }
    if (!Array.isArray(r.observations)) {
      problems.push("observations must be an array");
    } else {
      r.observations.forEach((observation, index) => {
        if (!observation || typeof observation.type !== "string") {
          problems.push(`observations[${index}].type must be a string`);
        }
        if (typeof observation?.detected !== "boolean") {
          problems.push(`observations[${index}].detected must be a boolean`);
        }
        if (observation?.confidence !== undefined && !Number.isFinite(observation.confidence)) {
          problems.push(`observations[${index}].confidence must be a finite number`);
        }
      });
    }
  }
  if (problems.length > 0) {
    throw new LabError(`Engine returned an invalid result: ${problems.join("; ")}`, {
      code: "INVALID_RESULT",
      details: problems,
    });
  }
}

/**
 * Releases an ImageBitmap or VideoFrame. Safe to call on detached, already closed, or missing
 * frames.
 *
 * @param {unknown} frame
 */
export function closeFrame(frame) {
  if (frame && typeof (/** @type {{ close?: unknown }} */ (frame).close) === "function") {
    try {
      /** @type {{ close: () => void }} */ (frame).close();
    } catch {
      // Closing a detached or already-closed frame is a no-op in every browser we target;
      // some implementations throw instead. Nothing else to release.
    }
  }
}
