/**
 * SFace face recognizer (OpenCV Zoo `face_recognition_sface_2021dec[_int8].onnx`): input
 * preparation and embedding normalization. OpenCV's `FaceRecognizerSF::feature` feeds the
 * aligned 112×112 crop through `blobFromImage(crop, 1, Size(112, 112), Scalar(0, 0, 0),
 * swapRB = true)`: RGB order, values 0–255, no mean or scale. `match()` compares L2-normalized
 * features; cosine similarity ≥ 0.363 is OpenCV Zoo's default "same identity" threshold.
 */

export const SFACE_EMBEDDING_SIZE = 128;

/**
 * Canvas RGBA pixels → planar float32 in RGB order with values 0–255.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} [out]
 */
export function rgbaToRgbPlanar(rgba, width, height, out = new Float32Array(3 * width * height)) {
  const plane = width * height;
  for (let pixel = 0, i = 0; pixel < plane; pixel += 1, i += 4) {
    out[pixel] = rgba[i];
    out[plane + pixel] = rgba[i + 1];
    out[2 * plane + pixel] = rgba[i + 2];
  }
  return out;
}

/**
 * A new L2-normalized copy, so the cosine similarity of two embeddings is their dot product.
 *
 * @param {ArrayLike<number>} vector
 * @returns {Float32Array | null} null when the vector is zero or not finite
 */
export function l2Normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return null;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}
