import { closeFrame, validateDetectionResult } from "../engines/EngineContract.js";
import { epochNow } from "../utils/clock.js";
import { EngineBusyError, EngineStateError, LabError, serializeError } from "../utils/errors.js";
import { installEgressGuard } from "./egressGuard.js";
import {
  EVENT,
  REQUEST,
  createEvent,
  createFailure,
  createSuccess,
  isProtocolMessage,
} from "./protocol.js";

/**
 * @typedef {Object} MessageEndpoint
 * @property {(message: unknown, transfer?: Transferable[]) => void} postMessage
 * @property {(type: 'message', listener: (event: MessageEvent) => void) => void} addEventListener
 * @property {(type: 'message', listener: (event: MessageEvent) => void) => void} removeEventListener
 * @property {() => void=} start
 */

/**
 * @typedef {new (config: Record<string, unknown>, deps: { now: () => number }) => import('../engines/EngineContract.js').DetectionEngine} EngineConstructor
 */

/**
 * Serves the engine RPC protocol for one engine instance inside a worker.
 *
 * Frame ownership: every frame received in a DETECT request is closed by the host once the
 * request settles, including when it is rejected as stale or busy. Engines never close frames.
 *
 * @param {Object} options
 * @param {MessageEndpoint} options.endpoint `self` in a worker, a test double in unit tests
 * @param {Record<string, () => Promise<EngineConstructor>>} options.loaders engine kind → lazy class loader
 * @param {() => number} [options.now]
 * @returns {{ dispose: () => void }}
 */
export function createEngineHost({ endpoint, loaders, now = epochNow }) {
  /** @type {import('../engines/EngineContract.js').DetectionEngine | null} */
  let engine = null;
  /** @type {string | null} */
  let instanceId = null;
  let detectInFlight = false;
  /** @type {Promise<unknown> | null} settles when the in-flight detect() settles */
  let detectSettled = null;

  /** Waits for an in-flight detect() so configure/dispose never interleave with inference. */
  const waitForIdle = async () => {
    if (detectSettled) await detectSettled;
  };

  /** @type {Record<string, (payload: any) => Promise<unknown>>} */
  const handlers = {
    async [REQUEST.INIT]({ instanceId: requestedId, kind, config }) {
      if (engine) {
        throw new EngineStateError("This worker already hosts an engine", {
          code: "ALREADY_INITIALIZED",
        });
      }
      const loader = loaders[kind];
      if (!loader) {
        throw new LabError(`This worker cannot host engine kind "${kind}"`, {
          code: "UNKNOWN_ENGINE_KIND",
        });
      }
      const startedAt = now();
      const EngineClass = await loader();
      const moduleLoadMs = now() - startedAt;
      // Assign before initialize() so STATUS and DISPOSE work after an initialization failure.
      engine = new EngineClass(config, { now });
      instanceId = requestedId;
      await engine.initialize();
      const status = engine.getStatus();
      return {
        status: { ...status, initTimings: { ...status.initTimings, moduleLoadMs } },
        hostInitMs: now() - startedAt,
      };
    },

    async [REQUEST.DETECT]({ frame, meta }) {
      try {
        if (!engine) {
          throw new EngineStateError("No engine initialized in this worker", {
            code: "NOT_INITIALIZED",
          });
        }
        if (detectInFlight) {
          throw new EngineBusyError("The engine is still processing the previous frame", {
            code: "BUSY",
          });
        }
        const receivedAt = now();
        const frameAgeMs = receivedAt - meta.captureTime;
        const queueDelayMs = receivedAt - meta.dispatchTime;
        if (frameAgeMs > meta.maxFrameAgeMs) {
          return {
            dropped: true,
            reason: "stale",
            frameId: meta.frameId,
            frameAgeMs,
            queueDelayMs,
          };
        }
        detectInFlight = true;
        const detection = engine.detect(frame, meta);
        detectSettled = detection.then(
          () => undefined,
          () => undefined,
        );
        try {
          const result = await detection;
          validateDetectionResult(result);
          return {
            dropped: false,
            result: { ...result, engine: instanceId },
            frameAgeMs,
            queueDelayMs,
          };
        } finally {
          detectInFlight = false;
          detectSettled = null;
        }
      } finally {
        closeFrame(frame);
      }
    },

    async [REQUEST.CONFIGURE]({ patch }) {
      if (!engine) {
        throw new EngineStateError("No engine initialized in this worker", {
          code: "NOT_INITIALIZED",
        });
      }
      await waitForIdle();
      const config = await engine.configure(patch);
      return { config, status: engine.getStatus() };
    },

    async [REQUEST.STATUS]() {
      return { status: engine ? engine.getStatus() : null };
    },

    async [REQUEST.DISPOSE]() {
      if (!engine) return { status: null };
      const disposing = engine;
      await waitForIdle();
      await disposing.dispose();
      engine = null;
      return { status: disposing.getStatus() };
    },
  };

  /** @param {MessageEvent} event */
  const onMessage = async (event) => {
    const message = event.data;
    if (
      !isProtocolMessage(message) ||
      message.kind !== "request" ||
      !Number.isInteger(message.id)
    ) {
      closeFrame(message?.payload?.frame);
      endpoint.postMessage(
        createEvent(EVENT.PROTOCOL_ERROR, {
          error: serializeError(new LabError("Malformed request", { code: "PROTOCOL_ERROR" })),
        }),
      );
      return;
    }
    const id = /** @type {number} */ (message.id);
    const handler = handlers[/** @type {string} */ (message.type)];
    try {
      if (!handler) {
        closeFrame(message.payload?.frame);
        throw new LabError(`Unknown request type "${message.type}"`, { code: "UNKNOWN_REQUEST" });
      }
      const payload = await handler(message.payload ?? {});
      // Typed arrays in a result payload (landmarks, masks) move to the main thread without a
      // copy; they are detached here afterwards.
      const transfer =
        message.type === REQUEST.DETECT ? collectTransferables(payload?.result?.payload) : [];
      endpoint.postMessage(createSuccess(id, payload), transfer);
    } catch (error) {
      endpoint.postMessage(createFailure(id, serializeError(error)));
    }
  };

  endpoint.addEventListener("message", onMessage);
  endpoint.start?.();

  return {
    dispose() {
      endpoint.removeEventListener("message", onMessage);
    },
  };
}

/**
 * Collects the ArrayBuffers behind typed arrays found in plain objects and arrays, for use as a
 * postMessage transfer list. Engines must put only arrays they allocated themselves into a
 * payload (never a view of WASM memory), because transferred buffers are detached.
 *
 * @param {unknown} value
 * @param {number} [maxDepth]
 * @returns {ArrayBuffer[]}
 */
export function collectTransferables(value, maxDepth = 6) {
  /** @type {Set<ArrayBuffer>} */
  const buffers = new Set();
  /** @param {unknown} node @param {number} depth */
  const visit = (node, depth) => {
    if (node === null || typeof node !== "object" || depth > maxDepth) return;
    if (ArrayBuffer.isView(node)) {
      if (node.buffer instanceof ArrayBuffer && node.byteLength === node.buffer.byteLength) {
        buffers.add(node.buffer);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(node) === Object.prototype) {
      for (const item of Object.values(node)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return [...buffers];
}

/**
 * Everything a worker entry installs before hosting an engine: error and CSP-violation
 * reporting, and the egress guard, whose refusals are reported as EGRESS_BLOCKED events.
 *
 * @param {any} scope the worker global scope (`self`)
 */
export function installWorkerSafeguards(scope) {
  installWorkerErrorReporting(scope);
  installEgressGuard(scope, {
    onBlocked: (request) => scope.postMessage(createEvent(EVENT.EGRESS_BLOCKED, request)),
  });
}

/**
 * Forwards uncaught errors and unhandled rejections in the worker to the main thread as FATAL
 * events, so failures outside a request are visible instead of silently lost. Content Security
 * Policy violations inside the worker are forwarded as CSP_VIOLATION events; the page's own
 * `securitypolicyviolation` listener does not see them.
 *
 * @param {{ addEventListener: Function, postMessage: (message: unknown) => void }} scope
 */
export function installWorkerErrorReporting(scope) {
  scope.addEventListener(
    "securitypolicyviolation",
    (/** @type {SecurityPolicyViolationEvent} */ event) => {
      scope.postMessage(
        createEvent(EVENT.CSP_VIOLATION, {
          violatedDirective: event.violatedDirective,
          blockedURI: event.blockedURI,
          sourceFile: event.sourceFile,
          lineNumber: event.lineNumber,
        }),
      );
    },
  );
  scope.addEventListener("error", (/** @type {ErrorEvent} */ event) => {
    scope.postMessage(
      createEvent(EVENT.FATAL, {
        error: serializeError(
          event.error ?? new LabError(event.message || "Uncaught worker error"),
        ),
      }),
    );
  });
  scope.addEventListener("unhandledrejection", (/** @type {PromiseRejectionEvent} */ event) => {
    scope.postMessage(createEvent(EVENT.FATAL, { error: serializeError(event.reason) }));
  });
}
