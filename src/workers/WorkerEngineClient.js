import { ENGINE_STATE, closeFrame } from "../engines/EngineContract.js";
import { epochNow } from "../utils/clock.js";
import {
  EngineBusyError,
  EngineStateError,
  EngineTimeoutError,
  LabError,
  WorkerCrashedError,
  deserializeError,
  serializeError,
} from "../utils/errors.js";
import { EVENT, REQUEST, createRequest, isProtocolMessage } from "./protocol.js";

/**
 * @typedef {import('../engines/EngineContract.js').EngineStatus & {
 *   instanceId: string,
 *   restarts: number,
 *   inFlight: boolean,
 *   pendingRequests: number,
 *   workerAlive: boolean,
 *   spawnToReadyMs: number | null,
 *   hostInitMs: number | null,
 *   blockedRequests: { count: number, last: { url: string, api: string } | null },
 * }} ClientStatus
 *
 * @typedef {{ type: 'status', status: ClientStatus }
 *   | { type: 'worker-error', error: Error }
 *   | { type: 'hang', error: Error }
 *   | { type: 'egress-blocked', request: { url: string, api: string } }} ClientEvent
 *
 * @typedef {{ dropped: true, reason: 'stale', frameId: number, frameAgeMs: number, queueDelayMs: number }
 *   | { dropped: false, result: import('../engines/EngineContract.js').DetectionResult, frameAgeMs: number, queueDelayMs: number }} DetectResponse
 */

/**
 * Main-thread proxy for one engine instance running in its own dedicated worker.
 *
 * Guarantees:
 * - at most one detect() in flight; a concurrent call is rejected and its frame closed;
 * - every request has a timeout; a detect() timeout means the worker is hung, so it is
 *   terminated and the engine moves to the "error" state until restart();
 * - frames are transferred, not copied; if posting fails the frame is closed here;
 * - responses from a terminated worker generation are ignored.
 */
export class WorkerEngineClient {
  #instanceId;
  #kind;
  /** @type {Record<string, unknown>} */
  #engineConfig;
  #createWorker;
  #initTimeoutMs;
  #requestTimeoutMs;
  #now;
  /** @type {Worker | null} */
  #worker = null;
  #generation = 0;
  #nextRequestId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: unknown) => void, timer: ReturnType<typeof setTimeout>, type: string }>} */
  #pending = new Map();
  #detectInFlight = false;
  #restarts = 0;
  /** Requests to other origins refused by the worker's egress guard, across restarts. */
  #blockedRequests = { count: 0, last: /** @type {{ url: string, api: string } | null} */ (null) };
  /** @type {Set<(event: ClientEvent) => void>} */
  #listeners = new Set();
  /** @type {Omit<ClientStatus, 'instanceId' | 'restarts' | 'inFlight' | 'pendingRequests' | 'workerAlive' | 'blockedRequests'>} */
  #status;

  /**
   * @param {Object} options
   * @param {string} options.instanceId
   * @param {string} options.kind
   * @param {Record<string, unknown>} options.engineConfig
   * @param {() => Worker} options.createWorker
   * @param {number} [options.initTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   * @param {() => number} [options.now]
   */
  constructor({
    instanceId,
    kind,
    engineConfig,
    createWorker,
    initTimeoutMs = 30_000,
    requestTimeoutMs = 10_000,
    now = epochNow,
  }) {
    this.#instanceId = instanceId;
    this.#kind = kind;
    this.#engineConfig = { ...engineConfig };
    this.#createWorker = createWorker;
    this.#initTimeoutMs = initTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#now = now;
    this.#status = {
      kind,
      state: ENGINE_STATE.UNINITIALIZED,
      model: null,
      executionProvider: null,
      initTimings: null,
      detectCount: 0,
      errorCount: 0,
      lastError: null,
      details: null,
      spawnToReadyMs: null,
      hostInitMs: null,
    };
  }

  get instanceId() {
    return this.#instanceId;
  }

  get kind() {
    return this.#kind;
  }

  /** @returns {boolean} */
  get isReady() {
    return this.#status.state === ENGINE_STATE.READY && this.#worker !== null;
  }

  /** @returns {boolean} */
  get inFlight() {
    return this.#detectInFlight;
  }

  /** @returns {Record<string, unknown>} */
  get engineConfig() {
    return { ...this.#engineConfig };
  }

  /**
   * @param {(event: ClientEvent) => void} listener
   * @returns {() => void} unsubscribe
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Spawns the worker, loads the engine, and resolves with the ready status. */
  async initialize() {
    if (this.#status.state === ENGINE_STATE.DISPOSED) {
      throw new EngineStateError(`${this.#instanceId}: client is disposed`, { code: "DISPOSED" });
    }
    if (this.#worker) {
      throw new EngineStateError(`${this.#instanceId}: already started; use restart()`, {
        code: "ALREADY_STARTED",
      });
    }
    const startedAt = this.#now();
    this.#spawn();
    this.#updateStatus({ state: ENGINE_STATE.INITIALIZING, lastError: null });
    try {
      const response = await this.#request(
        REQUEST.INIT,
        { instanceId: this.#instanceId, kind: this.#kind, config: this.#engineConfig },
        { timeoutMs: this.#initTimeoutMs },
      );
      this.#updateStatus({
        ...response.status,
        spawnToReadyMs: this.#now() - startedAt,
        hostInitMs: response.hostInitMs,
      });
      return this.getStatus();
    } catch (error) {
      this.#terminate(
        new WorkerCrashedError(
          `${this.#instanceId}: worker terminated after failed initialization`,
          {
            code: "INIT_FAILED",
            cause: error,
          },
        ),
      );
      this.#updateStatus({ state: ENGINE_STATE.ERROR, lastError: serializeError(error) });
      throw error;
    }
  }

  /**
   * Transfers `frame` to the worker and resolves with the engine result or a drop notice.
   * Ownership of `frame` passes to this method in all cases.
   *
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('../engines/EngineContract.js').FrameMeta} meta
   * @returns {Promise<DetectResponse>}
   */
  async detect(frame, meta) {
    if (!this.isReady) {
      closeFrame(frame);
      throw new EngineStateError(`${this.#instanceId}: not ready (state "${this.#status.state}")`, {
        code: "NOT_READY",
      });
    }
    if (this.#detectInFlight) {
      closeFrame(frame);
      throw new EngineBusyError(`${this.#instanceId}: a frame is already in flight`, {
        code: "BUSY",
      });
    }
    this.#detectInFlight = true;
    try {
      return await this.#request(
        REQUEST.DETECT,
        { frame, meta },
        {
          transfer: [frame],
          timeoutMs: this.#requestTimeoutMs,
          onPostError: () => closeFrame(frame),
          onTimeout: () => this.#handleHang(),
        },
      );
    } finally {
      this.#detectInFlight = false;
    }
  }

  /**
   * Applies a partial engine configuration. Before the worker is started the patch is stored
   * and used at initialization; afterwards it is applied live by the engine.
   *
   * @param {Record<string, unknown>} patch
   * @returns {Promise<Record<string, unknown>>} effective configuration
   */
  async configure(patch) {
    if (this.#status.state === ENGINE_STATE.DISPOSED) {
      throw new EngineStateError(`${this.#instanceId}: client is disposed`, { code: "DISPOSED" });
    }
    if (!this.#worker) {
      this.#engineConfig = { ...this.#engineConfig, ...patch };
      return this.engineConfig;
    }
    if (!this.isReady) {
      throw new EngineStateError(
        `${this.#instanceId}: cannot configure in state "${this.#status.state}"`,
        { code: "NOT_READY" },
      );
    }
    // A configuration change can recreate the model (a MediaPipe delegate switch compiles GPU
    // shaders again), so it gets as long as initialization.
    const response = await this.#request(
      REQUEST.CONFIGURE,
      { patch },
      { timeoutMs: Math.max(this.#requestTimeoutMs, this.#initTimeoutMs) },
    );
    this.#engineConfig = { ...response.config };
    this.#updateStatus(response.status);
    return this.engineConfig;
  }

  /** Terminates the worker and starts a fresh one with the current configuration. */
  async restart() {
    if (this.#status.state === ENGINE_STATE.DISPOSED) {
      throw new EngineStateError(`${this.#instanceId}: client is disposed`, { code: "DISPOSED" });
    }
    this.#terminate(
      new WorkerCrashedError(`${this.#instanceId}: worker terminated for restart`, {
        code: "RESTARTED",
      }),
    );
    this.#restarts += 1;
    this.#updateStatus({ state: ENGINE_STATE.UNINITIALIZED });
    return this.initialize();
  }

  /** Asks the engine to release resources, then terminates the worker. Idempotent. */
  async dispose() {
    if (this.#status.state === ENGINE_STATE.DISPOSED) return;
    if (this.#worker) {
      try {
        await this.#request(
          REQUEST.DISPOSE,
          {},
          { timeoutMs: Math.min(this.#requestTimeoutMs, 5000) },
        );
      } catch (error) {
        // The worker is terminated below either way; keep the reason visible in the status.
        this.#updateStatus({ lastError: serializeError(error) });
      } finally {
        this.#terminate(
          new EngineStateError(`${this.#instanceId}: engine disposed`, { code: "DISPOSED" }),
        );
      }
    }
    this.#updateStatus({ state: ENGINE_STATE.DISPOSED });
  }

  /** @returns {ClientStatus} */
  getStatus() {
    return {
      ...this.#status,
      instanceId: this.#instanceId,
      restarts: this.#restarts,
      inFlight: this.#detectInFlight,
      pendingRequests: this.#pending.size,
      workerAlive: this.#worker !== null,
      blockedRequests: { ...this.#blockedRequests },
    };
  }

  // ---- internals ------------------------------------------------------------------------

  #spawn() {
    const worker = this.#createWorker();
    const generation = ++this.#generation;
    worker.addEventListener("message", (event) => {
      if (generation === this.#generation) this.#onMessage(event);
    });
    worker.addEventListener("error", (event) => {
      if (generation === this.#generation) this.#onWorkerError(event);
    });
    worker.addEventListener("messageerror", () => {
      if (generation === this.#generation) {
        const error = new LabError(
          `${this.#instanceId}: a worker message could not be deserialized`,
          {
            code: "MESSAGE_ERROR",
          },
        );
        this.#updateStatus({ lastError: serializeError(error) });
        this.#emit({ type: "worker-error", error });
      }
    });
    this.#worker = worker;
  }

  /**
   * @param {string} type
   * @param {unknown} payload
   * @param {{ transfer?: Transferable[], timeoutMs: number, onPostError?: () => void, onTimeout?: () => void }} options
   * @returns {Promise<any>}
   */
  #request(type, payload, { transfer = [], timeoutMs, onPostError, onTimeout }) {
    const worker = this.#worker;
    if (!worker) {
      onPostError?.();
      return Promise.reject(
        new EngineStateError(`${this.#instanceId}: no worker running`, { code: "NO_WORKER" }),
      );
    }
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(
          new EngineTimeoutError(`${this.#instanceId}: "${type}" timed out after ${timeoutMs} ms`, {
            code: "TIMEOUT",
          }),
        );
        onTimeout?.();
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, type });
      try {
        worker.postMessage(createRequest(id, type, payload), transfer);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        onPostError?.();
        reject(
          new LabError(`${this.#instanceId}: could not post "${type}" to the worker`, {
            code: "POST_FAILED",
            cause: error,
          }),
        );
      }
    });
  }

  /** @param {MessageEvent} event */
  #onMessage(event) {
    const message = event.data;
    if (!isProtocolMessage(message)) return;
    if (message.kind === "response") {
      const entry = this.#pending.get(/** @type {number} */ (message.id));
      if (!entry) return; // late response to a request that already timed out
      this.#pending.delete(/** @type {number} */ (message.id));
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.payload);
      else entry.reject(deserializeError(message.error));
      return;
    }
    if (message.kind === "event") {
      if (message.type === EVENT.EGRESS_BLOCKED) {
        const request = { url: String(message.payload?.url), api: String(message.payload?.api) };
        this.#blockedRequests = { count: this.#blockedRequests.count + 1, last: request };
        this.#emit({ type: "egress-blocked", request });
        return;
      }
      let error;
      if (message.type === EVENT.FATAL || message.type === EVENT.PROTOCOL_ERROR) {
        error = deserializeError(message.payload.error);
      } else if (message.type === EVENT.CSP_VIOLATION) {
        const { violatedDirective, blockedURI } = message.payload ?? {};
        error = new LabError(
          `${this.#instanceId}: Content Security Policy blocked ${blockedURI || "a resource"} in the worker (${violatedDirective})`,
          { code: "CSP_VIOLATION", details: message.payload },
        );
      } else {
        error = new LabError(`${this.#instanceId}: unexpected worker event "${message.type}"`);
      }
      this.#updateStatus({ lastError: serializeError(error) });
      this.#emit({ type: "worker-error", error });
    }
  }

  /** @param {ErrorEvent} event */
  #onWorkerError(event) {
    const error = new WorkerCrashedError(
      `${this.#instanceId}: ${event.message || "worker script failed to load or threw an uncaught error"}`,
      { code: "WORKER_ERROR", details: { filename: event.filename, lineno: event.lineno } },
    );
    this.#updateStatus({ lastError: serializeError(error) });
    this.#emit({ type: "worker-error", error });
    if (this.#status.state === ENGINE_STATE.INITIALIZING) {
      // The worker cannot answer INIT any more; fail fast instead of waiting for the timeout.
      this.#failPending(error);
    }
  }

  #handleHang() {
    const error = new EngineTimeoutError(
      `${this.#instanceId}: worker did not answer within ${this.#requestTimeoutMs} ms and was terminated`,
      { code: "WORKER_HUNG" },
    );
    this.#terminate(error);
    this.#updateStatus({ state: ENGINE_STATE.ERROR, lastError: serializeError(error) });
    this.#emit({ type: "hang", error });
  }

  /** @param {Error} reason */
  #terminate(reason) {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#generation += 1;
    this.#failPending(reason);
  }

  /** @param {unknown} reason */
  #failPending(reason) {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.#pending.clear();
  }

  /** @param {Record<string, unknown>} patch subset of the status fields */
  #updateStatus(patch) {
    this.#status = { ...this.#status, ...patch };
    this.#emit({ type: "status", status: this.getStatus() });
  }

  /** @param {ClientEvent} event */
  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`${this.#instanceId}: client event listener failed`, error);
      }
    }
  }
}
