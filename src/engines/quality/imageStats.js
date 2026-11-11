import { laplacianVariance, lumaFromRgba } from "../verification/quality.js";

/**
 * Pixel statistics for the image-quality engine. Pure functions on luma planes (Rec. 709 luma
 * of gamma-encoded pixels, 0–255), no browser APIs.
 *
 * Values are measurements, not decisions; the main thread compares them with configurable
 * limits (src/quality/qualityModel.js).
 */

export { laplacianVariance, lumaFromRgba };

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} PixelRect integer pixels
 *
 * @typedef {Object} RegionStats
 * @property {number} pixels pixels measured
 * @property {number} meanLuma
 * @property {number} stdLuma RMS contrast
 * @property {number} p5 5th percentile of luma
 * @property {number} p50 median
 * @property {number} p95
 * @property {number} darkFraction share of pixels at or below `clipLow` (crushed shadows)
 * @property {number} brightFraction share of pixels at or above `clipHigh` (blown highlights)
 */

/**
 * Luma statistics of a region (or the whole plane), optionally leaving out a rectangle.
 *
 * @param {ArrayLike<number>} luma row-major plane
 * @param {number} width
 * @param {number} height
 * @param {{ clipLow: number, clipHigh: number, rect?: PixelRect | null, exclude?: PixelRect | null }} options
 * @returns {RegionStats | null} null when no pixel is in the region
 */
export function regionStats(
  luma,
  width,
  height,
  { clipLow, clipHigh, rect = null, exclude = null },
) {
  const area = rect ?? { x: 0, y: 0, width, height };
  const x0 = Math.max(0, area.x);
  const y0 = Math.max(0, area.y);
  const x1 = Math.min(width, area.x + area.width);
  const y1 = Math.min(height, area.y + area.height);
  const histogram = new Uint32Array(256);
  let count = 0;
  let sum = 0;
  let sumOfSquares = 0;
  let dark = 0;
  let bright = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (exclude && inside(x, y, exclude)) continue;
      const value = luma[y * width + x];
      histogram[Math.min(255, Math.max(0, Math.round(value)))] += 1;
      sum += value;
      sumOfSquares += value * value;
      if (value <= clipLow) dark += 1;
      if (value >= clipHigh) bright += 1;
      count += 1;
    }
  }
  if (count === 0) return null;
  const meanLuma = sum / count;
  return {
    pixels: count,
    meanLuma,
    stdLuma: Math.sqrt(Math.max(0, sumOfSquares / count - meanLuma * meanLuma)),
    p5: percentile(histogram, count, 0.05),
    p50: percentile(histogram, count, 0.5),
    p95: percentile(histogram, count, 0.95),
    darkFraction: dark / count,
    brightFraction: bright / count,
  };
}

/**
 * Smallest luma value with at least `fraction` of the pixels at or below it.
 *
 * @param {Uint32Array} histogram 256 bins
 * @param {number} count
 * @param {number} fraction
 */
export function percentile(histogram, count, fraction) {
  const target = Math.max(1, Math.ceil(count * fraction));
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

/**
 * Sharpness independent of contrast: the Laplacian variance divided by the luma variance.
 *
 * The Laplacian variance alone scales with the square of the contrast, so a dark or flat but
 * sharp face scores as low as a blurred one. On a public-domain portrait (face resampled to
 * 112 px wide, frame read at 1280 px), the plain image, the same image darkened to a quarter of
 * its brightness, and the same image blurred (5 px Gaussian) gave Laplacian variances of 1005,
 * 62, and 4.8, and normalized values of 0.28, 0.28, and 0.0018. Sensor noise raises both (noise
 * looks like detail), so very dark, noisy frames can score as sharp.
 *
 * @param {ArrayLike<number>} gray
 * @param {number} width
 * @param {number} height
 * @param {number} std standard deviation of `gray`
 * @returns {number} NaN for a flat image
 */
export function normalizedSharpness(gray, width, height, std) {
  return std > 0 ? laplacianVariance(gray, width, height) / (std * std) : NaN;
}

/**
 * Box-filter downscale of a luma plane (each output pixel is the mean of the input pixels it
 * covers). For integer and non-integer factors; never upscales.
 *
 * @param {ArrayLike<number>} luma
 * @param {number} width
 * @param {number} height
 * @param {number} outWidth at most `width`
 * @param {number} outHeight at most `height`
 * @returns {Float32Array}
 */
export function downscaleLuma(luma, width, height, outWidth, outHeight) {
  const out = new Float32Array(outWidth * outHeight);
  const counts = new Uint32Array(outWidth * outHeight);
  const scaleX = outWidth / width;
  const scaleY = outHeight / height;
  for (let y = 0; y < height; y += 1) {
    const outRow = Math.min(outHeight - 1, Math.floor(y * scaleY)) * outWidth;
    for (let x = 0; x < width; x += 1) {
      const index = outRow + Math.min(outWidth - 1, Math.floor(x * scaleX));
      out[index] += luma[y * width + x];
      counts[index] += 1;
    }
  }
  for (let i = 0; i < out.length; i += 1) out[i] = counts[i] > 0 ? out[i] / counts[i] : 0;
  return out;
}

/**
 * Bilinear resample of a rectangle of a luma plane to outWidth × outHeight (up or down).
 * Downscaling by large factors aliases a little; the face crop is scaled by about 0.3–3.
 *
 * @param {ArrayLike<number>} luma
 * @param {number} width
 * @param {number} height
 * @param {PixelRect} rect inside the plane
 * @param {number} outWidth
 * @param {number} outHeight
 * @returns {Float32Array}
 */
export function resampleLuma(luma, width, height, rect, outWidth, outHeight) {
  const out = new Float32Array(outWidth * outHeight);
  const stepX = rect.width / outWidth;
  const stepY = rect.height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    // Pixel centres: output pixel y covers [y, y + 1) and maps to its centre in the source.
    const sy = Math.min(height - 1, Math.max(0, rect.y + (y + 0.5) * stepY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < outWidth; x += 1) {
      const sx = Math.min(width - 1, Math.max(0, rect.x + (x + 0.5) * stepX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const top = luma[y0 * width + x0] * (1 - fx) + luma[y0 * width + x1] * fx;
      const bottom = luma[y1 * width + x0] * (1 - fx) + luma[y1 * width + x1] * fx;
      out[y * outWidth + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/**
 * A normalized face box expanded by `marginRatio` of its size on every side, in pixels of an
 * image of the given size, clamped to the image. null when nothing of it is inside.
 *
 * @param {{ x: number, y: number, width: number, height: number }} box normalized 0–1
 * @param {number} width image width in pixels
 * @param {number} height
 * @param {number} marginRatio
 * @returns {PixelRect | null}
 */
export function expandedPixelRect(box, width, height, marginRatio) {
  const marginX = box.width * marginRatio;
  const marginY = box.height * marginRatio;
  // The small tolerance keeps rounding error (0.62 × 1000 = 620.0000000001) from adding a pixel.
  const floor = (/** @type {number} */ value) => Math.floor(value + 1e-6);
  const ceil = (/** @type {number} */ value) => Math.ceil(value - 1e-6);
  const left = Math.max(0, floor((box.x - marginX) * width));
  const top = Math.max(0, floor((box.y - marginY) * height));
  const right = Math.min(width, ceil((box.x + box.width + marginX) * width));
  const bottom = Math.min(height, ceil((box.y + box.height + marginY) * height));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {PixelRect} rect
 */
function inside(x, y, rect) {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
