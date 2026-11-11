import { z } from "../../utils/zod.js";

/**
 * Configuration of the image-quality engine: how frames are sampled for pixel statistics. The
 * limits that decide "too dark" or "blurry" are lab configuration (`imageQuality`), applied on
 * the main thread, so they can change without touching the worker.
 */
export const ImageQualityConfigSchema = z
  .object({
    /**
     * The frame is read back from the GPU once per sample, scaled to at most this width. The
     * face crop and the frame statistics both come from this one read. In headless Chrome on
     * the development laptop a read of a 1280×720 frame took 40–200 ms; two reads per frame
     * (frame and face) cost about twice one.
     */
    readWidth: z.number().int().min(64).max(3840),
    /** The read frame is scaled to this width (aspect ratio kept) for its statistics. */
    analysisWidth: z.number().int().min(32).max(1920),
    /**
     * The face region is cropped from the read frame and scaled to this width, so its
     * sharpness is measured at one size whatever the face size (Laplacian variance depends on
     * scale). 112 matches the aligned crop of the identity quality gate.
     */
    faceCropWidth: z.number().int().min(32).max(512),
    /** The face box is enlarged by this fraction of its size on every side. */
    faceMarginRatio: z.number().min(0).max(1),
    /**
     * The face box comes from the face landmarker's latest result (a hint in the frame
     * metadata). A hint older than this, relative to the frame, is not used.
     */
    maxHintAgeMs: z.number().int().min(0).max(60_000),
    /** Luma at or below this counts as crushed shadow. */
    clipLow: z.number().int().min(0).max(128),
    /** Luma at or above this counts as a blown highlight. */
    clipHigh: z.number().int().min(128).max(255),
  })
  .strict();

/** @typedef {z.infer<typeof ImageQualityConfigSchema>} ImageQualityConfig */

/** @type {Readonly<ImageQualityConfig>} */
export const DEFAULT_IMAGE_QUALITY_CONFIG = Object.freeze({
  // 640 px: about half the read and compute time of 1280 px in the headless measurements; a
  // blurred face still measured 50 times below a sharp one.
  readWidth: 640,
  analysisWidth: 320,
  faceCropWidth: 112,
  faceMarginRatio: 0.1,
  maxHintAgeMs: 1500,
  clipLow: 16,
  clipHigh: 245,
});
