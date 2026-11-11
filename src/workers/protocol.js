/**
 * Message protocol between the main thread (WorkerEngineClient) and a worker (engine host).
 *
 * Request:  { v, kind: "request",  id, type, payload }
 * Response: { v, kind: "response", id, ok: true,  payload }
 *           { v, kind: "response", id, ok: false, error: SerializedError }
 * Event:    { v, kind: "event", type, payload }   (unsolicited, worker → main)
 *
 * Every request receives exactly one response. Frames travel in DETECT requests as transferable
 * ImageBitmaps (zero-copy); the worker host closes them after processing.
 */

export const PROTOCOL_VERSION = 1;

export const REQUEST = Object.freeze({
  INIT: "init",
  DETECT: "detect",
  CONFIGURE: "configure",
  STATUS: "status",
  DISPOSE: "dispose",
});

export const EVENT = Object.freeze({
  /** Uncaught error or unhandled rejection inside the worker. */
  FATAL: "fatal",
  /** A message the host could not interpret. */
  PROTOCOL_ERROR: "protocol-error",
  /** The worker's Content Security Policy blocked something (fetch, script, eval, ...). */
  CSP_VIOLATION: "csp-violation",
  /** The worker's egress guard refused a request to another origin. */
  EGRESS_BLOCKED: "egress-blocked",
});

/**
 * @param {number} id
 * @param {string} type
 * @param {unknown} payload
 */
export function createRequest(id, type, payload) {
  return { v: PROTOCOL_VERSION, kind: "request", id, type, payload };
}

/**
 * @param {number} id
 * @param {unknown} payload
 */
export function createSuccess(id, payload) {
  return { v: PROTOCOL_VERSION, kind: "response", id, ok: true, payload };
}

/**
 * @param {number} id
 * @param {import('../utils/errors.js').SerializedError} error
 */
export function createFailure(id, error) {
  return { v: PROTOCOL_VERSION, kind: "response", id, ok: false, error };
}

/**
 * @param {string} type
 * @param {unknown} payload
 */
export function createEvent(type, payload) {
  return { v: PROTOCOL_VERSION, kind: "event", type, payload };
}

/**
 * @param {unknown} data
 * @returns {data is { v: number, kind: string, id?: number, type?: string, ok?: boolean, payload?: any, error?: any }}
 */
export function isProtocolMessage(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    /** @type {{ v?: unknown }} */ (data).v === PROTOCOL_VERSION &&
    typeof (/** @type {{ kind?: unknown }} */ (data).kind) === "string"
  );
}
