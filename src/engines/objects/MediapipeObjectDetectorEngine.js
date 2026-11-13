import { MODEL_ASSETS } from "../../config/modelAssets.js";
import { LabError, describeError } from "../../utils/errors.js";
import { parseConfig } from "../../utils/validation.js";
import { BaseDetectionEngine } from "../BaseDetectionEngine.js";
import { assertModelIntegrity } from "../modelFiles.js";
import { COCO_LABELS } from "./cocoLabels.js";
import { MediapipeObjectDetectorConfigSchema } from "./objectDetectorConfig.js";
import { objectResult } from "./objectObservations.js";
import { mergePasses, objectTiles, rectBoxToFrame } from "./tiles.js";

/** Side of the zoom-pass crops: the model input (MediaPipe resizes to it anyway). */
const CROP_SIZE = { "mp-effdet-lite0-int8": 320, "mp-effdet-lite2-int8": 448 };

/** Options that need a new task (model or delegate). */
const RECREATE_OPTIONS = /** @type {const} */ (["model", "delegate", "allowCpuFallback"]);

/**
 * @typedef {Object} ObjectDetectorTask the subset of MediaPipe's ObjectDetector that is used
 * @property {(image: unknown) => { detections: Array<{
 *   categories: Array<{ index: number, score: number, categoryName: string }>,
 *   boundingBox?: { originX: number, originY: number, width: number, height: number } }> }} detect
 * @property {() => void} close
 *
 * @typedef {Object} MediapipeObjectRuntime
 * @property {string} version
 * @property {(asset: import('../../config/modelAssets.js').ModelAsset) => Promise<Uint8Array>} loadModel
 * @property {(bytes: Uint8Array) => Promise<string>} sha256
 * @property {(options: Record<string, unknown>) => Promise<ObjectDetectorTask>} createObjectDetector
 * @property {(width: number, height: number) => unknown} createBlankImage
 * @property {(frame: ImageBitmap | VideoFrame, rect: import('./tiles.js').Rect, size: number) => Promise<ImageBitmap>} cropFrame
 */

/**
 * MediaPipe Tasks ObjectDetector (EfficientDet-Lite0 or Lite2, int8, COCO) in IMAGE mode: every
 * call is independent, which the zoom pass needs (several crops per frame). MediaPipe does its
 * own resizing and NMS (it returns at most 25 boxes, the model's limit); this engine asks for
 * every class and a low score and filters with the shared options, so filtering is the same for
 * all object engines. With `zoom` on, the detections of the whole frame and of each crop are
 * merged (tiles.js).
 *
 * Observations: see objectObservations.js.
 */
export class MediapipeObjectDetectorEngine extends BaseDetectionEngine {
  static kind = "mp-object-detector";

  /** @type {import('./objectDetectorConfig.js').MediapipeObjectDetectorConfig} */
  #options;
  /** @type {MediapipeObjectRuntime} */
  #runtime;
  /** @type {ObjectDetectorTask | null} */
  #task = null;
  /** @type {Map<string, string>} */
  #hashes = new Map();
  /** @type {'GPU' | 'CPU' | null} */
  #delegate = null;
  /** @type {string | null} */
  #fallbackReason = null;
  /** @type {Record<string, unknown> | null} */
  #lastTaskCreation = null;

  /**
   * @param {Record<string, unknown>} config
   * @param {{ now?: () => number, runtime?: MediapipeObjectRuntime }} [dependencies]
   */
  constructor(config, { runtime, ...dependencies } = {}) {
    const options = parseConfig(
      MediapipeObjectDetectorConfigSchema,
      config,
      "object detector configuration",
    );
    super(options, dependencies);
    if (!runtime) {
      throw new LabError("MediapipeObjectDetectorEngine needs a MediaPipe runtime", {
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
    const creation = await this.#createTask(this.#options, bytes);
    this.#task = creation.task;
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
    const task = /** @type {ObjectDetectorTask} */ (this.#task);
    const options = this.#options;
    const passes = objectTiles(meta.width, meta.height, options.zoom);
    const cropSize = CROP_SIZE[options.model];
    /** @type {import('./onnxDetectors.js').ObjectDetection[]} */
    const detections = [];
    for (const [index, rect] of passes.entries()) {
      timer.start("preprocess");
      const whole = index === 0;
      const image = whole ? frame : await this.#runtime.cropFrame(frame, rect, cropSize);
      const width = whole ? meta.width : cropSize;
      const height = whole ? meta.height : cropSize;
      timer.start("inference");
      let result;
      try {
        result = task.detect(image);
      } finally {
        if (!whole) /** @type {ImageBitmap} */ (image).close();
      }
      timer.start("postprocess");
      for (const detection of result.detections) {
        const category = detection.categories[0];
        const box = detection.boundingBox;
        if (!category || !box) continue;
        const x = clamp01(box.originX / width);
        const y = clamp01(box.originY / height);
        const right = clamp01((box.originX + box.width) / width);
        const bottom = clamp01((box.originY + box.height) / height);
        const inPass = { x, y, width: right - x, height: bottom - y };
        detections.push({
          classId: COCO_LABELS.indexOf(category.categoryName),
          label: category.categoryName,
          score: category.score,
          box: whole ? inPass : rectBoxToFrame(inPass, rect, meta.width, meta.height),
        });
      }
    }
    const merged =
      passes.length > 1
        ? mergePasses(detections, { frameWidth: meta.width, frameHeight: meta.height })
        : detections;
    return objectResult(merged, meta, options);
  }

  /** @param {Record<string, unknown>} patch */
  async onConfigure(patch) {
    const next = parseConfig(
      MediapipeObjectDetectorConfigSchema,
      { ...this.#options, ...patch },
      "object detector configuration",
    );
    if (
      RECREATE_OPTIONS.some((key) => next[key] !== this.#options[key]) ||
      taskScoreThreshold(next) !== taskScoreThreshold(this.#options)
    ) {
      const bytes = await this.#loadModel(next.model);
      const creation = await this.#createTask(next, bytes);
      this.#task?.close();
      this.#task = creation.task;
    }
    this.#options = next;
    return { ...next };
  }

  async onDispose() {
    this.#task?.close();
    this.#task = null;
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
    return this.#delegate ? `mediapipe-${this.#delegate.toLowerCase()}` : null;
  }

  getStatusDetails() {
    return {
      requestedDelegate: this.#options.delegate,
      delegate: this.#delegate,
      fallbackReason: this.#fallbackReason,
      lastTaskCreation: this.#lastTaskCreation,
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
   * @param {import('./objectDetectorConfig.js').MediapipeObjectDetectorConfig} options
   * @param {Uint8Array} bytes
   */
  async #createTask(options, bytes) {
    const startedAt = this.now();
    /** @param {'GPU' | 'CPU'} delegate */
    const taskOptions = (delegate) => ({
      baseOptions: { modelAssetBuffer: bytes, delegate },
      runningMode: "IMAGE",
      // Everything the model returns; the shared filter applies minScore and classes.
      scoreThreshold: taskScoreThreshold(options),
      maxResults: -1,
    });
    /** @type {'GPU' | 'CPU'} */
    let delegate = options.delegate;
    /** @type {string | null} */
    let fallbackReason = null;
    /** @type {ObjectDetectorTask} */
    let task;
    try {
      task = await this.#runtime.createObjectDetector(taskOptions(delegate));
    } catch (error) {
      if (delegate !== "GPU" || !options.allowCpuFallback) throw error;
      fallbackReason = describeError(error);
      delegate = "CPU";
      task = await this.#runtime.createObjectDetector(taskOptions(delegate));
    }
    const createMs = this.now() - startedAt;
    let warmupMs = null;
    if (options.warmup) {
      const warmupStartedAt = this.now();
      task.detect(this.#runtime.createBlankImage(64, 64));
      warmupMs = this.now() - warmupStartedAt;
    }
    this.#delegate = delegate;
    this.#fallbackReason = fallbackReason;
    this.#lastTaskCreation = { delegate, model: options.model, createMs, warmupMs };
    return { task, createMs, warmupMs };
  }
}

/**
 * MediaPipe's own score limit: low enough for every reporting limit at or above 0.1, so most
 * minScore changes need no new task.
 *
 * @param {{ minScore: number }} options
 */
function taskScoreThreshold(options) {
  return Math.min(0.1, options.minScore);
}

/** @param {number} value */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
