import { MODEL_ASSETS } from "../../config/modelAssets.js";
import { LabError, describeError } from "../../utils/errors.js";
import { parseConfig } from "../../utils/validation.js";
import { BaseDetectionEngine } from "../BaseDetectionEngine.js";
import { assertModelIntegrity } from "../modelFiles.js";
import { OnnxObjectDetectorConfigSchema } from "./objectDetectorConfig.js";
import { objectResult } from "./objectObservations.js";
import {
  ONNX_DETECTORS,
  decodeNanodet,
  decodeYolox,
  letterbox,
  nanodetLevels,
  nonMaxSuppression,
  toFrameDetection,
  toPlanarTensor,
} from "./onnxDetectors.js";
import { mergePasses, objectTiles, rectBoxToFrame } from "./tiles.js";

/** Options that need a new session. */
const SESSION_OPTIONS = /** @type {const} */ (["model", "executionProvider", "allowWasmFallback"]);

/**
 * @typedef {import('../verification/FaceVerificationEngine.js').OrtSession} OrtSession
 *
 * @typedef {Object} OnnxObjectRuntime
 * @property {string} version
 * @property {(asset: import('../../config/modelAssets.js').ModelAsset) => Promise<Uint8Array>} loadModel
 * @property {(bytes: Uint8Array) => Promise<string>} sha256
 * @property {(bytes: Uint8Array, provider: 'wasm' | 'webgpu', options: { numThreads: number }) => Promise<OrtSession>} createSession
 * @property {(data: Float32Array, dims: number[]) => unknown} createTensor
 * @property {() => Record<string, unknown>} environment
 * @property {(frame: CanvasImageSource, box: import('./onnxDetectors.js').Letterbox) => Uint8ClampedArray} letterboxPixels
 * @property {(frame: ImageBitmap | VideoFrame, rect: import('./tiles.js').Rect, size: number) => Promise<ImageBitmap>} cropFrame
 */

/**
 * NanoDet-Plus-m-1.5x (416) or YOLOX-S (640) from OpenCV Zoo on ONNX Runtime Web (WASM or
 * WebGPU). Pre- and postprocessing follow the OpenCV Zoo reference code (onnxDetectors.js);
 * NMS runs here, in JavaScript. With `zoom` on, the model also runs on square crops of the frame
 * (scaled to the model input) and the detections are merged (tiles.js).
 *
 * Observations: see objectObservations.js. Timings: `preprocessMs` includes the letterbox
 * read-back; `inferenceMs` is the model run; `postprocessMs` decoding and NMS.
 */
export class OnnxObjectDetectorEngine extends BaseDetectionEngine {
  static kind = "ort-object-detector";

  /** @type {import('./objectDetectorConfig.js').OnnxObjectDetectorConfig} */
  #options;
  /** @type {OnnxObjectRuntime} */
  #runtime;
  /** @type {OrtSession | null} */
  #session = null;
  /** @type {'wasm' | 'webgpu' | null} */
  #provider = null;
  /** @type {string | null} */
  #fallbackReason = null;
  /** @type {Record<string, unknown> | null} */
  #lastSessionCreation = null;
  /** @type {Map<string, string>} */
  #hashes = new Map();
  /** @type {Float32Array | null} */
  #input = null;
  /** @type {Promise<void> | null} */
  #inFlight = null;

  /**
   * @param {Record<string, unknown>} config
   * @param {{ now?: () => number, runtime?: OnnxObjectRuntime }} [dependencies]
   */
  constructor(config, { runtime, ...dependencies } = {}) {
    const options = parseConfig(
      OnnxObjectDetectorConfigSchema,
      config,
      "object detector configuration",
    );
    super(options, dependencies);
    if (!runtime) {
      throw new LabError("OnnxObjectDetectorEngine needs an ONNX Runtime runtime", {
        code: "RUNTIME_MISSING",
      });
    }
    this.#options = options;
    this.#runtime = runtime;
  }

  async onInitialize() {
    const fetchStartedAt = this.now();
    const bytes = await this.#loadModel(this.#options.model);
    const modelFetchMs = this.now() - fetchStartedAt;
    const creation = await this.#createSession(this.#options, bytes);
    this.#adopt(creation);
    return {
      modelFetchMs,
      modelInitMs: creation.createMs,
      ...(creation.warmupMs === null ? {} : { warmupMs: creation.warmupMs }),
    };
  }

  /**
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('../EngineContract.js').FrameMeta} meta
   * @param {import('../EngineContract.js').StageTimer} timer
   */
  async onDetect(frame, meta, timer) {
    const session = /** @type {OrtSession} */ (this.#session);
    const options = this.#options;
    const run = (async () => {
      const spec = ONNX_DETECTORS[options.model];
      const passes = objectTiles(meta.width, meta.height, options.zoom);
      /** @type {import('./onnxDetectors.js').ObjectDetection[]} */
      const detections = [];
      for (const [index, rect] of passes.entries()) {
        timer.start("preprocess");
        const whole = index === 0;
        const image = whole ? frame : await this.#runtime.cropFrame(frame, rect, spec.inputSize);
        const width = whole ? meta.width : spec.inputSize;
        const height = whole ? meta.height : spec.inputSize;
        const box = letterbox(width, height, spec);
        let rgba;
        try {
          rgba = this.#runtime.letterboxPixels(/** @type {CanvasImageSource} */ (image), box);
        } finally {
          if (!whole) /** @type {ImageBitmap} */ (image).close();
        }
        const values = 3 * box.size * box.size;
        if (this.#input?.length !== values) this.#input = new Float32Array(values);
        const tensor = this.#runtime.createTensor(
          toPlanarTensor(rgba, box.size, spec, this.#input),
          [1, 3, box.size, box.size],
        );

        timer.start("inference");
        const outputs = await session.run({ [session.inputNames[0]]: tensor });

        timer.start("postprocess");
        // Candidates down to the reporting limit; the shared filter applies classes and count.
        const candidates =
          spec.family === "nanodet"
            ? decodeNanodet(nanodetLevels(outputs, spec), spec, options.minScore)
            : decodeYolox(outputs[session.outputNames[0]].data, spec, options.minScore);
        const kept = nonMaxSuppression(candidates, options.nmsThreshold, {
          classAware: spec.classAwareNms,
          maxDetections: 100,
        });
        for (const candidate of kept) {
          const detection = toFrameDetection(candidate, box, width, height);
          detections.push(
            whole
              ? detection
              : { ...detection, box: rectBoxToFrame(detection.box, rect, meta.width, meta.height) },
          );
        }
      }
      const merged =
        passes.length > 1
          ? mergePasses(detections, { frameWidth: meta.width, frameHeight: meta.height })
          : detections;
      return objectResult(merged, meta, options);
    })();
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
      OnnxObjectDetectorConfigSchema,
      { ...this.#options, ...patch },
      "object detector configuration",
    );
    if (next.numThreads !== this.#options.numThreads) {
      throw new LabError(
        "numThreads takes effect when the worker starts: unload the engine, change it, and load it again",
        { code: "RESTART_REQUIRED" },
      );
    }
    if (SESSION_OPTIONS.some((key) => next[key] !== this.#options[key])) {
      const bytes = await this.#loadModel(next.model);
      const creation = await this.#createSession(next, bytes);
      const replaced = this.#session;
      this.#adopt(creation);
      this.#options = next;
      await this.#inFlight;
      await replaced?.release();
    } else {
      this.#options = next;
    }
    return { ...next };
  }

  async onDispose() {
    await this.#inFlight;
    const session = this.#session;
    this.#session = null;
    await session?.release();
  }

  getModelInfo() {
    const asset = MODEL_ASSETS[this.#options.model];
    return {
      id: asset.id,
      version: asset.version,
      runtime: this.#runtime.version,
      file: asset.file,
      ...(this.#hashes.has(asset.id) ? { sha256: this.#hashes.get(asset.id) } : {}),
    };
  }

  getExecutionProvider() {
    return this.#provider ? `ort-${this.#provider}` : null;
  }

  getStatusDetails() {
    return {
      requestedProvider: this.#options.executionProvider,
      provider: this.#provider,
      fallbackReason: this.#fallbackReason,
      lastSessionCreation: this.#lastSessionCreation,
      environment: this.#runtime.environment(),
    };
  }

  /** @param {string} id */
  async #loadModel(id) {
    const asset = MODEL_ASSETS[id];
    const bytes = await this.#runtime.loadModel(asset);
    const sha256 = await this.#runtime.sha256(bytes);
    assertModelIntegrity(asset, bytes, sha256);
    this.#hashes.set(id, sha256);
    return bytes;
  }

  /**
   * @param {import('./objectDetectorConfig.js').OnnxObjectDetectorConfig} options
   * @param {Uint8Array} bytes
   */
  async #createSession(options, bytes) {
    const attempt = async (/** @type {'wasm' | 'webgpu'} */ provider) => {
      const startedAt = this.now();
      const session = await this.#runtime.createSession(bytes, provider, {
        numThreads: options.numThreads,
      });
      const createMs = this.now() - startedAt;
      try {
        if (session.inputNames.length !== 1 || session.outputNames.length < 1) {
          throw new LabError(
            `The object detector model must have one input (inputs: ${session.inputNames.length})`,
            { code: "MODEL_SIGNATURE" },
          );
        }
        let warmupMs = null;
        if (options.warmup) {
          const size = ONNX_DETECTORS[options.model].inputSize;
          const warmupStartedAt = this.now();
          await session.run({
            [session.inputNames[0]]: this.#runtime.createTensor(new Float32Array(3 * size * size), [
              1,
              3,
              size,
              size,
            ]),
          });
          warmupMs = this.now() - warmupStartedAt;
        }
        return { session, provider, createMs, warmupMs };
      } catch (error) {
        await session.release();
        throw error;
      }
    };
    try {
      return { ...(await attempt(options.executionProvider)), fallbackReason: null };
    } catch (error) {
      if (options.executionProvider !== "webgpu" || !options.allowWasmFallback) throw error;
      return { ...(await attempt("wasm")), fallbackReason: describeError(error) };
    }
  }

  /** @param {{ session: OrtSession, provider: 'wasm' | 'webgpu', createMs: number, warmupMs: number | null, fallbackReason: string | null }} creation */
  #adopt(creation) {
    this.#session = creation.session;
    this.#provider = creation.provider;
    this.#fallbackReason = creation.fallbackReason;
    this.#lastSessionCreation = {
      provider: creation.provider,
      createMs: creation.createMs,
      warmupMs: creation.warmupMs,
    };
  }
}
