import { LabError } from "../../utils/errors.js";

/**
 * Draws a frame into a square model input on an OffscreenCanvas (worker) and returns its RGBA
 * pixels: the frame scaled to `width` × `height` at (`offsetX`, `offsetY`), the rest filled with
 * `fill` grey. Kept apart from the engine so unit tests can replace it.
 *
 * @returns {(frame: CanvasImageSource, box: import('./onnxDetectors.js').Letterbox) => Uint8ClampedArray}
 */
export function createLetterboxCanvas() {
  /** @type {OffscreenCanvasRenderingContext2D | null} */
  let context = null;
  return (frame, box) => {
    if (typeof OffscreenCanvas === "undefined") {
      throw new LabError("OffscreenCanvas is not available in this worker", {
        code: "UNSUPPORTED_API",
      });
    }
    if (!context) {
      context = new OffscreenCanvas(box.size, box.size).getContext("2d", {
        willReadFrequently: true,
        alpha: false,
      });
      if (!context) {
        throw new LabError("Could not create an OffscreenCanvas 2D context", {
          code: "CONTEXT_UNAVAILABLE",
        });
      }
    }
    if (context.canvas.width !== box.size || context.canvas.height !== box.size) {
      context.canvas.width = box.size;
      context.canvas.height = box.size;
    }
    context.fillStyle = `rgb(${box.fill}, ${box.fill}, ${box.fill})`;
    context.fillRect(0, 0, box.size, box.size);
    context.imageSmoothingEnabled = true;
    // Downscaling a 720p frame by about 2–3: "high" approximates OpenCV's INTER_AREA.
    context.imageSmoothingQuality = "high";
    context.drawImage(frame, box.offsetX, box.offsetY, box.width, box.height);
    return context.getImageData(0, 0, box.size, box.size).data;
  };
}
