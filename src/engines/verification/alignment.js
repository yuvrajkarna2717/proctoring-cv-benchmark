/**
 * Five-point face alignment for SFace, as in OpenCV's `FaceRecognizerSF::alignCrop`
 * (`modules/objdetect/src/face_recognize.cpp`, 4.x): a similarity transform (rotation, uniform
 * scale, translation) that maps the detector's five landmarks onto a fixed template in a
 * 112×112 crop, applied with bilinear sampling.
 *
 * @typedef {[number, number, number, number, number, number]} AffineMatrix
 *   [m00, m01, m02, m10, m11, m12]: x' = m00·x + m01·y + m02, y' = m10·x + m11·y + m12
 */

export const SFACE_CROP_SIZE = 112;

/**
 * Template landmarks of OpenCV's alignCrop (the ArcFace template) in the 112×112 crop: right
 * eye, left eye, nose tip, right and left mouth corner, in the same order as YuNet's landmarks.
 */
export const SFACE_TEMPLATE = Object.freeze([
  38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041,
]);

/**
 * Least-squares similarity transform from `source` to `target` points without reflection. For
 * two dimensions this closed form gives the same result as Umeyama's method, which OpenCV uses
 * (including its sign correction against reflections).
 *
 * @param {ArrayLike<number>} source x, y pairs
 * @param {ArrayLike<number>} [target] x, y pairs, same count
 * @returns {AffineMatrix | null} null when the source points coincide
 */
export function similarityTransform(source, target = SFACE_TEMPLATE) {
  const count = source.length / 2;
  let sourceMeanX = 0;
  let sourceMeanY = 0;
  let targetMeanX = 0;
  let targetMeanY = 0;
  for (let i = 0; i < count; i += 1) {
    sourceMeanX += source[i * 2];
    sourceMeanY += source[i * 2 + 1];
    targetMeanX += target[i * 2];
    targetMeanY += target[i * 2 + 1];
  }
  sourceMeanX /= count;
  sourceMeanY /= count;
  targetMeanX /= count;
  targetMeanY /= count;

  let dot = 0; // Σ p·q
  let cross = 0; // Σ p×q
  let sourceVariance = 0; // Σ |p|²
  for (let i = 0; i < count; i += 1) {
    const px = source[i * 2] - sourceMeanX;
    const py = source[i * 2 + 1] - sourceMeanY;
    const qx = target[i * 2] - targetMeanX;
    const qy = target[i * 2 + 1] - targetMeanY;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    sourceVariance += px * px + py * py;
  }
  const norm = Math.hypot(dot, cross);
  if (sourceVariance === 0 || norm === 0) return null;
  const scale = norm / sourceVariance;
  const cos = (dot / norm) * scale;
  const sin = (cross / norm) * scale;
  return [
    cos,
    -sin,
    targetMeanX - (cos * sourceMeanX - sin * sourceMeanY),
    sin,
    cos,
    targetMeanY - (sin * sourceMeanX + cos * sourceMeanY),
  ];
}

/**
 * @param {AffineMatrix} matrix
 * @param {number} x
 * @param {number} y
 * @returns {[number, number]}
 */
export function applyAffine(matrix, x, y) {
  const [m00, m01, m02, m10, m11, m12] = matrix;
  return [m00 * x + m01 * y + m02, m10 * x + m11 * y + m12];
}

/**
 * Arguments for `CanvasRenderingContext2D.setTransform(a, b, c, d, e, f)` that apply `matrix`
 * with OpenCV's pixel convention. OpenCV puts pixel centres at integer coordinates; a canvas puts
 * them at +0.5, so the translation is corrected by half a pixel on both sides.
 *
 * @param {AffineMatrix} matrix
 * @returns {[number, number, number, number, number, number]}
 */
export function canvasTransform(matrix) {
  const [m00, m01, m02, m10, m11, m12] = matrix;
  return [m00, m10, m01, m11, m02 + 0.5 - 0.5 * (m00 + m01), m12 + 0.5 - 0.5 * (m10 + m11)];
}

/**
 * A transform that maps a square of `size` source pixels at (`left`, `top`) onto the crop, for
 * the diagnostic center-crop embedding when no face is found.
 *
 * @param {number} left
 * @param {number} top
 * @param {number} size
 * @returns {AffineMatrix}
 */
export function squareCropTransform(left, top, size) {
  const scale = SFACE_CROP_SIZE / size;
  return [scale, 0, -left * scale, 0, scale, -top * scale];
}
