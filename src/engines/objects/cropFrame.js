/**
 * Crops a rectangle of a frame and scales it to `size` × `size` (worker-side, for the zoom
 * pass). Kept apart from the engines so unit tests can replace it.
 *
 * @param {ImageBitmap | VideoFrame} frame
 * @param {import('./tiles.js').Rect} rect frame pixels
 * @param {number} size output side in pixels
 * @returns {Promise<ImageBitmap>}
 */
export function cropFrame(frame, rect, size) {
  return createImageBitmap(
    /** @type {ImageBitmapSource} */ (frame),
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    { resizeWidth: size, resizeHeight: size, resizeQuality: "high" },
  );
}
