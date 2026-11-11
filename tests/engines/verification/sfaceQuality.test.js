import { describe, expect, it } from "vitest";
import {
  landmarkGeometry,
  laplacianVariance,
  lumaFromRgba,
  mean,
} from "../../../src/engines/verification/quality.js";
import { l2Normalize, rgbaToRgbPlanar } from "../../../src/engines/verification/sface.js";

describe("SFace input and embeddings", () => {
  it("converts RGBA pixels to planar RGB with values 0-255", () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(Array.from(rgbaToRgbPlanar(rgba, 2, 1))).toEqual([10, 40, 20, 50, 30, 60]);
  });

  it("normalizes embeddings to unit length and rejects zero or invalid vectors", () => {
    const unit = l2Normalize([3, 4]);
    expect(Array.from(unit)).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(l2Normalize([0, 0])).toBeNull();
    expect(l2Normalize([1, Number.NaN])).toBeNull();
  });
});

describe("face quality measurements", () => {
  /** @param {(x: number, y: number) => number} value */
  const grayImage = (width, height, value) => {
    const gray = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) gray[y * width + x] = value(x, y);
    return gray;
  };

  it("computes Rec. 709 luma and its mean", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const luma = lumaFromRgba(rgba, 3, 1);
    expect(luma[0]).toBeCloseTo(255, 4);
    expect(luma[1]).toBe(0);
    expect(luma[2]).toBeCloseTo(0.2126 * 255, 4);
    expect(mean([1, 2, 3, 6])).toBe(3);
  });

  it("rates flat and linear images as having no detail and a checkerboard as sharp", () => {
    expect(
      laplacianVariance(
        grayImage(8, 8, () => 120),
        8,
        8,
      ),
    ).toBe(0);
    expect(
      laplacianVariance(
        grayImage(8, 8, (x, y) => 10 * x + 3 * y),
        8,
        8,
      ),
    ).toBeCloseTo(0, 6);
    const checker = laplacianVariance(
      grayImage(8, 8, (x, y) => ((x + y) % 2) * 100),
      8,
      8,
    );
    expect(checker).toBeGreaterThan(1000);
  });

  it("derives roll and a yaw proxy from the eye line and the nose", () => {
    const frontal = landmarkGeometry([100, 100, 160, 100, 130, 130, 110, 160, 150, 160]);
    expect(frontal).toEqual({ interEyePx: 60, rollDeg: 0, yawRatio: 0 });
    const tilted = landmarkGeometry([0, 0, 30 * Math.sqrt(3), 30, 0, 0, 0, 0, 0, 0]);
    expect(tilted.rollDeg).toBeCloseTo(30, 10);
    expect(tilted.interEyePx).toBeCloseTo(60, 10);
    const turned = landmarkGeometry([100, 100, 160, 100, 145, 130, 110, 160, 150, 160]);
    expect(turned.yawRatio).toBeCloseTo(0.25, 10); // nose 15 px right of the midpoint, eyes 60 px apart
  });
});
