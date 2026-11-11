import { z } from "../../utils/zod.js";

/**
 * Configuration of the face verification engine: YuNet face detection, five-point alignment, and
 * SFace embeddings on ONNX Runtime Web.
 */
export const FaceVerifierConfigSchema = z
  .object({
    /**
     * ONNX Runtime execution provider: "wasm" (CPU, SIMD and threads) or "webgpu" (native
     * WebGPU provider). Both come from the same ONNX Runtime binary.
     */
    executionProvider: z.enum(["wasm", "webgpu"]),
    /** Use "wasm" when WebGPU sessions cannot be created; the reason is reported. */
    allowWasmFallback: z.boolean(),
    /**
     * WASM threads for ONNX Runtime; 0 lets ONNX Runtime choose (half the logical cores, at
     * most 4). Applied when the worker starts: ONNX Runtime fixes the thread pool when it
     * creates its first session, so changing it needs an engine restart.
     */
    numThreads: z.number().int().min(0).max(16),
    detectorModel: z.enum(["ocv-yunet-2026may"]),
    /**
     * SFace variant. Default: int8bq (int8 weights, float32 compute; 10.7 MB, embeddings within
     * cosine 0.999 of fp32 on the self-check input). A reference or calibration capture is only
     * compared with embeddings of the variant that made it.
     */
    recognizerModel: z.enum(["ocv-sface", "ocv-sface-int8", "ocv-sface-int8bq"]),
    /**
     * Frames are scaled to this width for the detector (aspect ratio kept, never enlarged).
     * YuNet finds faces of about 10–300 px at the detector's resolution.
     */
    detectorInputWidth: z.number().int().min(160).max(1920),
    /** Minimum YuNet score (sqrt of class × objectness). OpenCV Zoo's demo uses 0.9. */
    scoreThreshold: z.number().min(0).max(1),
    /** Overlapping faces with a higher IoU than this are suppressed. */
    nmsThreshold: z.number().min(0).max(1),
    /** Candidates considered before suppression, as in OpenCV. */
    topK: z.number().int().min(1).max(5000),
    /** Faces reported per frame (highest scores). FACE_COUNT cannot exceed this value. */
    maxFaces: z.number().int().min(1).max(20),
    /** "largest": align and embed the largest face; "none": detection only. */
    embedFaces: z.enum(["largest", "none"]),
    /**
     * Diagnostic: when no face is found, embed a centre crop of the frame, so the recognizer's
     * latency can be measured without a face. Such embeddings are marked `center-crop` and are
     * never used for identity.
     */
    embedWhenNoFace: z.boolean(),
    /** Send the five landmarks per face to the main thread (overlay). */
    includeLandmarks: z.boolean(),
    /**
     * Run both models once on synthetic input when sessions are created, so WebGPU shader
     * compilation counts as warm-up instead of first-frame latency.
     */
    warmup: z.boolean(),
  })
  .strict();

/** @typedef {z.infer<typeof FaceVerifierConfigSchema>} FaceVerifierConfig */

/**
 * Defaults. "wasm" is the default provider because it was faster than WebGPU for both models
 * on the development laptop (see docs/PHASE3_REPORT.md); WebGPU stays selectable. SFace int8bq
 * is the default recognizer: on WASM it measured as fast as fp32 and downloads 28 MB less
 * (docs/PHASE3_REPORT.md, "Quantized SFace").
 *
 * @type {Readonly<FaceVerifierConfig>}
 */
export const DEFAULT_FACE_VERIFIER_CONFIG = Object.freeze({
  executionProvider: "wasm",
  allowWasmFallback: true,
  numThreads: 0,
  detectorModel: "ocv-yunet-2026may",
  recognizerModel: "ocv-sface-int8bq",
  detectorInputWidth: 640,
  scoreThreshold: 0.9,
  nmsThreshold: 0.3,
  topK: 5000,
  maxFaces: 5,
  embedFaces: "largest",
  embedWhenNoFace: false,
  includeLandmarks: true,
  warmup: true,
});
