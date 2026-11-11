import { LabError } from "../../utils/errors.js";
import { parseConfig } from "../../utils/validation.js";
import { BaseDetectionEngine } from "../BaseDetectionEngine.js";
import { ImageQualityConfigSchema } from "./imageQualityConfig.js";
import {
  downscaleLuma,
  expandedPixelRect,
  laplacianVariance,
  lumaFromRgba,
  normalizedSharpness,
  regionStats,
  resampleLuma,
} from "./imageStats.js";

/**
 * @typedef {{ box: { x: number, y: number, width: number, height: number } | null, at: number,
 *   sourceEngineId: string }} FaceHint the primary face of the face landmarker's latest result,
 *   normalized to the frame; `box` null when that result had no face
 */

/**
 * Model-free image-quality engine: lighting, contrast, and sharpness of the whole frame and of
 * the face region. It finds no faces itself; the main thread passes the face landmarker's
 * latest face box in the frame metadata (`meta.hints.face`).
 *
 * The frame is read back once (drawImage + getImageData at up to `readWidth`), which is the
 * main cost (`readMs`); everything else is computed on that luma plane.
 *
 * Observations per frame:
 * - `FRAME_QUALITY`: luma mean, RMS contrast, percentiles, crushed and blown fractions, and
 *   sharpness (Laplacian variance) of the frame scaled to `analysisWidth`.
 * - `FACE_QUALITY`: the same for the face region resampled to `faceCropWidth`, plus the
 *   background luma (frame outside the face) and the face size in camera pixels and relative to
 *   the frame width. `detected` is false without a usable hint, with the reason.
 */
export class ImageQualityEngine extends BaseDetectionEngine {
  static kind = "image-quality";

  /** @type {import('./imageQualityConfig.js').ImageQualityConfig} */
  #options;
  /** @type {(width: number, height: number) => OffscreenCanvas} */
  #createCanvas;
  /** @type {OffscreenCanvas | null} */
  #canvas = null;
  /** @type {OffscreenCanvasRenderingContext2D | null} */
  #context = null;

  /**
   * @param {Record<string, unknown>} config
   * @param {{ now?: () => number, createCanvas?: (width: number, height: number) => OffscreenCanvas }} [dependencies]
   */
  constructor(config, { createCanvas, ...dependencies } = {}) {
    const options = parseConfig(ImageQualityConfigSchema, config, "image quality configuration");
    super(options, dependencies);
    this.#options = options;
    // Tests inject a canvas factory; workers use OffscreenCanvas.
    this.#createCanvas = createCanvas ?? ((width, height) => new OffscreenCanvas(width, height));
  }

  async onInitialize() {
    const startedAt = this.now();
    try {
      this.#canvas = this.#createCanvas(this.#options.readWidth, 1);
    } catch (error) {
      throw new LabError("OffscreenCanvas is not available in this worker", {
        code: "UNSUPPORTED_API",
        cause: error,
      });
    }
    this.#context = this.#canvas.getContext("2d", { willReadFrequently: true, alpha: false });
    if (!this.#context) {
      throw new LabError("Could not create an OffscreenCanvas 2D context", {
        code: "CONTEXT_UNAVAILABLE",
      });
    }
    return { modelFetchMs: 0, modelInitMs: this.now() - startedAt };
  }

  /**
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('../EngineContract.js').FrameMeta & { hints?: { face?: FaceHint | null } | null }} meta
   * @param {import('../EngineContract.js').StageTimer} timer
   */
  async onDetect(frame, meta, timer) {
    const options = this.#options;
    const canvas = /** @type {OffscreenCanvas} */ (this.#canvas);
    const context = /** @type {OffscreenCanvasRenderingContext2D} */ (this.#context);
    const clip = { clipLow: options.clipLow, clipHigh: options.clipHigh };

    timer.start("preprocess");
    const readWidth = Math.min(options.readWidth, meta.width);
    const readHeight = Math.max(1, Math.round((readWidth * meta.height) / meta.width));
    const readStartedAt = this.now();
    if (canvas.width !== readWidth || canvas.height !== readHeight) {
      canvas.width = readWidth;
      canvas.height = readHeight;
    }
    context.drawImage(frame, 0, 0, readWidth, readHeight);
    const { data } = context.getImageData(0, 0, readWidth, readHeight);
    timer.record("readMs", this.now() - readStartedAt);

    timer.start("inference");
    const luma = lumaFromRgba(data, readWidth, readHeight);
    const analysisWidth = Math.min(options.analysisWidth, readWidth);
    const analysisHeight = Math.max(1, Math.round((analysisWidth * readHeight) / readWidth));
    const analysis = downscaleLuma(luma, readWidth, readHeight, analysisWidth, analysisHeight);
    const frameStats = /** @type {import('./imageStats.js').RegionStats} */ (
      regionStats(analysis, analysisWidth, analysisHeight, clip)
    );

    const hint = meta.hints?.face ?? null;
    const hintAgeMs = hint ? meta.captureTime - hint.at : null;
    /** @type {string | null} */
    let faceProblem = null;
    if (!hint) faceProblem = "no face hint";
    else if (!hint.box) faceProblem = "no face in the face landmarker's latest result";
    else if (/** @type {number} */ (hintAgeMs) > options.maxHintAgeMs) {
      faceProblem = `face hint ${Math.round(/** @type {number} */ (hintAgeMs))} ms old`;
    }
    const faceRect =
      !faceProblem && hint?.box
        ? expandedPixelRect(hint.box, readWidth, readHeight, options.faceMarginRatio)
        : null;
    if (!faceProblem && !faceRect) faceProblem = "face box outside the frame";

    /** @type {import('../EngineContract.js').Observation} */
    let faceObservation = {
      type: "FACE_QUALITY",
      detected: false,
      metadata: { reason: faceProblem },
    };
    if (faceRect && hint?.box) {
      // Always the same width, so sharpness is comparable: a small face scaled up measures as
      // less sharp, which is what the face models get from it too.
      const cropWidth = options.faceCropWidth;
      const cropHeight = Math.max(1, Math.round((cropWidth * faceRect.height) / faceRect.width));
      const crop = resampleLuma(luma, readWidth, readHeight, faceRect, cropWidth, cropHeight);
      const faceStats = /** @type {import('./imageStats.js').RegionStats} */ (
        regionStats(crop, cropWidth, cropHeight, clip)
      );
      const scale = analysisWidth / readWidth;
      const background = regionStats(analysis, analysisWidth, analysisHeight, {
        ...clip,
        exclude: {
          x: Math.floor(faceRect.x * scale),
          y: Math.floor(faceRect.y * scale),
          width: Math.ceil(faceRect.width * scale),
          height: Math.ceil(faceRect.height * scale),
        },
      });
      faceObservation = {
        type: "FACE_QUALITY",
        detected: true,
        metadata: {
          ...rounded(faceStats),
          sharpness: round(normalizedSharpness(crop, cropWidth, cropHeight, faceStats.stdLuma), 5),
          laplacianVariance: round(laplacianVariance(crop, cropWidth, cropHeight), 2),
          cropWidth,
          cropHeight,
          backgroundMeanLuma: background ? round(background.meanLuma, 2) : null,
          // Face size as the landmarker saw it (without the margin), in camera pixels.
          faceWidthPx: round(hint.box.width * meta.sourceWidth, 1),
          faceWidthRatio: round(hint.box.width, 4),
          hintAgeMs: round(/** @type {number} */ (hintAgeMs), 1),
        },
      };
    }

    timer.start("postprocess");
    return {
      observations: [
        {
          type: "FRAME_QUALITY",
          detected: true,
          value: round(frameStats.meanLuma, 2),
          metadata: {
            ...rounded(frameStats),
            sharpness: round(
              normalizedSharpness(analysis, analysisWidth, analysisHeight, frameStats.stdLuma),
              5,
            ),
            laplacianVariance: round(laplacianVariance(analysis, analysisWidth, analysisHeight), 2),
            readWidth,
            readHeight,
            analysisWidth,
            analysisHeight,
            sourceWidth: meta.sourceWidth,
            sourceHeight: meta.sourceHeight,
          },
        },
        faceObservation,
      ],
    };
  }

  /** @param {Record<string, unknown>} patch */
  async onConfigure(patch) {
    this.#options = parseConfig(
      ImageQualityConfigSchema,
      { ...this.#options, ...patch },
      "image quality configuration",
    );
    return { ...this.#options };
  }

  async onDispose() {
    this.#context = null;
    this.#canvas = null;
  }

  getModelInfo() {
    return { id: "image-quality", version: "1", runtime: "javascript" };
  }

  getExecutionProvider() {
    return "js";
  }
}

/** @param {import('./imageStats.js').RegionStats} stats */
function rounded(stats) {
  return {
    meanLuma: round(stats.meanLuma, 2),
    stdLuma: round(stats.stdLuma, 2),
    p5: stats.p5,
    p50: stats.p50,
    p95: stats.p95,
    darkFraction: round(stats.darkFraction, 4),
    brightFraction: round(stats.brightFraction, 4),
  };
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
