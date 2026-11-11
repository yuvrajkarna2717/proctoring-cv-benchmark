import { describe, expect, it } from "vitest";
import {
  downscaleLuma,
  expandedPixelRect,
  laplacianVariance,
  normalizedSharpness,
  percentile,
  regionStats,
  resampleLuma,
} from "../../../src/engines/quality/imageStats.js";

const CLIP = { clipLow: 16, clipHigh: 245 };

/** A plane from a function of (x, y). */
function plane(width, height, f) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) out[y * width + x] = f(x, y);
  }
  return out;
}

/** A sharp checkerboard of 4-pixel squares between `low` and `high`. */
const checker = (width, height, low = 50, high = 200) =>
  plane(width, height, (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? high : low));

/** 3×3 box blur, applied `passes` times. */
function blur(values, width, height, passes = 3) {
  let current = values;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Float32Array(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const sx = x + dx;
            const sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            sum += current[sy * width + sx];
            count += 1;
          }
        }
        next[y * width + x] = sum / count;
      }
    }
    current = next;
  }
  return current;
}

describe("regionStats", () => {
  it("measures mean, RMS contrast, percentiles, and clipped fractions", () => {
    // Half the pixels at 10 (crushed), half at 250 (blown).
    const values = plane(10, 10, (x) => (x < 5 ? 10 : 250));
    expect(regionStats(values, 10, 10, CLIP)).toEqual({
      pixels: 100,
      meanLuma: 130,
      stdLuma: 120,
      p5: 10,
      p50: 10,
      p95: 250,
      darkFraction: 0.5,
      brightFraction: 0.5,
    });
  });

  it("limits to a rectangle and can leave one out", () => {
    const values = plane(10, 10, (x) => (x < 5 ? 100 : 200));
    const right = regionStats(values, 10, 10, {
      ...CLIP,
      rect: { x: 5, y: 0, width: 5, height: 10 },
    });
    expect(right).toMatchObject({ pixels: 50, meanLuma: 200 });
    const outsideLeft = regionStats(values, 10, 10, {
      ...CLIP,
      exclude: { x: 0, y: 0, width: 5, height: 10 },
    });
    expect(outsideLeft).toMatchObject({ pixels: 50, meanLuma: 200 });
    expect(
      regionStats(values, 10, 10, { ...CLIP, rect: { x: 20, y: 0, width: 5, height: 5 } }),
    ).toBeNull();
  });

  it("finds percentiles from a histogram", () => {
    const histogram = new Uint32Array(256);
    histogram[0] = 90;
    histogram[100] = 10;
    expect(percentile(histogram, 100, 0.5)).toBe(0);
    expect(percentile(histogram, 100, 0.95)).toBe(100);
  });
});

describe("expandedPixelRect", () => {
  it("adds the margin on every side, in pixels", () => {
    expect(expandedPixelRect({ x: 0.4, y: 0.2, width: 0.2, height: 0.5 }, 1000, 500, 0.1)).toEqual({
      x: 380,
      y: 75,
      width: 240,
      height: 300,
    });
  });

  it("clamps to the image and returns null when nothing is inside", () => {
    expect(expandedPixelRect({ x: -0.1, y: 0.9, width: 0.3, height: 0.3 }, 100, 100, 0)).toEqual({
      x: 0,
      y: 90,
      width: 20,
      height: 10,
    });
    expect(expandedPixelRect({ x: 1.2, y: 0, width: 0.1, height: 0.1 }, 100, 100, 0)).toBeNull();
  });
});

describe("downscaleLuma and resampleLuma", () => {
  it("averages the pixels each output pixel covers", () => {
    const values = plane(4, 2, (x) => x * 10); // 0 10 20 30
    expect(Array.from(downscaleLuma(values, 4, 2, 2, 1))).toEqual([5, 25]);
  });

  it("resamples a rectangle; same size reproduces it, a constant stays constant", () => {
    const values = plane(8, 8, (x, y) => x + 10 * y);
    const same = resampleLuma(values, 8, 8, { x: 2, y: 3, width: 4, height: 2 }, 4, 2);
    expect(Array.from(same)).toEqual([32, 33, 34, 35, 42, 43, 44, 45]);
    const constant = resampleLuma(
      plane(8, 8, () => 77),
      8,
      8,
      { x: 1, y: 1, width: 5, height: 5 },
      12,
      12,
    );
    expect(constant.every((value) => Math.abs(value - 77) < 1e-4)).toBe(true);
  });
});

describe("normalizedSharpness", () => {
  it("does not depend on contrast or brightness, unlike the Laplacian variance", () => {
    const sharp = checker(64, 64, 50, 200);
    const dim = checker(64, 64, 12.5, 50); // a quarter of the brightness and contrast
    const stdOf = (v) => regionStats(v, 64, 64, CLIP).stdLuma;
    expect(laplacianVariance(dim, 64, 64)).toBeCloseTo(laplacianVariance(sharp, 64, 64) / 16, 3);
    expect(normalizedSharpness(dim, 64, 64, stdOf(dim))).toBeCloseTo(
      normalizedSharpness(sharp, 64, 64, stdOf(sharp)),
      6,
    );
  });

  it("drops for a blurred edge and is NaN for a flat image", () => {
    // A step edge, like the outline of a face. (Fine periodic patterns are a poor test: blurring
    // a 4-pixel checkerboard leaves a pure high frequency, whose normalized value rises.)
    const sharp = plane(64, 64, (x) => (x < 32 ? 50 : 200));
    const blurred = blur(sharp, 64, 64);
    const stdOf = (v) => regionStats(v, 64, 64, CLIP).stdLuma;
    expect(normalizedSharpness(blurred, 64, 64, stdOf(blurred))).toBeLessThan(
      normalizedSharpness(sharp, 64, 64, stdOf(sharp)) / 10,
    );
    expect(
      normalizedSharpness(
        plane(8, 8, () => 5),
        8,
        8,
        0,
      ),
    ).toBeNaN();
  });
});
