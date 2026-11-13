import { z } from "../../utils/zod.js";
import { DEFAULT_OBJECT_CLASSES } from "./cocoLabels.js";
import { ZOOM_MODES } from "./tiles.js";

/**
 * Options shared by both object-detection engine kinds. `minScore` is the reporting limit;
 * the rules apply their own (higher) limits, so the panel can show near misses.
 */
const sharedFields = {
  /** Detections below this score are not reported. Scores are not calibrated across models. */
  minScore: z.number().min(0).max(1),
  /** At most this many detections per frame, highest scores first. */
  maxDetections: z.number().int().min(1).max(100),
  /** COCO class names reported; empty = all 80. */
  classes: z.array(z.string().min(1)).max(80),
  /** Run once on a blank image during initialization (shader and graph start-up). */
  warmup: z.boolean(),
  /**
   * Zoom pass: also run on full-resolution crops of the frame so small objects are larger in
   * the model input ("tiles": 2 squares for 16:9, "fine": 6). Needs native-resolution frames.
   */
  zoom: z.enum(ZOOM_MODES),
};

/** MediaPipe Tasks ObjectDetector with EfficientDet-Lite (TFLite). */
export const MediapipeObjectDetectorConfigSchema = z
  .object({
    model: z.enum(["mp-effdet-lite0-int8", "mp-effdet-lite2-int8"]),
    delegate: z.enum(["GPU", "CPU"]),
    allowCpuFallback: z.boolean(),
    ...sharedFields,
  })
  .strict();

/** @typedef {z.infer<typeof MediapipeObjectDetectorConfigSchema>} MediapipeObjectDetectorConfig */

/** NanoDet-Plus or YOLOX-S (OpenCV Zoo ONNX) on ONNX Runtime Web. */
export const OnnxObjectDetectorConfigSchema = z
  .object({
    model: z.enum(["ocv-nanodet-plus", "ocv-yolox-s"]),
    executionProvider: z.enum(["wasm", "webgpu"]),
    allowWasmFallback: z.boolean(),
    /** WASM threads (0 = ONNX Runtime's default); fixed when the worker starts. */
    numThreads: z.number().int().min(0).max(16),
    /** IoU above which the lower-scored of two overlapping boxes is dropped. */
    nmsThreshold: z.number().min(0).max(1),
    ...sharedFields,
  })
  .strict();

/** @typedef {z.infer<typeof OnnxObjectDetectorConfigSchema>} OnnxObjectDetectorConfig */

const SHARED_DEFAULTS = Object.freeze({
  minScore: 0.3,
  maxDetections: 10,
  classes: [...DEFAULT_OBJECT_CLASSES],
  warmup: true,
  // The whole frame plus two full-resolution squares (16:9): phones at arm's length are about
  // 1.8 times larger in the model input. Costs three model runs per frame.
  zoom: "tiles",
});

/** @type {Readonly<MediapipeObjectDetectorConfig>} */
export const DEFAULT_MEDIAPIPE_OBJECT_CONFIG = Object.freeze({
  model: "mp-effdet-lite0-int8",
  // CPU: with the GPU delegate the int8 models gave wrong results on every test photo (Chrome,
  // Intel UHD; float16 Lite0 was correct on the GPU). See docs/PHASE6_REPORT.md.
  delegate: "CPU",
  allowCpuFallback: true,
  ...SHARED_DEFAULTS,
});

/** @type {Readonly<OnnxObjectDetectorConfig>} */
export const DEFAULT_ONNX_OBJECT_CONFIG = Object.freeze({
  model: "ocv-nanodet-plus",
  executionProvider: "wasm",
  allowWasmFallback: true,
  numThreads: 0,
  // The OpenCV Zoo demos: NanoDet 0.6, YOLOX 0.5.
  nmsThreshold: 0.5,
  ...SHARED_DEFAULTS,
});
