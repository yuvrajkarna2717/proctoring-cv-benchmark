/**
 * Error types used across threads, plus structured-clone-safe (de)serialization.
 *
 * Errors thrown inside a worker cannot cross `postMessage` with their class intact, so the worker
 * serializes them and the main thread rebuilds an equivalent instance. `name` and `code` survive
 * the round trip and are what callers should branch on.
 */

export class LabError extends Error {
  /**
   * The value of `name`. Spelled out per class because minified builds rename classes, so
   * `new.target.name` would put names like "bi" into logs and reports and break
   * {@link deserializeError}.
   */
  static errorName = "LabError";

  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown, details?: unknown }} [options]
   */
  constructor(message, { code, cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = /** @type {typeof LabError} */ (new.target).errorName;
    /** @type {string | undefined} */
    this.code = code;
    /** @type {unknown} */
    this.details = details;
  }
}

/** Configuration failed schema validation. */
export class ConfigValidationError extends LabError {
  static errorName = "ConfigValidationError";
}

/** An engine method was called in a state that does not allow it (not ready, disposed, ...). */
export class EngineStateError extends LabError {
  static errorName = "EngineStateError";
}

/** A second detect() call arrived while the engine was still processing a frame. */
export class EngineBusyError extends LabError {
  static errorName = "EngineBusyError";
}

/** A worker request did not complete within its timeout. */
export class EngineTimeoutError extends LabError {
  static errorName = "EngineTimeoutError";
}

/** The worker hosting an engine crashed, failed to load, or was terminated. */
export class WorkerCrashedError extends LabError {
  static errorName = "WorkerCrashedError";
}

/** Camera access or capture failed. `code` holds a stable reason such as PERMISSION_DENIED. */
export class CameraError extends LabError {
  static errorName = "CameraError";
}

const ERROR_CLASSES = {
  LabError,
  ConfigValidationError,
  EngineStateError,
  EngineBusyError,
  EngineTimeoutError,
  WorkerCrashedError,
  CameraError,
};

/**
 * @typedef {Object} SerializedError
 * @property {string} name
 * @property {string} message
 * @property {string=} code
 * @property {string=} stack
 * @property {unknown=} details
 * @property {SerializedError=} cause
 */

const MAX_CAUSE_DEPTH = 4;

/**
 * Converts any thrown value into a plain object that survives structured cloning and JSON.
 *
 * @param {unknown} error
 * @param {number} [depth]
 * @returns {SerializedError}
 */
export function serializeError(error, depth = 0) {
  if (error !== null && typeof error === "object" && "message" in error) {
    const source =
      /** @type {{ name?: unknown, message: unknown, code?: unknown, stack?: unknown, details?: unknown, cause?: unknown }} */ (
        error
      );
    /** @type {SerializedError} */
    const serialized = {
      name: typeof source.name === "string" ? source.name : "Error",
      message: String(source.message),
    };
    if (typeof source.code === "string") serialized.code = source.code;
    if (typeof source.stack === "string") serialized.stack = source.stack;
    if (source.details !== undefined) serialized.details = toPlainData(source.details);
    if (source.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
      serialized.cause = serializeError(source.cause, depth + 1);
    }
    return serialized;
  }
  return { name: "NonErrorThrown", message: String(error) };
}

/**
 * Rebuilds an Error from {@link serializeError} output. Known lab error names map back to their
 * classes; other names (TypeError, DOMException names, ...) become LabError with the original name.
 *
 * @param {SerializedError} data
 * @returns {Error}
 */
export function deserializeError(data) {
  const cause = data.cause ? deserializeError(data.cause) : undefined;
  const ErrorClass =
    ERROR_CLASSES[/** @type {keyof typeof ERROR_CLASSES} */ (data.name)] ?? LabError;
  const error = new ErrorClass(data.message, { code: data.code, cause, details: data.details });
  error.name = data.name;
  if (data.stack) error.stack = data.stack;
  return error;
}

/**
 * Formats an error for display, including the chain of causes.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  const parts = [];
  let current = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth <= MAX_CAUSE_DEPTH) {
    if (typeof current === "object" && "message" in current) {
      const item =
        /** @type {{ name?: string, message: string, code?: string, cause?: unknown }} */ (current);
      const code = item.code ? ` [${item.code}]` : "";
      parts.push(`${item.name ?? "Error"}${code}: ${item.message}`);
      current = item.cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
    depth += 1;
  }
  return parts.join(" <- caused by: ");
}

/**
 * Drops anything that is not JSON-representable (functions, DOM nodes, cycles).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function toPlainData(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
