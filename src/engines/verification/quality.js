/**
 * Image and pose measurements of one face, reported with each embedding so the main thread can
 * gate enrollment and record capture conditions. Values are measurements, not decisions; the
 * thresholds live in the lab configuration.
 */

/**
 * Rec. 709 luma of gamma-encoded RGBA pixels (same formula as the diagnostic probe).
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 */
export function lumaFromRgba(rgba, width, height) {
  const luma = new Float32Array(width * height);
  for (let pixel = 0, i = 0; pixel < luma.length; pixel += 1, i += 4) {
    luma[pixel] = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
  }
  return luma;
}

/** @param {ArrayLike<number>} values */
export function mean(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return values.length > 0 ? sum / values.length : NaN;
}

/**
 * Variance of the 4-neighbour Laplacian over the interior pixels, a common sharpness measure
 * (OpenCV `Laplacian` with `ksize = 1`, then the variance). Lower means blurrier. It depends on
 * image content and size, so thresholds must be set for one crop size (here 112×112).
 *
 * @param {ArrayLike<number>} gray
 * @param {number} width
 * @param {number} height
 */
export function laplacianVariance(gray, width, height) {
  if (width < 3 || height < 3) return NaN;
  let sum = 0;
  let sumOfSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const value = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += value;
      sumOfSquares += value * value;
      count += 1;
    }
  }
  const average = sum / count;
  return sumOfSquares / count - average * average;
}

/**
 * Head-pose proxies from the five landmarks (frame pixels):
 * - `interEyePx`: distance between the eyes.
 * - `rollDeg`: angle of the line from the right eye to the left eye; 0 when level.
 * - `yawRatio`: offset of the nose tip from the eye midpoint along the eye line, in inter-eye
 *   distances; about 0 for a frontal face, sign shows the direction of the turn. A rough proxy
 *   for yaw; Phase 4 measures head pose properly.
 *
 * @param {ArrayLike<number>} landmarks right eye, left eye, nose, right and left mouth corner
 */
export function landmarkGeometry(landmarks) {
  const eyeDx = landmarks[2] - landmarks[0];
  const eyeDy = landmarks[3] - landmarks[1];
  const interEyePx = Math.hypot(eyeDx, eyeDy);
  const midX = (landmarks[0] + landmarks[2]) / 2;
  const midY = (landmarks[1] + landmarks[3]) / 2;
  const yawRatio =
    interEyePx > 0
      ? ((landmarks[4] - midX) * eyeDx + (landmarks[5] - midY) * eyeDy) / (interEyePx * interEyePx)
      : NaN;
  return {
    interEyePx,
    rollDeg: (Math.atan2(eyeDy, eyeDx) * 180) / Math.PI,
    yawRatio,
  };
}
