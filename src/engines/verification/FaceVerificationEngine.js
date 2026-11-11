import { MODEL_ASSETS } from "../../config/modelAssets.js";
import { EngineBusyError, LabError, describeError } from "../../utils/errors.js";
import { parseConfig } from "../../utils/validation.js";
import { BaseDetectionEngine } from "../BaseDetectionEngine.js";
import { assertModelIntegrity } from "../modelFiles.js";
import { SFACE_CROP_SIZE, similarityTransform, squareCropTransform } from "./alignment.js";
import { FaceVerifierConfigSchema } from "./faceVerifierConfig.js";
import { pruneUnusedGraphInputs } from "./onnxGraph.js";
import { landmarkGeometry, laplacianVariance, lumaFromRgba, mean } from "./quality.js";
import { SFACE_EMBEDDING_SIZE, l2Normalize, rgbaToRgbPlanar } from "./sface.js";
import {
  YUNET_STRIDES,
  decodeYunet,
  detectorInputSize,
  rgbaToBgrPlanar,
  yunetOutputNames,
} from "./yunet.js";

/** Options that need new ONNX Runtime sessions. Others apply from the next frame. */
const SESSION_OPTIONS = /** @type {const} */ ([
  "executionProvider",
  "allowWasmFallback",
  "detectorModel",
  "recognizerModel",
]);

/** Options ONNX Runtime fixes when the worker creates its first session. */
const STARTUP_OPTIONS = /** @type {const} */ (["numThreads"]);

/**
 * Warm-up assumes a 16:9 camera. With another aspect ratio the first frame has a new input
 * shape, which WebGPU compiles on that frame.
 */
const WARMUP_FRAME = { width: 1280, height: 720 };
const SELF_CHECK_INPUT = "synthetic pattern ((i × 37) mod 255) in a 1×3×112×112 tensor";

/**
 * @typedef {import('../../config/modelAssets.js').ModelAsset} ModelAsset
 *
 * @typedef {{ data: ArrayLike<number>, dims: readonly number[] }} OrtTensorLike
 *
 * @typedef {Object} OrtSession the subset of ort.InferenceSession that is used
 * @property {readonly string[]} inputNames
 * @property {readonly string[]} outputNames
 * @property {(feeds: Record<string, unknown>) => Promise<Record<string, OrtTensorLike>>} run
 * @property {() => Promise<void>} release
 *
 * @typedef {'wasm' | 'webgpu'} OrtProvider
 *
 * @typedef {Object} SessionCreateOptions
 * @property {number} numThreads
 * @property {boolean=} foldWeightDequantization see ModelAsset.foldWeightDequantization
 *
 * Operations the engine needs from ONNX Runtime, the network, and the canvas. The worker injects
 * the real implementation (ortRuntime.js); unit tests inject fakes.
 *
 * @typedef {Object} FaceVerifierRuntime
 * @property {string} version runtime identity, e.g. "onnxruntime-web@1.31.1"
 * @property {(asset: ModelAsset) => Promise<Uint8Array>} loadModel
 * @property {(bytes: Uint8Array) => Promise<string>} sha256 lowercase hex digest
 * @property {(bytes: Uint8Array, provider: OrtProvider, options: SessionCreateOptions) => Promise<OrtSession>} createSession
 * @property {(data: Float32Array, dims: number[]) => unknown} createTensor
 * @property {() => { numThreads: number | null, crossOriginIsolated: boolean, webgpuAvailable: boolean }} environment
 * @property {import('./canvasImageOps.js').ImageOps} image
 *
 * @typedef {Object} FrameFace a detected face in frame pixels (the transferred image)
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} score
 * @property {number[]} landmarks right eye, left eye, nose tip, right and left mouth corner
 *
 * @typedef {Object} FaceQuality measurements of the embedded face (see quality.js)
 * @property {number} brightness mean Rec. 709 luma of the 112×112 aligned crop, 0–255
 * @property {number} sharpness Laplacian variance of that crop
 * @property {number=} score detector score
 * @property {number=} interEyePx distance between the eyes in frame pixels
 * @property {number=} rollDeg
 * @property {number=} yawRatio nose offset from the eye midpoint along the eye line, in eye
 *   distances (about 0 when frontal)
 * @property {number=} faceWidthPx
 * @property {number=} faceHeightPx
 * @property {number=} faceWidthRatio face width / frame width
 * @property {boolean=} inFrame the whole face box lies inside the frame
 *
 * @typedef {Object} FaceVerifierPayload engine-specific payload of a face-verifier result
 * @property {'face-verifier'} format
 * @property {number} imageWidth
 * @property {number} imageHeight
 * @property {Array<{ box: { x: number, y: number, width: number, height: number },
 *   score: number, landmarks: Float32Array | null }>} faces landmarks normalized to the image
 * @property {{ faceIndex: number, source: 'face' | 'center-crop', recognizer: string,
 *   vector: Float32Array } | null} embedding L2-normalized SFace embedding of the largest face
 *
 * @typedef {{ detector: OrtSession, recognizer: OrtSession, provider: OrtProvider }} SessionSet
 *
 * @typedef {{ input: string, recognizer: string, embedding: number[] }} SelfCheck embedding of
 *   a fixed synthetic input, for comparing providers and machines
 *
 * @typedef {Object} SessionCreation
 * @property {SessionSet} sessions
 * @property {SelfCheck | null} selfCheck
 * @property {string | null} fallbackReason
 * @property {{ provider: OrtProvider, createMs: number, detectorCreateMs: number,
 *   recognizerCreateMs: number, warmupMs: number | null }} record
 *
 * @typedef {Object} EmbeddingResult
 * @property {'face' | 'center-crop'} source
 * @property {number} faceIndex -1 for a center crop
 * @property {Float32Array} vector L2-normalized
 * @property {FaceQuality} quality
 */

/**
 * Face verification engine: YuNet finds faces, the largest face is aligned to a 112×112 crop
 * with a five-point similarity transform, and SFace computes a 128-value embedding. Both models
 * run on ONNX Runtime Web, on the WASM (CPU) or WebGPU execution provider.
 *
 * Observations per frame:
 * - `FACE_COUNT`: faces found by YuNet (at most `maxFaces`).
 * - `FACE` per face: normalized box, detector score as `confidence` (not a probability), and
 *   whether this face was embedded.
 * - `FACE_EMBEDDING` when a face was embedded: quality measurements and the recognizer id. The
 *   embedding itself travels in the payload (transferred). Comparing it with a reference is the
 *   main thread's job; the engine never sees enrolled data.
 */
export class FaceVerificationEngine extends BaseDetectionEngine {
  static kind = "face-verifier";

  /** @type {import('./faceVerifierConfig.js').FaceVerifierConfig} */
  #options;
  /** @type {FaceVerifierRuntime} */
  #runtime;
  /** @type {SessionSet | null} */
  #sessions = null;
  /** @type {string | null} why the requested WebGPU provider was not used */
  #fallbackReason = null;
  /** @type {Record<string, unknown> | null} */
  #lastSessionCreation = null;
  /** @type {SelfCheck | null} */
  #selfCheck = null;
  /** @type {Map<string, string>} asset id → verified SHA-256 */
  #modelHashes = new Map();
  /** @type {Map<string, number>} asset id → graph inputs dropped by pruneUnusedGraphInputs */
  #prunedInputs = new Map();
  /** @type {Promise<void> | null} settles when the frame in progress settles */
  #inFlight = null;
  #reconfiguring = false;
  /** @type {Float32Array | null} reused detector input */
  #detectorBuffer = null;
  #cropBuffer = new Float32Array(3 * SFACE_CROP_SIZE * SFACE_CROP_SIZE);

  /**
   * @param {Record<string, unknown>} config
   * @param {{ now?: () => number, runtime?: FaceVerifierRuntime }} [dependencies]
   */
  constructor(config, { runtime, ...dependencies } = {}) {
    const options = parseConfig(FaceVerifierConfigSchema, config, "face verifier configuration");
    super(options, dependencies);
    if (!runtime) {
      throw new LabError("FaceVerificationEngine needs an ONNX Runtime runtime", {
        code: "RUNTIME_MISSING",
      });
    }
    this.#options = options;
    this.#runtime = runtime;
  }

  async onInitialize() {
    this.#runtime.image.assertSupported();
    const fetchStartedAt = this.now();
    const models = await this.#loadModels(this.#options);
    const modelFetchMs = this.now() - fetchStartedAt;
    const creation = await this.#createSessions(this.#options, models);
    this.#adopt(creation);
    return {
      modelFetchMs,
      modelInitMs: creation.record.createMs,
      ...(creation.record.warmupMs === null ? {} : { warmupMs: creation.record.warmupMs }),
    };
  }

  /**
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('../EngineContract.js').FrameMeta} meta
   * @param {import('../EngineContract.js').StageTimer} timer
   */
  async onDetect(frame, meta, timer) {
    const run = this.#detectWith(
      /** @type {SessionSet} */ (this.#sessions),
      this.#options,
      frame,
      meta,
      timer,
    );
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlight = settled;
    try {
      return await run;
    } finally {
      if (this.#inFlight === settled) this.#inFlight = null;
    }
  }

  /** @param {Record<string, unknown>} patch */
  async onConfigure(patch) {
    const next = parseConfig(
      FaceVerifierConfigSchema,
      { ...this.#options, ...patch },
      "face verifier configuration",
    );
    const previous = this.#options;
    const startupChanges = STARTUP_OPTIONS.filter((key) => next[key] !== previous[key]);
    if (startupChanges.length > 0) {
      throw new LabError(
        `${startupChanges.join(", ")} takes effect when the worker starts: unload the engine, change it, and load the engine again`,
        { code: "RESTART_REQUIRED" },
      );
    }
    if (!SESSION_OPTIONS.some((key) => next[key] !== previous[key])) {
      this.#options = next;
      return { ...next };
    }
    if (this.#reconfiguring) {
      throw new EngineBusyError("A model or provider change is still in progress", {
        code: "BUSY",
      });
    }
    this.#reconfiguring = true;
    try {
      // The current sessions keep serving frames until the new ones are ready.
      const models = await this.#loadModels(next);
      const creation = await this.#createSessions(next, models);
      const replaced = this.#sessions;
      this.#adopt(creation);
      this.#options = next;
      // A frame that started on the old sessions finishes on them before they are released.
      await this.#inFlight;
      await releaseSessions(replaced);
    } finally {
      this.#reconfiguring = false;
    }
    return { ...next };
  }

  async onDispose() {
    await this.#inFlight;
    const sessions = this.#sessions;
    this.#sessions = null;
    await releaseSessions(sessions);
  }

  getModelInfo() {
    const detector = MODEL_ASSETS[this.#options.detectorModel];
    const recognizer = MODEL_ASSETS[this.#options.recognizerModel];
    /** @param {ModelAsset} asset */
    const component = (asset) => ({
      id: asset.id,
      version: asset.version,
      file: asset.file,
      ...(this.#modelHashes.has(asset.id) ? { sha256: this.#modelHashes.get(asset.id) } : {}),
      ...(this.#prunedInputs.has(asset.id)
        ? { prunedGraphInputs: this.#prunedInputs.get(asset.id) }
        : {}),
    });
    return {
      id: `${detector.id}+${recognizer.id}`,
      version: `${detector.version}+${recognizer.version}`,
      runtime: this.#runtime.version,
      components: [component(detector), component(recognizer)],
    };
  }

  getExecutionProvider() {
    return this.#sessions ? `ort-${this.#sessions.provider}` : null;
  }

  getStatusDetails() {
    return {
      requestedProvider: this.#options.executionProvider,
      provider: this.#sessions?.provider ?? null,
      fallbackReason: this.#fallbackReason,
      lastSessionCreation: this.#lastSessionCreation,
      environment: this.#runtime.environment(),
      selfCheck: this.#selfCheck,
    };
  }

  /**
   * @param {SessionSet} sessions
   * @param {import('./faceVerifierConfig.js').FaceVerifierConfig} options
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('../EngineContract.js').FrameMeta} meta
   * @param {import('../EngineContract.js').StageTimer} timer
   */
  async #detectWith(sessions, options, frame, meta, timer) {
    const { detector } = sessions;

    timer.start("preprocess");
    const input = detectorInputSize(meta.width, meta.height, options.detectorInputWidth);
    const rgba = this.#runtime.image.detectorInput(frame, input);
    const values = 3 * input.paddedWidth * input.paddedHeight;
    if (this.#detectorBuffer?.length !== values) this.#detectorBuffer = new Float32Array(values);
    const detectorTensor = this.#runtime.createTensor(
      rgbaToBgrPlanar(rgba, input.paddedWidth, input.paddedHeight, this.#detectorBuffer),
      [1, 3, input.paddedHeight, input.paddedWidth],
    );

    timer.start("inference");
    const detectorStartedAt = this.now();
    const detected = await detector.run({ [detector.inputNames[0]]: detectorTensor });
    timer.record("detectorMs", this.now() - detectorStartedAt);

    timer.start("postprocess");
    const faces = decodeYunet(detected, {
      paddedWidth: input.paddedWidth,
      paddedHeight: input.paddedHeight,
      scoreThreshold: options.scoreThreshold,
      nmsThreshold: options.nmsThreshold,
      topK: options.topK,
    })
      .slice(0, options.maxFaces)
      .map((face) => toFramePixels(face, input.scaleX, input.scaleY));

    /** @type {EmbeddingResult | null} */
    let embedding = null;
    if (options.embedFaces === "largest") {
      if (faces.length > 0) {
        const faceIndex = largestFace(faces);
        const matrix = similarityTransform(faces[faceIndex].landmarks);
        if (matrix) {
          embedding = await this.#embed(sessions, frame, matrix, timer, {
            source: "face",
            faceIndex,
            face: faces[faceIndex],
            meta,
          });
        }
      } else if (options.embedWhenNoFace) {
        const side = Math.min(meta.width, meta.height);
        const matrix = squareCropTransform((meta.width - side) / 2, (meta.height - side) / 2, side);
        embedding = await this.#embed(sessions, frame, matrix, timer, {
          source: "center-crop",
          faceIndex: -1,
          face: null,
          meta,
        });
      }
    }

    timer.start("postprocess");
    const embeddedIndex = embedding?.faceIndex ?? -1;
    /** @type {import('../EngineContract.js').Observation[]} */
    const observations = [
      {
        type: "FACE_COUNT",
        detected: faces.length > 0,
        value: faces.length,
        metadata: { maxFaces: options.maxFaces },
      },
      ...faces.map((face, index) => ({
        type: "FACE",
        detected: true,
        confidence: face.score,
        value: index,
        metadata: { ...normalizedBox(face, meta), embedded: index === embeddedIndex },
      })),
    ];
    if (embedding) {
      observations.push({
        type: "FACE_EMBEDDING",
        detected: true,
        value: embedding.faceIndex,
        metadata: {
          source: embedding.source,
          recognizer: options.recognizerModel,
          dimensions: embedding.vector.length,
          quality: embedding.quality,
        },
      });
    }
    /** @type {FaceVerifierPayload} */
    const payload = {
      format: "face-verifier",
      imageWidth: meta.width,
      imageHeight: meta.height,
      faces: faces.map((face) => ({
        box: normalizedBox(face, meta).box,
        score: face.score,
        landmarks: options.includeLandmarks
          ? Float32Array.from(face.landmarks, (value, index) =>
              index % 2 === 0 ? value / meta.width : value / meta.height,
            )
          : null,
      })),
      embedding: embedding
        ? {
            faceIndex: embedding.faceIndex,
            source: embedding.source,
            recognizer: options.recognizerModel,
            vector: embedding.vector,
          }
        : null,
    };
    return { observations, payload };
  }

  /**
   * Aligns one face (or a square of the frame), runs SFace, and measures the crop.
   *
   * @param {SessionSet} sessions
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('./alignment.js').AffineMatrix} matrix frame pixels → crop pixels
   * @param {import('../EngineContract.js').StageTimer} timer
   * @param {{ source: 'face' | 'center-crop', faceIndex: number, face: FrameFace | null,
   *   meta: import('../EngineContract.js').FrameMeta }} info
   * @returns {Promise<EmbeddingResult>}
   */
  async #embed(sessions, frame, matrix, timer, { source, faceIndex, face, meta }) {
    const { recognizer } = sessions;
    timer.start("preprocess");
    const alignStartedAt = this.now();
    const rgba = this.#runtime.image.warp(frame, matrix, SFACE_CROP_SIZE);
    const tensor = this.#runtime.createTensor(
      rgbaToRgbPlanar(rgba, SFACE_CROP_SIZE, SFACE_CROP_SIZE, this.#cropBuffer),
      [1, 3, SFACE_CROP_SIZE, SFACE_CROP_SIZE],
    );
    timer.record("alignMs", this.now() - alignStartedAt);

    timer.start("inference");
    const recognizerStartedAt = this.now();
    const outputs = await recognizer.run({ [recognizer.inputNames[0]]: tensor });
    timer.record("recognizerMs", this.now() - recognizerStartedAt);

    timer.start("postprocess");
    const vector = embeddingFrom(outputs[recognizer.outputNames[0]]);
    const luma = lumaFromRgba(rgba, SFACE_CROP_SIZE, SFACE_CROP_SIZE);
    /** @type {FaceQuality} */
    const quality = {
      brightness: round(mean(luma), 2),
      sharpness: round(laplacianVariance(luma, SFACE_CROP_SIZE, SFACE_CROP_SIZE), 2),
    };
    if (face) {
      const geometry = landmarkGeometry(face.landmarks);
      Object.assign(quality, {
        score: round(face.score, 4),
        interEyePx: round(geometry.interEyePx, 2),
        rollDeg: round(geometry.rollDeg, 2),
        yawRatio: round(geometry.yawRatio, 4),
        faceWidthPx: round(face.width, 1),
        faceHeightPx: round(face.height, 1),
        faceWidthRatio: round(face.width / meta.width, 4),
        inFrame:
          face.x >= 0 &&
          face.y >= 0 &&
          face.x + face.width <= meta.width &&
          face.y + face.height <= meta.height,
      });
    }
    return { source, faceIndex, vector, quality };
  }

  /** @param {import('./faceVerifierConfig.js').FaceVerifierConfig} options */
  async #loadModels(options) {
    /** @param {string} id */
    const load = async (id) => {
      const asset = MODEL_ASSETS[id];
      if (!asset) throw new LabError(`Unknown model "${id}"`, { code: "UNKNOWN_MODEL" });
      const bytes = await this.#runtime.loadModel(asset);
      const sha256 = await this.#runtime.sha256(bytes);
      assertModelIntegrity(asset, bytes, sha256);
      this.#modelHashes.set(id, sha256);
      if (!asset.pruneUnusedGraphInputs) return bytes;
      // After the hash check: the session gets the pinned graph minus unread input declarations.
      const pruned = pruneUnusedGraphInputs(bytes);
      this.#prunedInputs.set(id, pruned.removed.length);
      return pruned.bytes;
    };
    const [detector, recognizer] = await Promise.all([
      load(options.detectorModel),
      load(options.recognizerModel),
    ]);
    return { detector, recognizer };
  }

  /**
   * Opens both sessions on the requested provider and warms them up, falling back to WASM if
   * WebGPU fails and fallback is allowed. Does not replace the current sessions.
   *
   * @param {import('./faceVerifierConfig.js').FaceVerifierConfig} options
   * @param {{ detector: Uint8Array, recognizer: Uint8Array }} models
   */
  async #createSessions(options, models) {
    const requested = options.executionProvider;
    try {
      return { ...(await this.#attempt(options, models, requested)), fallbackReason: null };
    } catch (error) {
      if (requested !== "webgpu" || !options.allowWasmFallback) throw error;
      return {
        ...(await this.#attempt(options, models, "wasm")),
        fallbackReason: describeError(error),
      };
    }
  }

  /**
   * @param {import('./faceVerifierConfig.js').FaceVerifierConfig} options
   * @param {{ detector: Uint8Array, recognizer: Uint8Array }} models
   * @param {OrtProvider} provider
   */
  async #attempt(options, models, provider) {
    const sessionOptions = { numThreads: options.numThreads };
    const startedAt = this.now();
    const detector = await this.#runtime.createSession(models.detector, provider, sessionOptions);
    const detectorCreateMs = this.now() - startedAt;
    /** @type {OrtSession | null} */
    let recognizer = null;
    try {
      const recognizerStartedAt = this.now();
      recognizer = await this.#runtime.createSession(models.recognizer, provider, {
        ...sessionOptions,
        foldWeightDequantization:
          MODEL_ASSETS[options.recognizerModel].foldWeightDequantization === true,
      });
      const recognizerCreateMs = this.now() - recognizerStartedAt;
      checkSignatures(detector, recognizer);
      const createMs = this.now() - startedAt;
      const sessions = { detector, recognizer, provider };
      let warmupMs = null;
      let selfCheck = null;
      if (options.warmup) {
        const warmupStartedAt = this.now();
        selfCheck = await this.#warmUp(sessions, options);
        warmupMs = this.now() - warmupStartedAt;
      }
      return {
        sessions,
        selfCheck,
        record: { provider, createMs, detectorCreateMs, recognizerCreateMs, warmupMs },
      };
    } catch (error) {
      await releaseSessions({ detector, recognizer, provider });
      throw error;
    }
  }

  /**
   * Runs both models once: compiles WebGPU shaders before the first frame, and embeds a fixed
   * synthetic input whose embedding can be compared across providers and machines.
   *
   * @param {SessionSet} sessions
   * @param {import('./faceVerifierConfig.js').FaceVerifierConfig} options
   */
  async #warmUp({ detector, recognizer }, options) {
    const input = detectorInputSize(
      WARMUP_FRAME.width,
      WARMUP_FRAME.height,
      options.detectorInputWidth,
    );
    await detector.run({
      [detector.inputNames[0]]: this.#runtime.createTensor(
        new Float32Array(3 * input.paddedWidth * input.paddedHeight),
        [1, 3, input.paddedHeight, input.paddedWidth],
      ),
    });
    const pattern = new Float32Array(3 * SFACE_CROP_SIZE * SFACE_CROP_SIZE);
    for (let i = 0; i < pattern.length; i += 1) pattern[i] = (i * 37) % 255;
    const outputs = await recognizer.run({
      [recognizer.inputNames[0]]: this.#runtime.createTensor(pattern, [
        1,
        3,
        SFACE_CROP_SIZE,
        SFACE_CROP_SIZE,
      ]),
    });
    const vector = embeddingFrom(outputs[recognizer.outputNames[0]]);
    return {
      input: SELF_CHECK_INPUT,
      recognizer: options.recognizerModel,
      embedding: Array.from(vector, (value) => round(value, 6)),
    };
  }

  /** @param {SessionCreation} creation */
  #adopt(creation) {
    this.#sessions = creation.sessions;
    this.#fallbackReason = creation.fallbackReason;
    this.#selfCheck = creation.selfCheck;
    this.#lastSessionCreation = creation.record;
  }
}

/**
 * @param {OrtSession} detector
 * @param {OrtSession} recognizer
 */
function checkSignatures(detector, recognizer) {
  const expected = YUNET_STRIDES.flatMap((stride) => yunetOutputNames(stride));
  const missing = expected.filter((name) => !detector.outputNames.includes(name));
  if (detector.inputNames.length !== 1 || missing.length > 0) {
    throw new LabError(
      `The detector model does not have YuNet's signature (inputs: ${detector.inputNames.join(", ")}; missing outputs: ${missing.join(", ") || "none"})`,
      { code: "MODEL_SIGNATURE" },
    );
  }
  if (recognizer.inputNames.length !== 1 || recognizer.outputNames.length < 1) {
    throw new LabError(
      `The recognizer model must have one input and an embedding output (inputs: ${recognizer.inputNames.length}, outputs: ${recognizer.outputNames.length})`,
      { code: "MODEL_SIGNATURE" },
    );
  }
}

/**
 * @param {OrtTensorLike | undefined} tensor
 * @returns {Float32Array}
 */
function embeddingFrom(tensor) {
  const vector =
    tensor && tensor.data.length === SFACE_EMBEDDING_SIZE ? l2Normalize(tensor.data) : null;
  if (!vector) {
    throw new LabError(
      `The recognizer returned ${tensor ? tensor.data.length : "no"} values; expected a non-zero embedding of ${SFACE_EMBEDDING_SIZE}`,
      { code: "MODEL_OUTPUT_SHAPE" },
    );
  }
  return vector;
}

/** @param {SessionSet | { detector: OrtSession | null, recognizer: OrtSession | null } | null} sessions */
async function releaseSessions(sessions) {
  if (!sessions) return;
  await Promise.allSettled([sessions.detector?.release(), sessions.recognizer?.release()]);
}

/**
 * @param {import('./yunet.js').DetectedFace} face detector-input pixels
 * @param {number} scaleX detector input / frame
 * @param {number} scaleY
 * @returns {FrameFace}
 */
function toFramePixels(face, scaleX, scaleY) {
  return {
    x: face.x / scaleX,
    y: face.y / scaleY,
    width: face.width / scaleX,
    height: face.height / scaleY,
    score: face.score,
    landmarks: face.landmarks.map((value, index) => value / (index % 2 === 0 ? scaleX : scaleY)),
  };
}

/** @param {FrameFace[]} faces */
function largestFace(faces) {
  let best = 0;
  for (let index = 1; index < faces.length; index += 1) {
    if (faces[index].width * faces[index].height > faces[best].width * faces[best].height) {
      best = index;
    }
  }
  return best;
}

/**
 * @param {FrameFace} face
 * @param {{ width: number, height: number }} image
 */
function normalizedBox(face, image) {
  const left = clamp01(face.x / image.width);
  const top = clamp01(face.y / image.height);
  const right = clamp01((face.x + face.width) / image.width);
  const bottom = clamp01((face.y + face.height) / image.height);
  return {
    box: { x: left, y: top, width: right - left, height: bottom - top },
    truncated:
      face.x < 0 ||
      face.y < 0 ||
      face.x + face.width > image.width ||
      face.y + face.height > image.height,
  };
}

/** @param {number} value */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * @param {number} value
 * @param {number} digits
 */
function round(value, digits) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
