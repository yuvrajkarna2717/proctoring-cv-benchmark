/** Width of the thumbnail shown in lists. */
const THUMBNAIL_WIDTH = 192;
const THUMBNAIL_QUALITY = 0.7;

/**
 * @typedef {{ image: Blob, thumbnail: Blob, width: number, height: number }} CapturedFrame
 * @typedef {(video: HTMLVideoElement, options: { maxWidth: number, jpegQuality: number })
 *   => Promise<CapturedFrame | null>} CaptureFrame
 */

/**
 * The video element's current frame as a JPEG (at most `maxWidth` wide) and a small thumbnail.
 * The image is the camera's own orientation: the preview's mirroring is CSS and does not apply.
 * The frame is drawn synchronously, before the first await; encoding is asynchronous.
 *
 * @type {CaptureFrame}
 * @returns {Promise<CapturedFrame | null>} null before the first frame or outside a browser
 */
export async function captureVideoFrame(video, { maxWidth, jpegQuality }) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.min(1, maxWidth / sourceWidth);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  const thumbnailWidth = Math.min(THUMBNAIL_WIDTH, width);
  const thumbnailHeight = Math.max(1, Math.round((height * thumbnailWidth) / width));
  const canvas = createCanvas(width, height);
  const thumbnailCanvas = createCanvas(thumbnailWidth, thumbnailHeight);
  const context = canvas?.getContext("2d");
  const thumbnailContext = thumbnailCanvas?.getContext("2d");
  if (!canvas || !thumbnailCanvas || !context || !thumbnailContext) return null;
  context.drawImage(video, 0, 0, width, height);
  thumbnailContext.drawImage(canvas, 0, 0, thumbnailWidth, thumbnailHeight);
  const [image, thumbnail] = await Promise.all([
    encodeJpeg(canvas, jpegQuality),
    encodeJpeg(thumbnailCanvas, THUMBNAIL_QUALITY),
  ]);
  return { image, thumbnail, width, height };
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvas | HTMLCanvasElement | null}
 */
function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * @param {OffscreenCanvas | HTMLCanvasElement} canvas
 * @param {number} quality
 * @returns {Promise<Blob>}
 */
function encodeJpeg(canvas, quality) {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("JPEG encoding failed"))),
      "image/jpeg",
      quality,
    );
  });
}
