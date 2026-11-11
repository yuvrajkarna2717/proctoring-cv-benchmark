import { LabError } from "../../utils/errors.js";
import { canvasTransform } from "./alignment.js";

/**
 * Pixel operations of the face verification engine on OffscreenCanvas 2D contexts (worker).
 * Kept apart from the engine so unit tests can replace them; the browser smoke test covers this
 * module.
 *
 * @typedef {Object} ImageOps
 * @property {() => void} assertSupported throws UNSUPPORTED_API without OffscreenCanvas 2D
 * @property {(frame: CanvasImageSource, input: { width: number, height: number,
 *   paddedWidth: number, paddedHeight: number }) => Uint8ClampedArray} detectorInput RGBA pixels
 *   of the frame scaled to width × height, padded with black to paddedWidth × paddedHeight
 * @property {(frame: CanvasImageSource, matrix: import('./alignment.js').AffineMatrix,
 *   size: number) => Uint8ClampedArray} warp RGBA pixels of a size × size crop, where `matrix`
 *   maps frame pixels (OpenCV convention) to crop pixels; black outside the frame
 */

/** @returns {ImageOps} */
export function createCanvasImageOps() {
  /** @type {OffscreenCanvasRenderingContext2D | null} */
  let detectorContext = null;
  /** @type {OffscreenCanvasRenderingContext2D | null} */
  let cropContext = null;

  /** @param {number} width @param {number} height */
  const createContext = (width, height) => {
    const context = new OffscreenCanvas(width, height).getContext("2d", {
      willReadFrequently: true,
      alpha: false,
    });
    if (!context) {
      throw new LabError("Could not create an OffscreenCanvas 2D context", {
        code: "CONTEXT_UNAVAILABLE",
      });
    }
    return context;
  };

  /**
   * @param {OffscreenCanvasRenderingContext2D | null} context
   * @param {number} width
   * @param {number} height
   */
  const sized = (context, width, height) => {
    const ready = context ?? createContext(width, height);
    if (ready.canvas.width !== width || ready.canvas.height !== height) {
      ready.canvas.width = width;
      ready.canvas.height = height;
    }
    ready.setTransform(1, 0, 0, 1, 0, 0);
    ready.fillStyle = "#000";
    ready.fillRect(0, 0, width, height);
    return ready;
  };

  return {
    assertSupported() {
      if (typeof OffscreenCanvas === "undefined") {
        throw new LabError("OffscreenCanvas is not available in this worker", {
          code: "UNSUPPORTED_API",
        });
      }
    },

    detectorInput(frame, input) {
      const context = sized(detectorContext, input.paddedWidth, input.paddedHeight);
      detectorContext = context;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "medium";
      context.drawImage(frame, 0, 0, input.width, input.height);
      return context.getImageData(0, 0, input.paddedWidth, input.paddedHeight).data;
    },

    warp(frame, matrix, size) {
      const context = sized(cropContext, size, size);
      cropContext = context;
      // Bilinear sampling, like OpenCV's warpAffine with INTER_LINEAR in alignCrop.
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "low";
      context.setTransform(...canvasTransform(matrix));
      context.drawImage(frame, 0, 0);
      context.setTransform(1, 0, 0, 1, 0, 0);
      return context.getImageData(0, 0, size, size).data;
    },
  };
}
