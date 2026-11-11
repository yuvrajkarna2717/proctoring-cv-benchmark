import { describe, expect, it, vi } from "vitest";
import { MODEL_ASSETS } from "../../src/config/modelAssets.js";
import { FaceLandmarkerEngine } from "../../src/engines/face/FaceLandmarkerEngine.js";
import { DEFAULT_FACE_LANDMARKER_CONFIG } from "../../src/engines/face/faceLandmarkerConfig.js";
import { createFakeFrame, createMeta } from "../helpers/fakes.js";

const MODEL = MODEL_ASSETS["mp-face-landmarker"];
const LANDMARKS_PER_FACE = 478;

/** 478 landmarks whose extremes are exactly (x0, y0) and (x1, y1). */
function face(x0, y0, x1, y1) {
  const points = [
    { x: x0, y: y0, z: -0.01 },
    { x: x1, y: y1, z: 0.02 },
  ];
  while (points.length < LANDMARKS_PER_FACE) {
    points.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: 0 });
  }
  return points;
}

/**
 * Stand-in for the MediaPipe runtime. Each created task records its options and calls and
 * returns `task.nextResult` from detectForVideo().
 */
function createFakeRuntime({ failDelegates = [], sha256 = MODEL.sha256 } = {}) {
  const tasks = [];
  const runtime = {
    version: "fake-mediapipe@0",
    loadModel: vi.fn(async () => new Uint8Array(MODEL.bytes)),
    sha256: vi.fn(async () => sha256),
    createFaceLandmarker: vi.fn(async (options) => {
      const delegate = options.baseOptions.delegate;
      if (failDelegates.includes(delegate)) throw new Error(`${delegate} delegate unavailable`);
      const task = {
        options: structuredClone({ ...options, baseOptions: { delegate } }),
        modelAssetBuffer: options.baseOptions.modelAssetBuffer,
        closed: false,
        calls: [],
        nextResult: { faceLandmarks: [] },
        detectForVideo(image, timestamp) {
          task.calls.push({ image, timestamp });
          return task.nextResult;
        },
        setOptions: vi.fn(async (patch) => {
          Object.assign(task.options, patch);
        }),
        close() {
          task.closed = true;
        },
      };
      tasks.push(task);
      return task;
    }),
    createBlankImage: (width, height) => ({ blank: true, width, height }),
  };
  return { runtime, tasks };
}

async function createEngine(config = {}, runtimeOptions = {}, now = () => 500) {
  const { runtime, tasks } = createFakeRuntime(runtimeOptions);
  const engine = new FaceLandmarkerEngine(
    { ...DEFAULT_FACE_LANDMARKER_CONFIG, ...config },
    { runtime, now },
  );
  return { engine, runtime, tasks };
}

describe("FaceLandmarkerEngine initialization", () => {
  it("verifies the model, creates a VIDEO-mode GPU task, and warms it up", async () => {
    const { engine, tasks, runtime } = await createEngine();
    await engine.initialize();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].options).toMatchObject({
      baseOptions: { delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 3,
      minFaceDetectionConfidence: 0.5,
      outputFaceBlendshapes: false,
    });
    expect(tasks[0].modelAssetBuffer.byteLength).toBe(MODEL.bytes);
    expect(tasks[0].calls).toEqual([
      { image: { blank: true, width: 64, height: 64 }, timestamp: 500 },
    ]);
    const status = engine.getStatus();
    expect(status.state).toBe("ready");
    expect(status.executionProvider).toBe("mediapipe-gpu");
    expect(status.model).toMatchObject({
      id: "mp-face-landmarker",
      runtime: "fake-mediapipe@0",
      sha256: MODEL.sha256,
    });
    expect(status.initTimings).toMatchObject({
      modelFetchMs: expect.any(Number),
      modelInitMs: expect.any(Number),
      warmupMs: expect.any(Number),
    });
    expect(status.details).toMatchObject({
      requestedDelegate: "GPU",
      delegate: "GPU",
      fallbackReason: null,
    });
    expect(runtime.loadModel).toHaveBeenCalledWith(MODEL);
  });

  it("rejects a model file whose hash does not match", async () => {
    const { engine, tasks } = await createEngine({}, { sha256: "0".repeat(64) });
    await expect(engine.initialize()).rejects.toMatchObject({ code: "MODEL_INTEGRITY" });
    expect(engine.getStatus().state).toBe("error");
    expect(tasks).toHaveLength(0);
  });

  it("falls back to the CPU delegate when GPU fails and reports why", async () => {
    const { engine } = await createEngine({}, { failDelegates: ["GPU"] });
    await engine.initialize();
    const status = engine.getStatus();
    expect(status.executionProvider).toBe("mediapipe-cpu");
    expect(status.details.requestedDelegate).toBe("GPU");
    expect(status.details.delegate).toBe("CPU");
    expect(status.details.fallbackReason).toMatch(/GPU delegate unavailable/);
  });

  it("fails instead of falling back when allowCpuFallback is off", async () => {
    const { engine } = await createEngine({ allowCpuFallback: false }, { failDelegates: ["GPU"] });
    await expect(engine.initialize()).rejects.toThrow(/GPU delegate unavailable/);
  });

  it("skips the warm-up inference when disabled", async () => {
    const { engine, tasks } = await createEngine({ warmup: false });
    await engine.initialize();
    expect(tasks[0].calls).toHaveLength(0);
    expect(engine.getStatus().initTimings.warmupMs).toBeUndefined();
  });

  it("validates its configuration and requires a runtime", () => {
    const { runtime } = createFakeRuntime();
    expect(
      () =>
        new FaceLandmarkerEngine({ ...DEFAULT_FACE_LANDMARKER_CONFIG, numFaces: 0 }, { runtime }),
    ).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => new FaceLandmarkerEngine({ ...DEFAULT_FACE_LANDMARKER_CONFIG })).toThrow(
      expect.objectContaining({ code: "RUNTIME_MISSING" }),
    );
  });
});

describe("FaceLandmarkerEngine detection", () => {
  it("reports the face count, boxes from landmarks, and landmarks as Float32Arrays", async () => {
    const { engine, tasks } = await createEngine();
    await engine.initialize();
    tasks[0].nextResult = {
      faceLandmarks: [face(0.4, 0.2, 0.6, 0.7), face(0.1, 0.1, 0.25, 0.4)],
    };
    const result = await engine.detect(
      createFakeFrame(1280, 720),
      createMeta({ frameId: 7, width: 1280, height: 720 }),
    );
    expect(result.observations[0]).toEqual({
      type: "FACE_COUNT",
      detected: true,
      value: 2,
      metadata: { maxFaces: 3 },
    });
    expect(result.observations.slice(1)).toEqual([
      {
        type: "FACE",
        detected: true,
        value: 0,
        metadata: {
          box: { x: 0.4, y: 0.2, width: expect.closeTo(0.2, 10), height: expect.closeTo(0.5, 10) },
          truncated: false,
          landmarkCount: LANDMARKS_PER_FACE,
        },
      },
      expect.objectContaining({ type: "FACE", value: 1 }),
    ]);
    const { payload } = result;
    expect(payload).toMatchObject({
      format: "mediapipe-face-landmarks",
      imageWidth: 1280,
      imageHeight: 720,
    });
    expect(payload.faces).toHaveLength(2);
    const landmarks = payload.faces[0].landmarks;
    expect(landmarks).toBeInstanceOf(Float32Array);
    expect(landmarks).toHaveLength(LANDMARKS_PER_FACE * 3);
    expect(Array.from(landmarks.slice(0, 6))).toEqual([
      Math.fround(0.4),
      Math.fround(0.2),
      Math.fround(-0.01),
      Math.fround(0.6),
      Math.fround(0.7),
      Math.fround(0.02),
    ]);
    expect(result.executionProvider).toBe("mediapipe-gpu");
  });

  it("reports no face as FACE_COUNT 0 with detected false", async () => {
    const { engine } = await createEngine();
    await engine.initialize();
    const result = await engine.detect(createFakeFrame(), createMeta());
    expect(result.observations).toEqual([
      { type: "FACE_COUNT", detected: false, value: 0, metadata: { maxFaces: 3 } },
    ]);
    expect(result.payload.faces).toEqual([]);
  });

  it("clamps boxes to the image and flags faces partly outside it", async () => {
    const { engine, tasks } = await createEngine();
    await engine.initialize();
    tasks[0].nextResult = { faceLandmarks: [face(-0.1, 0.5, 0.3, 1.2)] };
    const result = await engine.detect(createFakeFrame(), createMeta());
    expect(result.observations[1].metadata).toMatchObject({
      box: { x: 0, y: 0.5, width: 0.3, height: 0.5 },
      truncated: true,
    });
  });

  it("omits landmark coordinates when includeLandmarks is off", async () => {
    const { engine, tasks } = await createEngine({ includeLandmarks: false });
    await engine.initialize();
    tasks[0].nextResult = { faceLandmarks: [face(0.4, 0.2, 0.6, 0.7)] };
    const result = await engine.detect(createFakeFrame(), createMeta());
    expect(result.payload.faces[0]).toMatchObject({ landmarks: null, truncated: false });
  });

  it("passes strictly increasing timestamps even when capture times repeat or go back", async () => {
    const { engine, tasks } = await createEngine();
    await engine.initialize(); // warm-up at now() = 500
    for (const captureTime of [1000.4, 1000.4, 990, 1100]) {
      await engine.detect(createFakeFrame(), createMeta({ captureTime }));
    }
    expect(tasks[0].calls.map((call) => call.timestamp)).toEqual([500, 1000, 1001, 1002, 1100]);
  });

  it("passes blendshapes and transformation matrices through when enabled", async () => {
    const { engine, tasks } = await createEngine({
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    await engine.initialize();
    tasks[0].nextResult = {
      faceLandmarks: [face(0.4, 0.2, 0.6, 0.7)],
      faceBlendshapes: [
        {
          categories: [
            { categoryName: "eyeBlinkLeft", score: 0.25 },
            { categoryName: "jawOpen", score: 0.5 },
          ],
        },
      ],
      facialTransformationMatrixes: [
        { rows: 4, columns: 4, data: Array.from({ length: 16 }, (_, i) => i) },
      ],
    };
    const { payload } = await engine.detect(createFakeFrame(), createMeta());
    expect(payload.blendshapes[0].names).toEqual(["eyeBlinkLeft", "jawOpen"]);
    expect(Array.from(payload.blendshapes[0].scores)).toEqual([0.25, 0.5]);
    expect(payload.transformationMatrices[0]).toMatchObject({ rows: 4, columns: 4 });
    expect(payload.transformationMatrices[0].data).toBeInstanceOf(Float32Array);
    expect(tasks[0].options).toMatchObject({
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  });
});

describe("FaceLandmarkerEngine configuration and disposal", () => {
  it("applies thresholds live and recreates the task only for a delegate change", async () => {
    const { engine, tasks } = await createEngine();
    await engine.initialize();

    const live = await engine.configure({ minFaceDetectionConfidence: 0.7, numFaces: 2 });
    expect(live).toMatchObject({ minFaceDetectionConfidence: 0.7, numFaces: 2, delegate: "GPU" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ minFaceDetectionConfidence: 0.7, numFaces: 2 }),
    );

    await engine.configure({ delegate: "CPU" });
    expect(tasks).toHaveLength(2);
    expect(tasks[0].closed).toBe(true);
    expect(tasks[1].options).toMatchObject({
      baseOptions: { delegate: "CPU" },
      minFaceDetectionConfidence: 0.7,
      numFaces: 2,
    });
    expect(engine.getStatus().executionProvider).toBe("mediapipe-cpu");
    expect(engine.getStatus().details.lastTaskCreation).toMatchObject({ delegate: "CPU" });
  });

  it("keeps the working task and configuration when recreating fails", async () => {
    const { engine, tasks } = await createEngine({}, { failDelegates: ["CPU"] });
    await engine.initialize();
    await expect(engine.configure({ delegate: "CPU" })).rejects.toThrow(/CPU delegate unavailable/);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].closed).toBe(false);
    expect(engine.config.delegate).toBe("GPU");
    expect(engine.getStatus().executionProvider).toBe("mediapipe-gpu");
    await expect(engine.detect(createFakeFrame(), createMeta())).resolves.toMatchObject({
      observations: [expect.objectContaining({ type: "FACE_COUNT" })],
    });
  });

  it("rejects invalid live configuration", async () => {
    const { engine } = await createEngine();
    await engine.initialize();
    await expect(engine.configure({ minTrackingConfidence: 2 })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  it("closes the MediaPipe task on dispose", async () => {
    const { engine, tasks } = await createEngine();
    await engine.initialize();
    await engine.dispose();
    expect(tasks[0].closed).toBe(true);
    expect(engine.getStatus().state).toBe("disposed");
  });
});
