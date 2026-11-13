import { describe, expect, it, vi } from "vitest";
import { MODEL_ASSETS } from "../../../src/config/modelAssets.js";
import { COCO_LABELS } from "../../../src/engines/objects/cocoLabels.js";
import { MediapipeObjectDetectorEngine } from "../../../src/engines/objects/MediapipeObjectDetectorEngine.js";
import {
  DEFAULT_MEDIAPIPE_OBJECT_CONFIG,
  DEFAULT_ONNX_OBJECT_CONFIG,
} from "../../../src/engines/objects/objectDetectorConfig.js";
import { objectResult } from "../../../src/engines/objects/objectObservations.js";
import { OnnxObjectDetectorEngine } from "../../../src/engines/objects/OnnxObjectDetectorEngine.js";
import { createFakeFrame, createMeta } from "../../helpers/fakes.js";

const PHONE = COCO_LABELS.indexOf("cell phone");
const meta = (overrides = {}) =>
  createMeta({ width: 1280, height: 720, sourceWidth: 1280, sourceHeight: 720, ...overrides });

/** Model loading that passes the integrity check unless `badHash` names the asset. */
function fakeModelLoading({ badHash = null } = {}) {
  return {
    loadModel: vi.fn(async (asset) => ({ byteLength: asset.bytes, assetId: asset.id })),
    sha256: vi.fn(async (bytes) =>
      bytes.assetId === badHash ? "0".repeat(64) : MODEL_ASSETS[bytes.assetId].sha256,
    ),
  };
}

describe("objectResult", () => {
  const detection = (label, score, x = 0.1) => ({
    classId: COCO_LABELS.indexOf(label),
    label,
    score,
    box: { x, y: 0.2, width: 0.3, height: 0.4 },
  });

  it("reports allowed classes at or above minScore, highest first, up to maxDetections", () => {
    const result = objectResult(
      [
        detection("book", 0.4),
        detection("dog", 0.9),
        detection("cell phone", 0.71234),
        detection("cell phone", 0.29),
        detection("cell phone", 0.5, 0.6),
      ],
      { width: 640, height: 360 },
      { model: "m", classes: ["cell phone", "book"], minScore: 0.3, maxDetections: 2 },
    );
    const [summary, ...objects] = result.observations;
    expect(summary).toEqual({
      type: "OBJECTS",
      detected: true,
      value: 2,
      metadata: { best: { "cell phone": 0.7123 }, model: "m", minScore: 0.3 },
    });
    expect(objects.map((o) => [o.value, o.confidence])).toEqual([
      ["cell phone", 0.7123],
      ["cell phone", 0.5],
    ]);
    expect(objects[0].metadata).toEqual({
      classId: PHONE,
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    });
    expect(result.payload).toMatchObject({
      format: "object-detections",
      imageWidth: 640,
      imageHeight: 360,
      model: "m",
    });
    expect(result.payload.detections).toHaveLength(2);
  });

  it("reports every class when the list is empty, and an empty frame as not detected", () => {
    const all = objectResult(
      [detection("dog", 0.9)],
      { width: 1, height: 1 },
      {
        model: "m",
        classes: [],
        minScore: 0.3,
        maxDetections: 10,
      },
    );
    expect(all.observations[0].metadata.best).toEqual({ dog: 0.9 });
    const none = objectResult(
      [],
      { width: 1, height: 1 },
      {
        model: "m",
        classes: [],
        minScore: 0.3,
        maxDetections: 10,
      },
    );
    expect(none.observations).toEqual([
      {
        type: "OBJECTS",
        detected: false,
        value: 0,
        metadata: { best: {}, model: "m", minScore: 0.3 },
      },
    ]);
  });
});

/** Crops are stand-ins that remember their rectangle; `close` is recorded. */
function fakeCropFrame() {
  return vi.fn(async (frame, rect, size) => ({ crop: rect, size, close: vi.fn() }));
}

/**
 * @param {{ config?: Record<string, unknown>, failGpu?: boolean,
 *   detections?: any[] | ((image: any) => any[]) }} [options] `detections` per call, or per image
 */
function createMediapipe({ config = {}, failGpu = false, detections = [] } = {}) {
  const tasks = [];
  const runtime = {
    version: "fake-mediapipe@1",
    ...fakeModelLoading(),
    createBlankImage: vi.fn((width, height) => ({ blank: true, width, height })),
    cropFrame: fakeCropFrame(),
    createObjectDetector: vi.fn(async (options) => {
      if (failGpu && options.baseOptions.delegate === "GPU") throw new Error("no WebGL2");
      const task = {
        options,
        closed: false,
        calls: [],
        detect(image) {
          task.calls.push({ image });
          if (image.blank) return { detections: [] };
          return { detections: typeof detections === "function" ? detections(image) : detections };
        },
        close() {
          task.closed = true;
        },
      };
      tasks.push(task);
      return task;
    }),
  };
  const engine = new MediapipeObjectDetectorEngine(
    { ...DEFAULT_MEDIAPIPE_OBJECT_CONFIG, zoom: "off", ...config },
    { runtime },
  );
  return { engine, runtime, tasks };
}

const mpDetection = (categoryName, score, box) => ({
  categories: [{ index: -1, score, categoryName }],
  boundingBox: box,
});

describe("MediapipeObjectDetectorEngine", () => {
  it("creates an IMAGE task on the CPU by default, asking for every result above 0.1", async () => {
    const { engine, runtime, tasks } = createMediapipe();
    await engine.initialize();
    expect(runtime.loadModel).toHaveBeenCalledWith(MODEL_ASSETS["mp-effdet-lite0-int8"]);
    expect(tasks[0].options).toMatchObject({
      baseOptions: { delegate: "CPU" },
      runningMode: "IMAGE",
      scoreThreshold: 0.1,
      maxResults: -1,
    });
    expect(tasks[0].calls).toHaveLength(1); // warm-up on a blank image
    expect(engine.getExecutionProvider()).toBe("mediapipe-cpu");
    expect(engine.getModelInfo()).toMatchObject({
      id: "mp-effdet-lite0-int8",
      sha256: MODEL_ASSETS["mp-effdet-lite0-int8"].sha256,
    });
  });

  it("normalizes pixel boxes to the frame, clamps them, and applies the shared filter", async () => {
    const { engine, tasks } = createMediapipe({
      detections: [
        mpDetection("cell phone", 0.8, { originX: 320, originY: 90, width: 160, height: 180 }),
        mpDetection("cell phone", 0.6, { originX: 600, originY: 300, width: 100, height: 100 }),
        mpDetection("dog", 0.9, { originX: 0, originY: 0, width: 10, height: 10 }),
        mpDetection("book", 0.2, { originX: 0, originY: 0, width: 10, height: 10 }),
      ],
    });
    await engine.initialize();
    const frame = createFakeFrame(640, 360);
    const result = await engine.detect(
      frame,
      meta({ width: 640, height: 360, captureTime: 5000.4 }),
    );
    const [summary, first, second] = result.observations;
    expect(summary).toMatchObject({ value: 2, metadata: { best: { "cell phone": 0.8 } } });
    expect(first).toMatchObject({
      value: "cell phone",
      confidence: 0.8,
      metadata: { classId: PHONE, box: { x: 0.5, y: 0.25, width: 0.25, height: 0.5 } },
    });
    // Clamped at the right and bottom edges.
    expect(second.metadata.box).toEqual({ x: 0.9375, y: 0.8333, width: 0.0625, height: 0.1667 });
    expect(tasks[0].calls.at(-1)).toEqual({ image: frame });
  });

  it("zoom pass: runs on the whole frame and two full-resolution squares, maps crop boxes to the frame, merges duplicates", async () => {
    // Lite2 crops are 448 px. A phone at (160, 224) 64×128 in the right crop (x 560–1280) is at
    // (817.1, 360) 102.9×205.7 in the frame; the whole frame sees the same phone with 0.4.
    const phoneInCrop = { originX: 160, originY: 224, width: 64, height: 128 };
    const phoneInFrame = {
      originX: 560 + (160 / 448) * 720,
      originY: (224 / 448) * 720,
      width: (64 / 448) * 720,
      height: (128 / 448) * 720,
    };
    const { engine, runtime, tasks } = createMediapipe({
      config: { model: "mp-effdet-lite2-int8", zoom: "tiles", warmup: false },
      detections: (image) =>
        image.crop
          ? image.crop.x === 560
            ? [mpDetection("cell phone", 0.7, phoneInCrop)]
            : []
          : [mpDetection("cell phone", 0.4, phoneInFrame)],
    });
    await engine.initialize();
    const frame = createFakeFrame(1280, 720);
    const result = await engine.detect(frame, meta());
    expect(
      runtime.cropFrame.mock.calls.map(([f, rect, size]) => [f === frame, rect, size]),
    ).toEqual([
      [true, { x: 0, y: 0, width: 720, height: 720 }, 448],
      [true, { x: 560, y: 0, width: 720, height: 720 }, 448],
    ]);
    expect(tasks[0].calls[0].image).toBe(frame);
    for (const crop of await Promise.all(runtime.cropFrame.mock.results.map((r) => r.value))) {
      expect(crop.close).toHaveBeenCalledTimes(1);
    }
    const [summary, phone] = result.observations;
    expect(summary).toMatchObject({ value: 1, metadata: { best: { "cell phone": 0.7 } } });
    expect(phone.metadata.box.x).toBeCloseTo(phoneInFrame.originX / 1280, 3);
    expect(phone.metadata.box.y).toBeCloseTo(0.5, 3);
    expect(phone.metadata.box.width).toBeCloseTo(phoneInFrame.width / 1280, 3);
    expect(phone.metadata.box.height).toBeCloseTo(phoneInFrame.height / 720, 3);
  });

  it("zoom off: one pass over the whole frame, no crops", async () => {
    const { engine, runtime, tasks } = createMediapipe({ config: { warmup: false } });
    await engine.initialize();
    await engine.detect(createFakeFrame(1280, 720), meta());
    expect(runtime.cropFrame).not.toHaveBeenCalled();
    expect(tasks[0].calls).toHaveLength(1);
  });

  it("falls back to the CPU when the GPU task fails, and reports why", async () => {
    const { engine, tasks } = createMediapipe({ config: { delegate: "GPU" }, failGpu: true });
    await engine.initialize();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].options.baseOptions.delegate).toBe("CPU");
    expect(engine.getStatusDetails()).toMatchObject({
      requestedDelegate: "GPU",
      delegate: "CPU",
      fallbackReason: expect.stringContaining("no WebGL2"),
    });
    const strict = createMediapipe({
      config: { delegate: "GPU", allowCpuFallback: false },
      failGpu: true,
    });
    await expect(strict.engine.initialize()).rejects.toThrow(/no WebGL2/);
  });

  it("recreates the task for a new model or a reporting limit below 0.1, not for other limits", async () => {
    const { engine, tasks } = createMediapipe({ config: { warmup: false } });
    await engine.initialize();
    await engine.onConfigure({ minScore: 0.6, maxDetections: 3 });
    expect(tasks).toHaveLength(1);
    await engine.onConfigure({ minScore: 0.05 });
    expect(tasks).toHaveLength(2);
    expect(tasks[1].options.scoreThreshold).toBe(0.05);
    expect(tasks[0].closed).toBe(true);
    await engine.onConfigure({ model: "mp-effdet-lite2-int8" });
    expect(tasks).toHaveLength(3);
    expect(engine.getModelInfo().id).toBe("mp-effdet-lite2-int8");
  });

  it("refuses a model file whose hash does not match the pin", async () => {
    const { engine, runtime } = createMediapipe();
    runtime.sha256.mockResolvedValue("f".repeat(64));
    await expect(engine.initialize()).rejects.toMatchObject({ code: "MODEL_INTEGRITY" });
  });
});

/** NanoDet outputs (named like the real model) with one phone at the given stride-32 anchor. */
function nanodetOutputs({ col, row, bin, score = 0.8 }) {
  const outputs = {};
  const names = { 8: ["792", "795"], 16: ["814", "817"], 32: ["836", "839"] };
  for (const stride of [8, 16, 32]) {
    const cols = Math.ceil(416 / stride);
    const anchors = cols * cols;
    const scores = new Float32Array(anchors * 80);
    const boxes = new Float32Array(anchors * 32).fill(-100);
    if (stride === 32) {
      const anchor = row * cols + col;
      scores[anchor * 80 + PHONE] = score;
      for (let side = 0; side < 4; side += 1) boxes[anchor * 32 + side * 8 + bin] = 100;
    }
    outputs[names[stride][0]] = { data: scores, dims: [1, anchors, 80] };
    outputs[names[stride][1]] = { data: boxes, dims: [1, anchors, 32] };
  }
  return outputs;
}

function createOnnx({ config = {}, failProviders = [], outputs = () => ({}) } = {}) {
  const sessions = [];
  const runtime = {
    version: "fake-ort@1",
    ...fakeModelLoading(),
    environment: () => ({ numThreads: 4 }),
    createTensor: vi.fn((data, dims) => ({ data, dims })),
    letterboxPixels: vi.fn((_frame, box) => new Uint8ClampedArray(box.size * box.size * 4)),
    cropFrame: fakeCropFrame(),
    createSession: vi.fn(async (bytes, provider, options) => {
      if (failProviders.includes(provider)) throw new Error(`${provider} unavailable`);
      const session = {
        bytes,
        provider,
        options,
        inputNames: ["input.1"],
        outputNames: ["792"],
        released: false,
        feeds: [],
        run: vi.fn(async (feeds) => {
          session.feeds.push(feeds);
          return outputs(bytes.assetId, session.feeds.length);
        }),
        release: vi.fn(async () => {
          session.released = true;
        }),
      };
      sessions.push(session);
      return session;
    }),
  };
  const engine = new OnnxObjectDetectorEngine(
    { ...DEFAULT_ONNX_OBJECT_CONFIG, zoom: "off", ...config },
    { runtime },
  );
  return { engine, runtime, sessions };
}

describe("OnnxObjectDetectorEngine", () => {
  it("creates a WASM session with the configured threads and warms it up at the input size", async () => {
    const { engine, sessions } = createOnnx({ config: { numThreads: 2 } });
    await engine.initialize();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ provider: "wasm", options: { numThreads: 2 } });
    const warmup = sessions[0].feeds[0]["input.1"];
    expect(warmup.dims).toEqual([1, 3, 416, 416]);
    expect(engine.getExecutionProvider()).toBe("ort-wasm");
    expect(engine.getStatusDetails()).toMatchObject({
      provider: "wasm",
      environment: { numThreads: 4 },
    });
  });

  it("letterboxes the frame, decodes NanoDet, and maps the box back to the frame", async () => {
    // Anchor (6, 6) at stride 32: centre 207.5; bin 2 → 64 px to each side.
    const { engine, runtime, sessions } = createOnnx({
      config: { warmup: false },
      outputs: () => nanodetOutputs({ col: 6, row: 6, bin: 2 }),
    });
    await engine.initialize();
    const result = await engine.detect(createFakeFrame(1280, 720), meta());
    const box = runtime.letterboxPixels.mock.calls[0][1];
    expect(box).toMatchObject({ size: 416, width: 416, height: 234, offsetY: 91 });
    expect(sessions[0].feeds[0]["input.1"].dims).toEqual([1, 3, 416, 416]);
    const object = result.observations.find((o) => o.type === "OBJECT");
    expect(object).toMatchObject({ value: "cell phone", confidence: 0.8 });
    const { x, y, width, height } = object.metadata.box;
    expect(x).toBeCloseTo(143.5 / 416, 3);
    expect(width).toBeCloseTo(128 / 416, 3);
    expect(y).toBeCloseTo((143.5 - 91) / 234, 3);
    expect(height).toBeCloseTo(128 / 234, 3);
    expect(result.timings).toHaveProperty("inferenceMs");
  });

  it("zoom pass: letterboxes each crop at the model input, maps its boxes to the frame, closes the crops", async () => {
    // Runs: 1 whole frame, 2 left square, 3 right square (x 560–1280). Only run 3 sees a phone:
    // anchor (6, 6) at stride 32 in the 416 px crop, 143.5–271.5 px.
    const { engine, runtime, sessions } = createOnnx({
      config: { warmup: false, zoom: "tiles" },
      outputs: (_asset, run) =>
        nanodetOutputs({ col: 6, row: 6, bin: 2, score: run === 3 ? 0.8 : 0 }),
    });
    await engine.initialize();
    const frame = createFakeFrame(1280, 720);
    const result = await engine.detect(frame, meta());
    expect(
      runtime.cropFrame.mock.calls.map(([, rect, size]) => [rect.x, rect.width, size]),
    ).toEqual([
      [0, 720, 416],
      [560, 720, 416],
    ]);
    const boxes = runtime.letterboxPixels.mock.calls.map(([, box]) => box);
    expect(boxes[0]).toMatchObject({ width: 416, height: 234, offsetY: 91 });
    expect(boxes[1]).toMatchObject({ width: 416, height: 416, offsetX: 0, offsetY: 0 });
    expect(sessions[0].run).toHaveBeenCalledTimes(3);
    for (const crop of await Promise.all(runtime.cropFrame.mock.results.map((r) => r.value))) {
      expect(crop.close).toHaveBeenCalledTimes(1);
    }
    const objects = result.observations.filter((o) => o.type === "OBJECT");
    expect(objects).toHaveLength(1);
    const { x, y, width, height } = objects[0].metadata.box;
    expect(x).toBeCloseTo((560 + (143.5 / 416) * 720) / 1280, 3);
    expect(width).toBeCloseTo(((128 / 416) * 720) / 1280, 3);
    expect(y).toBeCloseTo(((143.5 / 416) * 720) / 720, 3);
    expect(height).toBeCloseTo(((128 / 416) * 720) / 720, 3);
  });

  it("falls back from WebGPU to WASM unless the fallback is off", async () => {
    const { engine, sessions } = createOnnx({
      config: { executionProvider: "webgpu", warmup: false },
      failProviders: ["webgpu"],
    });
    await engine.initialize();
    expect(sessions.map((s) => s.provider)).toEqual(["wasm"]);
    expect(engine.getStatusDetails().fallbackReason).toMatch(/webgpu unavailable/);
    const strict = createOnnx({
      config: { executionProvider: "webgpu", allowWasmFallback: false, warmup: false },
      failProviders: ["webgpu"],
    });
    await expect(strict.engine.initialize()).rejects.toThrow(/webgpu unavailable/);
  });

  it("swaps the session for a new model, keeps it for NMS or score changes, and refuses thread changes", async () => {
    const { engine, sessions } = createOnnx();
    await engine.initialize();
    await engine.onConfigure({ nmsThreshold: 0.6, minScore: 0.4 });
    expect(sessions).toHaveLength(1);
    await expect(engine.onConfigure({ numThreads: 3 })).rejects.toMatchObject({
      code: "RESTART_REQUIRED",
    });
    await engine.onConfigure({ model: "ocv-yolox-s" });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].released).toBe(true);
    expect(sessions[1].feeds[0]["input.1"].dims).toEqual([1, 3, 640, 640]);
    expect(engine.getModelInfo().id).toBe("ocv-yolox-s");
  });

  it("refuses a model file whose hash does not match the pin", async () => {
    const { engine, runtime } = createOnnx();
    runtime.sha256.mockResolvedValue("f".repeat(64));
    await expect(engine.initialize()).rejects.toMatchObject({ code: "MODEL_INTEGRITY" });
  });
});
