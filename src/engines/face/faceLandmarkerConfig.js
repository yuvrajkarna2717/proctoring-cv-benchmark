import { z } from "../../utils/zod.js";

/**
 * Configuration of the MediaPipe Face Landmarker engine. Option names that start with `num`,
 * `min`, or `output` are passed to MediaPipe unchanged (see the FaceLandmarkerOptions docs).
 */
export const FaceLandmarkerConfigSchema = z
  .object({
    /** Requested MediaPipe delegate. GPU runs WebGL2 on an OffscreenCanvas inside the worker. */
    delegate: z.enum(["GPU", "CPU"]),
    /**
     * Use the CPU delegate when the GPU delegate cannot be created. The delegate actually used is
     * reported as the execution provider, with the reason for the fallback.
     */
    allowCpuFallback: z.boolean(),
    /** Maximum faces per frame. FACE_COUNT cannot exceed this value. */
    numFaces: z.number().int().min(1).max(10),
    minFaceDetectionConfidence: z.number().min(0).max(1),
    minFacePresenceConfidence: z.number().min(0).max(1),
    minTrackingConfidence: z.number().min(0).max(1),
    /** 52 blendshape scores per face (used from Phase 4). */
    outputFaceBlendshapes: z.boolean(),
    /** 4×4 face transformation matrix per face (head pose, Phase 4). */
    outputFacialTransformationMatrixes: z.boolean(),
    /** Send the 478 landmark coordinates per face to the main thread (overlay). */
    includeLandmarks: z.boolean(),
    /**
     * Run one inference on a blank image during initialization, so shader compilation and graph
     * start-up are counted as warm-up time instead of first-frame latency.
     */
    warmup: z.boolean(),
  })
  .strict();

/** @typedef {z.infer<typeof FaceLandmarkerConfigSchema>} FaceLandmarkerConfig */

/** @type {Readonly<FaceLandmarkerConfig>} */
export const DEFAULT_FACE_LANDMARKER_CONFIG = Object.freeze({
  delegate: "GPU",
  allowCpuFallback: true,
  numFaces: 3,
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  outputFaceBlendshapes: false,
  outputFacialTransformationMatrixes: false,
  includeLandmarks: true,
  warmup: true,
});
