import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineBusyError,
  EngineStateError,
  EngineTimeoutError,
  WorkerCrashedError,
} from "../../src/utils/errors.js";
import { WorkerEngineClient } from "../../src/workers/WorkerEngineClient.js";
import { collectTransferables, installWorkerErrorReporting } from "../../src/workers/engineHost.js";
import { EVENT, createEvent } from "../../src/workers/protocol.js";
import {
  FakeEngine,
  createFakeFrame,
  createFakeWorkerFactory,
  createMeta,
  flush,
} from "../helpers/fakes.js";

const loaders = { fake: async () => FakeEngine };
/** @type {WorkerEngineClient[]} */
let clients = [];

function createClient({
  engineConfig = {},
  requestTimeoutMs = 1000,
  initTimeoutMs = 1000,
  kind = "fake",
} = {}) {
  const { factory, workers } = createFakeWorkerFactory(loaders);
  const client = new WorkerEngineClient({
    instanceId: "engine-under-test",
    kind,
    engineConfig,
    createWorker: factory,
    requestTimeoutMs,
    initTimeoutMs,
  });
  clients.push(client);
  return { client, workers };
}

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.dispose()));
  clients = [];
});

describe("WorkerEngineClient + engine host: lifecycle", () => {
  it("initializes and reports ready status with timings", async () => {
    const { client } = createClient();
    const status = await client.initialize();
    expect(status.state).toBe("ready");
    expect(status.kind).toBe("fake");
    expect(status.executionProvider).toBe("fake");
    expect(status.initTimings.modelFetchMs).toBe(1);
    expect(status.initTimings.moduleLoadMs).toBeGreaterThanOrEqual(0);
    expect(status.spawnToReadyMs).toBeGreaterThanOrEqual(0);
    expect(client.isReady).toBe(true);
  });

  it("rejects initialization failures, terminates the worker, and records the error", async () => {
    const { client, workers } = createClient({ engineConfig: { failInit: true } });
    await expect(client.initialize()).rejects.toMatchObject({ code: "FAKE_INIT" });
    expect(client.getStatus().state).toBe("error");
    expect(client.getStatus().lastError.code).toBe("FAKE_INIT");
    expect(workers[0].terminated).toBe(true);
  });

  it("rejects unknown engine kinds", async () => {
    const { client } = createClient({ kind: "does-not-exist" });
    await expect(client.initialize()).rejects.toMatchObject({ code: "UNKNOWN_ENGINE_KIND" });
  });

  it("fails initialization fast when the worker script errors", async () => {
    const { client, workers } = createClient({ initTimeoutMs: 5000 });
    const pending = client.initialize();
    workers[0].emitError("SyntaxError in worker");
    await expect(pending).rejects.toBeInstanceOf(WorkerCrashedError);
  });

  it("disposes: terminates the worker and rejects later frames, closing them", async () => {
    const { client, workers } = createClient();
    await client.initialize();
    await client.dispose();
    expect(client.getStatus().state).toBe("disposed");
    expect(workers[0].terminated).toBe(true);
    const frame = createFakeFrame();
    await expect(client.detect(frame, createMeta())).rejects.toBeInstanceOf(EngineStateError);
    expect(frame.closed).toBe(true);
  });
});

describe("WorkerEngineClient + engine host: detection", () => {
  it("returns a validated result and the host closes the frame", async () => {
    const { client, workers } = createClient();
    await client.initialize();
    const frame = createFakeFrame();
    const response = await client.detect(frame, createMeta({ frameId: 42 }));
    expect(response.dropped).toBe(false);
    expect(response.result.engine).toBe("engine-under-test");
    expect(response.result.frameId).toBe(42);
    expect(response.result.observations).toEqual([{ type: "FAKE", detected: true, value: 42 }]);
    expect(response.result.timings).toEqual({
      preprocessMs: expect.any(Number),
      inferenceMs: expect.any(Number),
      postprocessMs: expect.any(Number),
    });
    expect(frame.closed).toBe(true);
    // The frame was listed as a transferable in the DETECT message.
    expect(workers[0].mainSide.transfers.some((list) => list.includes(frame))).toBe(true);
  });

  it("drops stale frames without running the engine", async () => {
    const { client } = createClient();
    await client.initialize();
    const frame = createFakeFrame();
    const now = performance.timeOrigin + performance.now();
    const response = await client.detect(
      frame,
      createMeta({ captureTime: now - 5000, dispatchTime: now, maxFrameAgeMs: 500 }),
    );
    expect(response).toMatchObject({ dropped: true, reason: "stale" });
    expect(response.frameAgeMs).toBeGreaterThan(500);
    expect(frame.closed).toBe(true);
  });

  it("rejects a concurrent detect() and closes its frame", async () => {
    const { client } = createClient({ engineConfig: { delayMs: 30 } });
    await client.initialize();
    const first = client.detect(createFakeFrame(), createMeta({ frameId: 1 }));
    const secondFrame = createFakeFrame();
    await expect(client.detect(secondFrame, createMeta({ frameId: 2 }))).rejects.toBeInstanceOf(
      EngineBusyError,
    );
    expect(secondFrame.closed).toBe(true);
    await expect(first).resolves.toMatchObject({ dropped: false });
    expect(client.inFlight).toBe(false);
  });

  it("propagates engine errors with name and code and stays ready", async () => {
    const { client } = createClient({ engineConfig: { failDetect: true } });
    await client.initialize();
    const frame = createFakeFrame();
    await expect(client.detect(frame, createMeta())).rejects.toMatchObject({
      name: "LabError",
      code: "FAKE_DETECT",
      message: "fake detect failure",
    });
    expect(frame.closed).toBe(true);
    expect(client.isReady).toBe(true);
    await client.configure({ failDetect: false });
    await expect(client.detect(createFakeFrame(), createMeta())).resolves.toMatchObject({
      dropped: false,
    });
  });

  it("treats a detect() timeout as a hung worker, terminates it, and recovers via restart()", async () => {
    const { client, workers } = createClient({
      engineConfig: { delayMs: 300 },
      requestTimeoutMs: 50,
    });
    const events = [];
    client.onEvent((event) => events.push(event.type));
    await client.initialize();
    await expect(client.detect(createFakeFrame(), createMeta())).rejects.toBeInstanceOf(
      EngineTimeoutError,
    );
    expect(client.getStatus().state).toBe("error");
    expect(client.getStatus().lastError.code).toBe("WORKER_HUNG");
    expect(workers[0].terminated).toBe(true);
    expect(events).toContain("hang");

    await client.configure({ delayMs: 0 });
    const status = await client.restart();
    expect(status.state).toBe("ready");
    expect(status.restarts).toBe(1);
    expect(workers).toHaveLength(2);
    await expect(client.detect(createFakeFrame(), createMeta())).resolves.toMatchObject({
      dropped: false,
    });
    // A late response from the terminated worker must not leak into the new generation.
    await flush(350);
    expect(client.getStatus().pendingRequests).toBe(0);
  });

  it("aborts an in-flight frame with code RESTARTED when restarted", async () => {
    const { client } = createClient({ engineConfig: { delayMs: 100 } });
    await client.initialize();
    const inFlight = client.detect(createFakeFrame(), createMeta());
    const restart = client.restart();
    await expect(inFlight).rejects.toMatchObject({ code: "RESTARTED" });
    await expect(restart).resolves.toMatchObject({ state: "ready" });
  });
});

describe("WorkerEngineClient + engine host: configuration", () => {
  it("stores configuration before start and applies it live afterwards", async () => {
    const { client } = createClient({ engineConfig: { delayMs: 0 } });
    expect(await client.configure({ delayMs: 5 })).toEqual({ delayMs: 5 });
    await client.initialize();
    expect(await client.configure({ delayMs: 1 })).toMatchObject({ delayMs: 1 });
    expect(client.engineConfig).toMatchObject({ delayMs: 1 });
  });
});

describe("engine host: payload transfer and worker-side reporting", () => {
  it("transfers typed arrays of a result payload instead of copying them", async () => {
    const { client, workers } = createClient({ engineConfig: { payloadLength: 12 } });
    await client.initialize();
    const response = await client.detect(createFakeFrame(), createMeta());
    const values = response.result.payload.items[0].values;
    expect(values).toBeInstanceOf(Float32Array);
    expect(workers[0].workerSide.transfers.some((list) => list.includes(values.buffer))).toBe(true);
  });

  it("collects only buffers that a typed array fully covers", () => {
    const owned = new Float32Array(4);
    const shared = new Float32Array(new ArrayBuffer(64), 16, 2);
    const nested = { faces: [{ landmarks: owned, other: shared }, { landmarks: owned }] };
    expect(collectTransferables(nested)).toEqual([owned.buffer]);
    expect(collectTransferables(undefined)).toEqual([]);
    expect(collectTransferables({ map: new Map([["a", owned]]) })).toEqual([]);
  });

  it("forwards Content Security Policy violations from the worker", () => {
    const scope = Object.assign(new EventTarget(), { postMessage: vi.fn() });
    installWorkerErrorReporting(scope);
    const event = Object.assign(new Event("securitypolicyviolation"), {
      violatedDirective: "connect-src",
      blockedURI: "https://example.com/upload",
      sourceFile: "face.worker.js",
      lineNumber: 3,
    });
    scope.dispatchEvent(event);
    expect(scope.postMessage).toHaveBeenCalledWith(
      createEvent(EVENT.CSP_VIOLATION, {
        violatedDirective: "connect-src",
        blockedURI: "https://example.com/upload",
        sourceFile: "face.worker.js",
        lineNumber: 3,
      }),
    );
  });

  it("counts and reports requests refused by the worker's egress guard", async () => {
    const { client, workers } = createClient();
    await client.initialize();
    const events = [];
    client.onEvent((event) => events.push(event));
    workers[0].mainSide.dispatch("message", {
      data: createEvent(EVENT.EGRESS_BLOCKED, {
        url: "https://odml.pa.googleapis.com/v1/log",
        api: "fetch",
      }),
    });
    expect(events).toEqual([
      {
        type: "egress-blocked",
        request: { url: "https://odml.pa.googleapis.com/v1/log", api: "fetch" },
      },
    ]);
    expect(client.getStatus().blockedRequests).toEqual({
      count: 1,
      last: { url: "https://odml.pa.googleapis.com/v1/log", api: "fetch" },
    });
    expect(client.getStatus().lastError).toBeNull();
  });

  it("reports a worker CSP violation as a worker error with code CSP_VIOLATION", async () => {
    const { client, workers } = createClient();
    await client.initialize();
    const errors = [];
    client.onEvent((event) => {
      if (event.type === "worker-error") errors.push(event.error);
    });
    workers[0].mainSide.dispatch("message", {
      data: createEvent(EVENT.CSP_VIOLATION, {
        violatedDirective: "connect-src",
        blockedURI: "https://example.com/upload",
      }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "CSP_VIOLATION" });
    expect(errors[0].message).toMatch(/blocked https:\/\/example\.com\/upload.*connect-src/);
    expect(client.getStatus().lastError.code).toBe("CSP_VIOLATION");
  });
});
