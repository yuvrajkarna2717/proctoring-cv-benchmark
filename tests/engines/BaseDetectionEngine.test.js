import { describe, expect, it } from "vitest";
import { DiagnosticEngine } from "../../src/engines/diagnostic/DiagnosticEngine.js";
import { BaseDetectionEngine } from "../../src/engines/BaseDetectionEngine.js";
import { StageTimer, validateDetectionResult } from "../../src/engines/EngineContract.js";
import {
  ConfigValidationError,
  EngineBusyError,
  EngineStateError,
} from "../../src/utils/errors.js";
import { FakeEngine, createFakeFrame, createMeta } from "../helpers/fakes.js";

describe("BaseDetectionEngine lifecycle", () => {
  it("refuses detect() before initialize()", async () => {
    const engine = new FakeEngine({});
    await expect(engine.detect(createFakeFrame(), createMeta())).rejects.toBeInstanceOf(
      EngineStateError,
    );
  });

  it("initializes once and records init timings", async () => {
    const engine = new FakeEngine({});
    await engine.initialize();
    await engine.initialize();
    const status = engine.getStatus();
    expect(status.state).toBe("ready");
    expect(status.initTimings).toMatchObject({
      modelFetchMs: 1,
      modelInitMs: 2,
      totalMs: expect.any(Number),
    });
  });

  it("moves to error state when initialization fails", async () => {
    const engine = new FakeEngine({ failInit: true });
    await expect(engine.initialize()).rejects.toMatchObject({ code: "FAKE_INIT" });
    expect(engine.getStatus()).toMatchObject({ state: "error", lastError: { code: "FAKE_INIT" } });
  });

  it("rejects concurrent detect() calls", async () => {
    const engine = new FakeEngine({ delayMs: 20 });
    await engine.initialize();
    const first = engine.detect(createFakeFrame(), createMeta());
    await expect(engine.detect(createFakeFrame(), createMeta())).rejects.toBeInstanceOf(
      EngineBusyError,
    );
    await first;
  });

  it("counts successes and failures", async () => {
    const engine = new FakeEngine({ failDetect: true });
    await engine.initialize();
    await expect(engine.detect(createFakeFrame(), createMeta())).rejects.toThrow();
    await engine.configure({ failDetect: false });
    await engine.detect(createFakeFrame(), createMeta());
    expect(engine.getStatus()).toMatchObject({ detectCount: 1, errorCount: 1 });
  });

  it("cannot be used after dispose()", async () => {
    const engine = new FakeEngine({});
    await engine.initialize();
    await engine.dispose();
    await engine.dispose();
    expect(engine.getStatus().state).toBe("disposed");
    await expect(engine.initialize()).rejects.toMatchObject({ code: "DISPOSED" });
    await expect(engine.detect(createFakeFrame(), createMeta())).rejects.toBeInstanceOf(
      EngineStateError,
    );
  });

  it("reports CONFIGURE_UNSUPPORTED by default", async () => {
    class Minimal extends BaseDetectionEngine {
      static kind = "minimal";
    }
    const engine = new Minimal({});
    await expect(engine.configure({ a: 1 })).rejects.toMatchObject({
      code: "CONFIGURE_UNSUPPORTED",
    });
  });

  it("produces results that pass boundary validation", async () => {
    const engine = new FakeEngine({});
    await engine.initialize();
    const result = await engine.detect(createFakeFrame(), createMeta({ frameId: 9 }));
    expect(() => validateDetectionResult(result)).not.toThrow();
    expect(result).toMatchObject({ kind: "fake", frameId: 9, executionProvider: "fake" });
  });
});

describe("StageTimer", () => {
  it("accumulates time per stage, ending the previous stage on start()", () => {
    let now = 0;
    const timer = new StageTimer(() => now);
    timer.start("preprocess");
    now = 3;
    timer.start("inference");
    now = 10;
    timer.start("postprocess");
    now = 11;
    timer.start("inference");
    now = 12;
    expect(timer.toTimings()).toEqual({ preprocessMs: 3, inferenceMs: 8, postprocessMs: 1 });
  });

  it("rejects unknown stages", () => {
    expect(() => new StageTimer(() => 0).start("download")).toThrow(RangeError);
  });
});

describe("validateDetectionResult", () => {
  it("lists every structural problem", () => {
    expect(() =>
      validateDetectionResult({
        kind: 1,
        frameId: "x",
        timings: {},
        observations: [{ type: "A" }],
      }),
    ).toThrow(
      /kind must be a string.*frameId must be a finite number.*observations\[0\]\.detected/s,
    );
  });

  it("rejects non-finite confidence", () => {
    const base = {
      kind: "k",
      frameId: 1,
      startedAt: 0,
      completedAt: 1,
      processingTimeMs: 1,
      timings: { preprocessMs: 0, inferenceMs: 1, postprocessMs: 0 },
      observations: [{ type: "A", detected: true, confidence: Number.NaN }],
    };
    expect(() => validateDetectionResult(base)).toThrow(/confidence/);
  });
});

describe("DiagnosticEngine configuration", () => {
  it("validates its configuration at construction", () => {
    expect(
      () =>
        new DiagnosticEngine({
          sampleWidth: 64,
          simulatedWorkMs: 0,
          simulatedInitMs: 0,
          failEveryN: 0,
        }),
    ).not.toThrow();
    expect(
      () =>
        new DiagnosticEngine({
          sampleWidth: 4,
          simulatedWorkMs: 0,
          simulatedInitMs: 0,
          failEveryN: 0,
        }),
    ).toThrow(ConfigValidationError);
  });

  it("fails initialization clearly where OffscreenCanvas is unavailable", async () => {
    const engine = new DiagnosticEngine({
      sampleWidth: 64,
      simulatedWorkMs: 0,
      simulatedInitMs: 0,
      failEveryN: 0,
    });
    await expect(engine.initialize()).rejects.toMatchObject({ code: "UNSUPPORTED_API" });
  });
});
