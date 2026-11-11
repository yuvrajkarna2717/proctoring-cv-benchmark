import { describe, expect, it, vi } from "vitest";
import { MODEL_ASSETS } from "../../../src/config/modelAssets.js";
import {
  SFACE_TEMPLATE,
  applyAffine,
  similarityTransform,
  squareCropTransform,
} from "../../../src/engines/verification/alignment.js";
import { FaceVerificationEngine } from "../../../src/engines/verification/FaceVerificationEngine.js";
import { DEFAULT_FACE_VERIFIER_CONFIG } from "../../../src/engines/verification/faceVerifierConfig.js";
import { yunetOutputNames } from "../../../src/engines/verification/yunet.js";
import { createFakeFrame, createMeta, deferred } from "../../helpers/fakes.js";
import { describeGraph, graph, model, node } from "../../helpers/onnxProto.js";

/**
 * A face as YuNet would report it, in detector-input pixels: centre, size, landmarks, score.
 * `anchor()` encodes it at stride 8 the way decodeYunet() reads it back.
 */
function face({ cx, cy, width, height, landmarks, score }) {
  return { cx, cy, width, height, landmarks, score };
}

const FRONTAL = face({
  cx: 320,
  cy: 180,
  width: 100,
  height: 120,
  landmarks: [300, 165, 340, 165, 320, 185, 305, 205, 335, 205],
  score: 0.95,
});

/** Fake YuNet outputs for an input of paddedWidth × paddedHeight with the given faces. */
function yunetOutputs(paddedWidth, paddedHeight, faces) {
  const outputs = {};
  for (const stride of [8, 16, 32]) {
    const anchors = (paddedWidth / stride) * (paddedHeight / stride);
    const [cls, obj, bbox, kps] = yunetOutputNames(stride);
    outputs[cls] = { data: new Float32Array(anchors), dims: [1, anchors, 1] };
    outputs[obj] = { data: new Float32Array(anchors), dims: [1, anchors, 1] };
    outputs[bbox] = { data: new Float32Array(anchors * 4), dims: [1, anchors, 4] };
    outputs[kps] = { data: new Float32Array(anchors * 10), dims: [1, anchors, 10] };
  }
  const stride = 8;
  const cols = paddedWidth / stride;
  const [cls, obj, bbox, kps] = yunetOutputNames(stride);
  for (const f of faces) {
    const col = Math.floor(f.cx / stride);
    const row = Math.floor(f.cy / stride);
    const index = row * cols + col;
    outputs[cls].data[index] = f.score;
    outputs[obj].data[index] = f.score;
    outputs[bbox].data.set(
      [
        f.cx / stride - col,
        f.cy / stride - row,
        Math.log(f.width / stride),
        Math.log(f.height / stride),
      ],
      index * 4,
    );
    outputs[kps].data.set(
      f.landmarks.map((value, i) => value / stride - (i % 2 === 0 ? col : row)),
      index * 10,
    );
  }
  return outputs;
}

/**
 * Fake runtime: sessions record their runs, the detector returns `faces`, the recognizer
 * returns `vector`. Model "bytes" are stand-ins with the pinned size, so the integrity check
 * passes without allocating the real files.
 */
function createFakeRuntime({
  faces = [],
  vector = [3, 4, ...new Array(126).fill(0)],
  failProviders = [],
  hashes = {},
  detectorOutputs = null,
  modelBytes = {},
} = {}) {
  /** @type {any[]} */
  const sessions = [];
  /** @type {any[]} the bytes each createSession call received */
  const sessionBytes = [];
  const runtime = {
    version: "fake-ort@1",
    // Real protobuf bytes from `modelBytes`, else a stand-in object with the pinned size.
    loadModel: vi.fn(async (asset) =>
      modelBytes[asset.id]
        ? Object.assign(modelBytes[asset.id], { assetId: asset.id })
        : { byteLength: asset.bytes, assetId: asset.id },
    ),
    sha256: vi.fn(async (bytes) => hashes[bytes.assetId] ?? MODEL_ASSETS[bytes.assetId].sha256),
    createSession: vi.fn(async (bytes, provider) => {
      if (failProviders.includes(provider)) throw new Error(`${provider} unavailable`);
      sessionBytes.push(bytes);
      const isDetector = bytes.assetId?.startsWith("ocv-yunet") ?? false;
      const session = {
        kind: isDetector ? "detector" : "recognizer",
        model: bytes.assetId,
        provider,
        released: false,
        inputs: [],
        /** set to a promise to hold runs of this session */
        gate: null,
        // Like ONNX Runtime, a session over real bytes lists every declared graph input.
        inputNames: isDetector
          ? ["input"]
          : bytes instanceof Uint8Array
            ? describeGraph(bytes).inputs
            : ["data"],
        outputNames: isDetector
          ? (detectorOutputs ?? [8, 16, 32].flatMap((stride) => yunetOutputNames(stride)))
          : ["fc1"],
        async run(feeds) {
          const tensor = feeds[this.inputNames[0]];
          this.inputs.push(tensor);
          if (this.gate) await this.gate;
          if (isDetector) {
            const [, , height, width] = tensor.dims;
            return yunetOutputs(width, height, faces);
          }
          return { fc1: { data: Float32Array.from(vector), dims: [1, vector.length] } };
        },
        async release() {
          this.released = true;
        },
      };
      sessions.push(session);
      return session;
    }),
    createTensor: (data, dims) => ({ data: Float32Array.from(data), dims }),
    environment: () => ({ numThreads: 4, crossOriginIsolated: true, webgpuAvailable: true }),
    image: {
      assertSupported: vi.fn(),
      detectorInput: vi.fn((_frame, input) =>
        new Uint8ClampedArray(input.paddedWidth * input.paddedHeight * 4).fill(10),
      ),
      warp: vi.fn((_frame, _matrix, size) => new Uint8ClampedArray(size * size * 4).fill(128)),
    },
  };
  return { runtime, sessions, sessionBytes };
}

/**
 * A synthetic recognizer with the int8bq defect (an unread float weight declared as a graph
 * input), padded with a doc string to the pinned size of `assetId` so the size check passes.
 *
 * @param {string} assetId
 */
function staleInputModel(assetId) {
  const g = graph({
    nodes: [
      node({ inputs: ["w_q", "w_scale"], outputs: ["w_dq"], op: "DequantizeLinear" }),
      node({ inputs: ["data", "w_dq"], outputs: ["fc1"], op: "Conv" }),
    ],
    initializers: ["w_q", "w_scale"],
    inputs: ["data", "conv_1_conv2d_weight"],
    outputs: ["fc1"],
  });
  const base = model(g, { docString: "" }).length;
  // A doc string of about 10 MB needs a 4-byte length varint instead of 1 byte.
  return model(g, { docString: "x".repeat(MODEL_ASSETS[assetId].bytes - base - 3) });
}

/**
 * The general tests use fp32 SFace, whose stand-in bytes need no parsing. The default (int8bq)
 * is tested with real protobuf bytes in its own test.
 */
async function createEngine(config = {}, runtimeOptions = {}) {
  const fake = createFakeRuntime(runtimeOptions);
  const engine = new FaceVerificationEngine(
    { ...DEFAULT_FACE_VERIFIER_CONFIG, recognizerModel: "ocv-sface", ...config },
    { runtime: fake.runtime },
  );
  return { engine, ...fake };
}

const meta = (overrides = {}) =>
  createMeta({ width: 1280, height: 720, sourceWidth: 1280, sourceHeight: 720, ...overrides });

describe("FaceVerificationEngine initialization", () => {
  it("verifies both models, opens sessions on the requested provider, and warms them up", async () => {
    const { engine, runtime, sessions } = await createEngine();
    await engine.initialize();
    expect(runtime.loadModel.mock.calls.map(([asset]) => asset.id)).toEqual([
      "ocv-yunet-2026may",
      "ocv-sface",
    ]);
    expect(sessions.map((s) => [s.kind, s.provider])).toEqual([
      ["detector", "wasm"],
      ["recognizer", "wasm"],
    ]);
    // One warm-up run each: a 16:9 detector input, and the synthetic self-check input.
    expect(sessions[0].inputs.map((t) => t.dims)).toEqual([[1, 3, 384, 640]]);
    expect(sessions[1].inputs.map((t) => t.dims)).toEqual([[1, 3, 112, 112]]);
    const status = engine.getStatus();
    expect(status.executionProvider).toBe("ort-wasm");
    expect(status.model.components).toEqual([
      expect.objectContaining({
        id: "ocv-yunet-2026may",
        sha256: MODEL_ASSETS["ocv-yunet-2026may"].sha256,
      }),
      expect.objectContaining({ id: "ocv-sface", sha256: MODEL_ASSETS["ocv-sface"].sha256 }),
    ]);
    expect(status.initTimings).toMatchObject({
      modelFetchMs: expect.any(Number),
      modelInitMs: expect.any(Number),
      warmupMs: expect.any(Number),
    });
    const { selfCheck } = status.details;
    expect(selfCheck.embedding).toHaveLength(128);
    expect(selfCheck.embedding.slice(0, 2)).toEqual([0.6, 0.8]);
  });

  it("rejects a model whose hash does not match, before creating any session", async () => {
    const { engine, sessions } = await createEngine(
      {},
      { hashes: { "ocv-sface": "0".repeat(64) } },
    );
    await expect(engine.initialize()).rejects.toMatchObject({ code: "MODEL_INTEGRITY" });
    expect(sessions).toHaveLength(0);
  });

  it("falls back to WASM when WebGPU fails and reports why", async () => {
    const { engine, sessions } = await createEngine(
      { executionProvider: "webgpu" },
      { failProviders: ["webgpu"] },
    );
    await engine.initialize();
    expect(engine.getExecutionProvider()).toBe("ort-wasm");
    expect(engine.getStatus().details).toMatchObject({
      requestedProvider: "webgpu",
      provider: "wasm",
      fallbackReason: expect.stringContaining("webgpu unavailable"),
    });
    expect(sessions.every((s) => s.provider === "wasm")).toBe(true);
  });

  it("fails instead of falling back when allowWasmFallback is off", async () => {
    const { engine } = await createEngine(
      { executionProvider: "webgpu", allowWasmFallback: false },
      { failProviders: ["webgpu"] },
    );
    await expect(engine.initialize()).rejects.toThrow(/webgpu unavailable/);
  });

  it("rejects a detector without YuNet's outputs and releases the opened sessions", async () => {
    const { engine, sessions } = await createEngine({}, { detectorOutputs: ["cls_8", "obj_8"] });
    await expect(engine.initialize()).rejects.toMatchObject({ code: "MODEL_SIGNATURE" });
    expect(sessions.every((s) => s.released)).toBe(true);
  });

  it("drops unread graph inputs of the block-quantized recognizer after the hash check", async () => {
    expect(DEFAULT_FACE_VERIFIER_CONFIG.recognizerModel).toBe("ocv-sface-int8bq");
    const bytes = staleInputModel("ocv-sface-int8bq");
    expect(describeGraph(bytes).inputs).toEqual(["data", "conv_1_conv2d_weight"]);
    const { engine, runtime, sessionBytes } = await createEngine(
      { recognizerModel: "ocv-sface-int8bq" },
      { modelBytes: { "ocv-sface-int8bq": bytes } },
    );
    await engine.initialize();
    // The hash was computed over the pinned bytes, not the pruned copy.
    expect(runtime.sha256.mock.calls.map(([b]) => b.assetId)).toContain("ocv-sface-int8bq");
    // Only the recognizer session is asked to fold the weight dequantization.
    expect(runtime.createSession.mock.calls.map(([, , o]) => o.foldWeightDequantization)).toEqual([
      undefined,
      true,
    ]);
    const recognizerBytes = sessionBytes[1];
    expect(recognizerBytes).not.toBe(bytes);
    expect(describeGraph(recognizerBytes)).toMatchObject({ inputs: ["data"], nodes: 2 });
    expect(engine.getStatus().model.components[1]).toEqual(
      expect.objectContaining({
        id: "ocv-sface-int8bq",
        sha256: MODEL_ASSETS["ocv-sface-int8bq"].sha256,
        prunedGraphInputs: 1,
      }),
    );
    // The fp32 model is passed through untouched and reports nothing pruned.
    const fp32 = await createEngine();
    await fp32.engine.initialize();
    expect(fp32.sessionBytes[1]).toEqual({
      byteLength: MODEL_ASSETS["ocv-sface"].bytes,
      assetId: "ocv-sface",
    });
    expect(fp32.engine.getStatus().model.components[1]).not.toHaveProperty("prunedGraphInputs");
    expect(fp32.runtime.createSession.mock.calls[1][2].foldWeightDequantization).toBe(false);
    // Building and parsing a 10 MB synthetic model can exceed the default 5 s when the other
    // test files run in parallel.
  }, 20_000);

  it("skips the warm-up when disabled", async () => {
    const { engine, sessions } = await createEngine({ warmup: false });
    await engine.initialize();
    expect(sessions.every((s) => s.inputs.length === 0)).toBe(true);
    expect(engine.getStatus().details.selfCheck).toBeNull();
  });
});

describe("FaceVerificationEngine detection", () => {
  it("reports faces in frame coordinates and embeds the face with quality measurements", async () => {
    const { engine, runtime, sessions } = await createEngine({}, { faces: [FRONTAL] });
    await engine.initialize();
    const frame = createFakeFrame(1280, 720);
    const result = await engine.detect(frame, meta());

    // 1280×720 is scaled by 0.5 to 640×360 and padded to 640×384 for the detector.
    expect(runtime.image.detectorInput).toHaveBeenCalledWith(frame, {
      width: 640,
      height: 360,
      paddedWidth: 640,
      paddedHeight: 384,
      scaleX: 0.5,
      scaleY: 0.5,
    });
    expect(sessions[0].inputs.at(-1).data.slice(0, 3)).toEqual(new Float32Array([10, 10, 10]));

    const [count, faceObservation, embeddingObservation] = result.observations;
    expect(count).toEqual({
      type: "FACE_COUNT",
      detected: true,
      value: 1,
      metadata: { maxFaces: 5 },
    });
    expect(faceObservation).toMatchObject({
      type: "FACE",
      confidence: expect.closeTo(0.95, 5),
      value: 0,
    });
    const { box } = faceObservation.metadata;
    expect(box.x).toBeCloseTo(540 / 1280, 5);
    expect(box.y).toBeCloseTo(240 / 720, 5);
    expect(box.width).toBeCloseTo(200 / 1280, 5);
    expect(box.height).toBeCloseTo(240 / 720, 5);
    expect(faceObservation.metadata).toMatchObject({ truncated: false, embedded: true });

    expect(embeddingObservation).toMatchObject({
      type: "FACE_EMBEDDING",
      value: 0,
      metadata: {
        source: "face",
        recognizer: "ocv-sface",
        dimensions: 128,
        quality: {
          brightness: 128,
          sharpness: 0,
          interEyePx: 80,
          rollDeg: 0,
          yawRatio: 0,
          faceWidthPx: 200,
          faceHeightPx: 240,
          inFrame: true,
        },
      },
    });

    // The crop is aligned from the full-resolution frame with the landmarks in frame pixels
    // (detector pixels ÷ 0.5), not with the detector's downscaled coordinates.
    const [warpFrame, matrix, size] = runtime.image.warp.mock.calls.at(-1);
    expect(warpFrame).toBe(frame);
    expect(size).toBe(112);
    const expected = similarityTransform([600, 330, 680, 330, 640, 370, 610, 410, 670, 410]);
    matrix.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 4));
    const [noseX, noseY] = applyAffine(matrix, 640, 370);
    expect(Math.hypot(noseX - SFACE_TEMPLATE[4], noseY - SFACE_TEMPLATE[5])).toBeLessThan(4);

    const { payload } = result;
    expect(payload.format).toBe("face-verifier");
    expect(payload.faces[0].landmarks).toBeInstanceOf(Float32Array);
    expect(payload.faces[0].landmarks[0]).toBeCloseTo(600 / 1280, 5);
    expect(payload.embedding).toMatchObject({
      faceIndex: 0,
      source: "face",
      recognizer: "ocv-sface",
    });
    expect(payload.embedding.vector).toBeInstanceOf(Float32Array);
    expect(Array.from(payload.embedding.vector.slice(0, 2))).toEqual([
      expect.closeTo(0.6, 6),
      expect.closeTo(0.8, 6),
    ]);
    expect(Object.keys(result.timings.breakdownMs).sort()).toEqual([
      "alignMs",
      "detectorMs",
      "recognizerMs",
    ]);
  });

  it("embeds the largest face, not the best-scored one, and limits faces to maxFaces", async () => {
    const small = face({ ...FRONTAL, cx: 100, cy: 100, width: 40, height: 48, score: 0.99 });
    const large = { ...FRONTAL, score: 0.92 };
    const tiny = face({ ...FRONTAL, cx: 560, cy: 300, width: 24, height: 28, score: 0.91 });
    const { engine } = await createEngine({ maxFaces: 2 }, { faces: [small, large, tiny] });
    await engine.initialize();
    const result = await engine.detect(createFakeFrame(1280, 720), meta());
    const faceObservations = result.observations.filter((o) => o.type === "FACE");
    expect(result.observations[0].value).toBe(2);
    expect(faceObservations.map((o) => o.metadata.embedded)).toEqual([false, true]);
    expect(result.payload.embedding.faceIndex).toBe(1);
  });

  it("embeds nothing without a face, unless the center-crop diagnostic is on", async () => {
    const { engine, sessions } = await createEngine();
    await engine.initialize();
    const recognizer = sessions[1];
    const none = await engine.detect(createFakeFrame(1280, 720), meta());
    expect(none.observations).toEqual([
      { type: "FACE_COUNT", detected: false, value: 0, metadata: { maxFaces: 5 } },
    ]);
    expect(none.payload.embedding).toBeNull();
    expect(recognizer.inputs).toHaveLength(1); // the warm-up only

    await engine.configure({ embedWhenNoFace: true });
    const crop = await engine.detect(createFakeFrame(1280, 720), meta());
    expect(crop.payload.embedding).toMatchObject({ faceIndex: -1, source: "center-crop" });
    expect(crop.observations.at(-1).metadata.quality).toEqual({ brightness: 128, sharpness: 0 });
    expect(recognizer.inputs).toHaveLength(2);
  });

  it("uses a centred square of the frame for the center-crop diagnostic", async () => {
    const { engine, runtime } = await createEngine({ embedWhenNoFace: true });
    await engine.initialize();
    await engine.detect(createFakeFrame(1280, 720), meta());
    expect(runtime.image.warp.mock.calls.at(-1)[1]).toEqual(squareCropTransform(280, 0, 720));
  });

  it("runs detection only when embedding is off", async () => {
    const { engine, sessions } = await createEngine({ embedFaces: "none" }, { faces: [FRONTAL] });
    await engine.initialize();
    const result = await engine.detect(createFakeFrame(1280, 720), meta());
    expect(result.observations.map((o) => o.type)).toEqual(["FACE_COUNT", "FACE"]);
    expect(sessions[1].inputs).toHaveLength(1);
  });

  it("omits landmarks when includeLandmarks is off", async () => {
    const { engine } = await createEngine({ includeLandmarks: false }, { faces: [FRONTAL] });
    await engine.initialize();
    const result = await engine.detect(createFakeFrame(1280, 720), meta());
    expect(result.payload.faces[0].landmarks).toBeNull();
  });

  it("rejects a recognizer output that is not a 128-value embedding", async () => {
    const { engine } = await createEngine(
      { warmup: false },
      { faces: [FRONTAL], vector: [1, 2, 3] },
    );
    await engine.initialize();
    await expect(engine.detect(createFakeFrame(1280, 720), meta())).rejects.toMatchObject({
      code: "MODEL_OUTPUT_SHAPE",
    });
  });
});

describe("FaceVerificationEngine configuration and disposal", () => {
  it("applies thresholds live and recreates sessions only for provider or model changes", async () => {
    const { engine, sessions } = await createEngine();
    await engine.initialize();
    await engine.configure({ scoreThreshold: 0.6, maxFaces: 2 });
    expect(sessions).toHaveLength(2);

    await engine.configure({ executionProvider: "webgpu" });
    expect(sessions).toHaveLength(4);
    expect(sessions.slice(0, 2).every((s) => s.released)).toBe(true);
    expect(engine.getExecutionProvider()).toBe("ort-webgpu");

    await engine.configure({ recognizerModel: "ocv-sface-int8" });
    expect(sessions.at(-1)).toMatchObject({ kind: "recognizer", model: "ocv-sface-int8" });
    expect(engine.getModelInfo().id).toBe("ocv-yunet-2026may+ocv-sface-int8");
  });

  it("keeps the working sessions and configuration when the new sessions fail", async () => {
    const { engine, sessions } = await createEngine({}, { failProviders: ["webgpu"] });
    await engine.initialize();
    await expect(
      engine.configure({ executionProvider: "webgpu", allowWasmFallback: false }),
    ).rejects.toThrow(/webgpu unavailable/);
    expect(sessions.every((s) => !s.released)).toBe(true);
    expect(engine.config).toMatchObject({ executionProvider: "wasm", allowWasmFallback: true });
    expect(engine.getExecutionProvider()).toBe("ort-wasm");
  });

  it("keeps serving frames on the old sessions during a switch and releases them afterwards", async () => {
    const { engine, sessions } = await createEngine({}, { faces: [FRONTAL] });
    await engine.initialize();
    const hold = deferred();
    sessions[0].gate = hold.promise;
    // The worker host starts a configure only when no frame is running; frames that arrive
    // while the new sessions are being created run on the old ones.
    const configured = engine.configure({ executionProvider: "webgpu" });
    const frame = engine.detect(createFakeFrame(1280, 720), meta());
    await vi.waitFor(() => expect(sessions).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sessions[0].released).toBe(false);
    expect(engine.getExecutionProvider()).toBe("ort-webgpu");
    hold.resolve();
    await expect(frame).resolves.toMatchObject({ observations: expect.any(Array) });
    await configured;
    expect(sessions.slice(0, 2).every((s) => s.released)).toBe(true);
    expect(sessions.slice(2).every((s) => !s.released)).toBe(true);
  });

  it("refuses a second model or provider change while one is in progress", async () => {
    const { engine, sessions } = await createEngine();
    await engine.initialize();
    const first = engine.configure({ executionProvider: "webgpu" });
    await expect(engine.configure({ recognizerModel: "ocv-sface-int8" })).rejects.toMatchObject({
      code: "BUSY",
    });
    await first;
    expect(sessions).toHaveLength(4);
  });

  it("requires a restart to change the thread count", async () => {
    const { engine } = await createEngine();
    await engine.initialize();
    await expect(engine.configure({ numThreads: 2 })).rejects.toMatchObject({
      code: "RESTART_REQUIRED",
    });
  });

  it("validates its configuration and requires a runtime", () => {
    const { runtime } = createFakeRuntime();
    expect(
      () =>
        new FaceVerificationEngine(
          { ...DEFAULT_FACE_VERIFIER_CONFIG, scoreThreshold: 2 },
          { runtime },
        ),
    ).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => new FaceVerificationEngine(DEFAULT_FACE_VERIFIER_CONFIG)).toThrow(
      expect.objectContaining({ code: "RUNTIME_MISSING" }),
    );
  });

  it("releases both sessions on dispose", async () => {
    const { engine, sessions } = await createEngine();
    await engine.initialize();
    await engine.dispose();
    expect(sessions.every((s) => s.released)).toBe(true);
    expect(engine.getExecutionProvider()).toBeNull();
  });
});
