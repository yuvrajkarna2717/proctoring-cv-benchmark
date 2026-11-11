import { BaseDetectionEngine } from "../../src/engines/BaseDetectionEngine.js";
import { LabError } from "../../src/utils/errors.js";
import { createEngineHost } from "../../src/workers/engineHost.js";

/** Resolves after pending timers and microtasks have run. */
export function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stand-in for ImageBitmap that records whether it was closed. */
export function createFakeFrame(width = 640, height = 480) {
  return {
    width,
    height,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

/** @returns {{ promise: Promise<any>, resolve: (value?: any) => void, reject: (error: unknown) => void }} */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * In-memory endpoint pair. Messages are delivered asynchronously (like postMessage) but are
 * passed by reference, so fake frames keep their methods.
 */
export function createLoopbackPair() {
  const a = new LoopbackEndpoint();
  const b = new LoopbackEndpoint();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class LoopbackEndpoint {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();
  /** @type {LoopbackEndpoint | null} */
  peer = null;
  closed = false;
  /** @type {unknown[][]} */
  transfers = [];

  addEventListener(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  postMessage(data, transfer = []) {
    if (this.closed) return;
    this.transfers.push(transfer);
    const target = this.peer;
    setTimeout(() => {
      if (!this.closed && target && !target.closed) target.dispatch("message", { data });
    }, 0);
  }

  dispatch(type, event) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  close() {
    this.closed = true;
  }
}

/**
 * Worker factory backed by an in-process engine host, for testing WorkerEngineClient without
 * real threads.
 *
 * @param {Record<string, () => Promise<any>>} loaders
 */
export function createFakeWorkerFactory(loaders) {
  const workers = [];
  const factory = () => {
    const [mainSide, workerSide] = createLoopbackPair();
    const host = createEngineHost({ endpoint: workerSide, loaders });
    const worker = {
      terminated: false,
      addEventListener: (type, listener) => mainSide.addEventListener(type, listener),
      removeEventListener: (type, listener) => mainSide.removeEventListener(type, listener),
      postMessage: (data, transfer) => mainSide.postMessage(data, transfer),
      terminate() {
        worker.terminated = true;
        mainSide.close();
        workerSide.close();
        host.dispose();
      },
      /** Simulates an `error` event on the Worker object (script failure). */
      emitError(message) {
        mainSide.dispatch("error", { message, filename: "fake.worker.js", lineno: 1 });
      },
      mainSide,
      workerSide,
    };
    workers.push(worker);
    return worker;
  };
  return { factory, workers };
}

/**
 * Configurable engine for host/client tests.
 * config: { delayMs?, failInit?, failDetect?, payloadLength? }
 * `payloadLength` adds a payload with a Float32Array of that length to each result.
 */
export class FakeEngine extends BaseDetectionEngine {
  static kind = "fake";
  detectCalls = 0;

  async onInitialize() {
    if (this.config.failInit) throw new LabError("fake init failure", { code: "FAKE_INIT" });
    return { modelFetchMs: 1, modelInitMs: 2 };
  }

  async onDetect(_frame, meta, timer) {
    this.detectCalls += 1;
    timer.start("preprocess");
    if (this.config.delayMs) await flush(this.config.delayMs);
    timer.start("inference");
    if (this.config.failDetect) throw new LabError("fake detect failure", { code: "FAKE_DETECT" });
    timer.start("postprocess");
    const observations = [{ type: "FAKE", detected: true, value: meta.frameId }];
    if (!this.config.payloadLength) return { observations };
    return {
      observations,
      payload: { items: [{ values: new Float32Array(this.config.payloadLength) }] },
    };
  }

  async onConfigure(patch) {
    return { ...this.config, ...patch };
  }

  getExecutionProvider() {
    return "fake";
  }
}

/** Frame metadata with sensible defaults. */
export function createMeta(overrides = {}) {
  const now = performance.timeOrigin + performance.now();
  return {
    frameId: 1,
    captureTime: now,
    captureTimeSource: "callbackTime",
    mediaTime: null,
    dispatchTime: now,
    sourceWidth: 640,
    sourceHeight: 480,
    width: 640,
    height: 480,
    maxFrameAgeMs: 10_000,
    ...overrides,
  };
}
