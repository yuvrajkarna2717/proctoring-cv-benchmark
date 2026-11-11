import { epochNow } from "../utils/clock.js";
import { EngineBusyError, EngineStateError, LabError, serializeError } from "../utils/errors.js";
import { ENGINE_STATE, StageTimer } from "./EngineContract.js";

/**
 * Base class implementing the engine lifecycle so concrete engines only implement model logic.
 *
 * It enforces: no detect() before initialize() succeeds, no concurrent detect() calls, no use
 * after dispose(), and it records init timings, counters, and the last error. Subclasses
 * override the `on*` template methods.
 *
 * @implements {import('./EngineContract.js').DetectionEngine}
 */
export class BaseDetectionEngine {
  /** Engine kind; subclasses must override. */
  static kind = "base";

  /** @type {import('./EngineContract.js').EngineState} */
  #state = ENGINE_STATE.UNINITIALIZED;
  #busy = false;
  /** @type {import('./EngineContract.js').EngineInitTimings | null} */
  #initTimings = null;
  #detectCount = 0;
  #errorCount = 0;
  /** @type {import('../utils/errors.js').SerializedError | null} */
  #lastError = null;

  /**
   * @param {Record<string, unknown>} config engine-specific configuration
   * @param {{ now?: () => number }} [dependencies]
   */
  constructor(config, { now = epochNow } = {}) {
    this.config = config;
    this.now = now;
  }

  /** @returns {string} */
  get kind() {
    return /** @type {typeof BaseDetectionEngine} */ (this.constructor).kind;
  }

  async initialize() {
    if (this.#state === ENGINE_STATE.READY) return;
    if (this.#state === ENGINE_STATE.DISPOSED) {
      throw new EngineStateError(`${this.kind}: cannot initialize a disposed engine`, {
        code: "DISPOSED",
      });
    }
    if (this.#state === ENGINE_STATE.INITIALIZING) {
      throw new EngineStateError(`${this.kind}: initialization already in progress`, {
        code: "ALREADY_INITIALIZING",
      });
    }
    this.#state = ENGINE_STATE.INITIALIZING;
    const startedAt = this.now();
    try {
      const partialTimings = (await this.onInitialize()) ?? {};
      this.#initTimings = { ...partialTimings, totalMs: this.now() - startedAt };
      this.#state = ENGINE_STATE.READY;
    } catch (error) {
      this.#state = ENGINE_STATE.ERROR;
      this.#lastError = serializeError(error);
      throw error;
    }
  }

  /**
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('./EngineContract.js').FrameMeta} meta
   * @returns {Promise<Omit<import('./EngineContract.js').DetectionResult, 'engine'>>}
   */
  async detect(frame, meta) {
    if (this.#state !== ENGINE_STATE.READY) {
      throw new EngineStateError(`${this.kind}: detect() called in state "${this.#state}"`, {
        code: "NOT_READY",
      });
    }
    if (this.#busy) {
      throw new EngineBusyError(`${this.kind}: detect() called while another frame is running`, {
        code: "BUSY",
      });
    }
    this.#busy = true;
    const timer = new StageTimer(this.now);
    const startedAt = this.now();
    try {
      const output = await this.onDetect(frame, meta, timer);
      const timings = timer.toTimings();
      const completedAt = this.now();
      this.#detectCount += 1;
      return {
        kind: this.kind,
        frameId: meta.frameId,
        frameCaptureTime: meta.captureTime,
        startedAt,
        completedAt,
        processingTimeMs: completedAt - startedAt,
        timings,
        observations: output.observations,
        model: this.getModelInfo(),
        executionProvider: this.getExecutionProvider(),
        ...(output.payload === undefined ? {} : { payload: output.payload }),
      };
    } catch (error) {
      this.#errorCount += 1;
      this.#lastError = serializeError(error);
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * @param {Record<string, unknown>} patch
   * @returns {Promise<Record<string, unknown>>} the effective configuration
   */
  async configure(patch) {
    if (this.#state === ENGINE_STATE.DISPOSED) {
      throw new EngineStateError(`${this.kind}: cannot configure a disposed engine`, {
        code: "DISPOSED",
      });
    }
    if (this.#busy) {
      throw new EngineBusyError(`${this.kind}: configure() called while a frame is running`, {
        code: "BUSY",
      });
    }
    const effective = await this.onConfigure(patch);
    this.config = effective;
    return effective;
  }

  async dispose() {
    if (this.#state === ENGINE_STATE.DISPOSED) return;
    try {
      await this.onDispose();
    } finally {
      this.#state = ENGINE_STATE.DISPOSED;
    }
  }

  /** @returns {import('./EngineContract.js').EngineStatus} */
  getStatus() {
    return {
      kind: this.kind,
      state: this.#state,
      model: this.getModelInfo(),
      executionProvider: this.getExecutionProvider(),
      initTimings: this.#initTimings,
      detectCount: this.#detectCount,
      errorCount: this.#errorCount,
      lastError: this.#lastError,
      details: this.getStatusDetails(),
    };
  }

  // ---- Template methods -------------------------------------------------------------------

  /**
   * Loads the model and allocates resources.
   * @returns {Promise<Partial<import('./EngineContract.js').EngineInitTimings> | void>}
   */
  async onInitialize() {
    return {};
  }

  /**
   * @param {ImageBitmap | VideoFrame} _frame
   * @param {import('./EngineContract.js').FrameMeta} _meta
   * @param {StageTimer} _timer
   * @returns {Promise<{ observations: import('./EngineContract.js').Observation[], payload?: unknown }>}
   */
  async onDetect(_frame, _meta, _timer) {
    throw new LabError(`${this.kind}: onDetect() is not implemented`, { code: "NOT_IMPLEMENTED" });
  }

  /**
   * @param {Record<string, unknown>} _patch
   * @returns {Promise<Record<string, unknown>>}
   */
  async onConfigure(_patch) {
    throw new LabError(`${this.kind}: live reconfiguration is not supported; restart the engine`, {
      code: "CONFIGURE_UNSUPPORTED",
    });
  }

  async onDispose() {}

  /** @returns {import('./EngineContract.js').ModelInfo | null} */
  getModelInfo() {
    return null;
  }

  /** @returns {string | null} */
  getExecutionProvider() {
    return null;
  }

  /**
   * Engine-specific status, e.g. requested and actual delegate. Must be JSON-serializable.
   * @returns {Record<string, unknown> | null}
   */
  getStatusDetails() {
    return null;
  }
}
