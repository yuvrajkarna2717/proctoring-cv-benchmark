import { describe, expect, it } from "vitest";
import {
  SFACE_TEMPLATE,
  applyAffine,
  canvasTransform,
  similarityTransform,
  squareCropTransform,
} from "../../../src/engines/verification/alignment.js";

/** Source landmarks that a known similarity transform maps exactly onto the template. */
function landmarksFor({ scale, angleDeg, tx, ty }) {
  const angle = (angleDeg * Math.PI) / 180;
  const source = [];
  for (let i = 0; i < 5; i += 1) {
    // q = s·R·p + t  =>  p = R⁻¹ (q − t) / s
    const qx = SFACE_TEMPLATE[i * 2] - tx;
    const qy = SFACE_TEMPLATE[i * 2 + 1] - ty;
    source.push((Math.cos(angle) * qx + Math.sin(angle) * qy) / scale);
    source.push((-Math.sin(angle) * qx + Math.cos(angle) * qy) / scale);
  }
  return source;
}

describe("five-point similarity transform", () => {
  it("is the identity for landmarks already on the template", () => {
    const matrix = similarityTransform(SFACE_TEMPLATE);
    [1, 0, 0, 0, 1, 0].forEach((value, index) => expect(matrix[index]).toBeCloseTo(value, 10));
  });

  it("recovers rotation, scale, and translation exactly", () => {
    const truth = { scale: 0.45, angleDeg: 12, tx: -180, ty: -95 };
    const source = landmarksFor(truth);
    const matrix = similarityTransform(source);
    const angle = (truth.angleDeg * Math.PI) / 180;
    const expected = [
      truth.scale * Math.cos(angle),
      -truth.scale * Math.sin(angle),
      truth.tx,
      truth.scale * Math.sin(angle),
      truth.scale * Math.cos(angle),
      truth.ty,
    ];
    expected.forEach((value, index) => expect(matrix[index]).toBeCloseTo(value, 9));
    for (let i = 0; i < 5; i += 1) {
      const [x, y] = applyAffine(matrix, source[i * 2], source[i * 2 + 1]);
      expect(x).toBeCloseTo(SFACE_TEMPLATE[i * 2], 9);
      expect(y).toBeCloseTo(SFACE_TEMPLATE[i * 2 + 1], 9);
    }
  });

  it("never mirrors, even when the landmarks are mirrored", () => {
    const mirrored = landmarksFor({ scale: 0.5, angleDeg: 0, tx: 0, ty: 0 }).map((value, index) =>
      index % 2 === 0 ? -value : value,
    );
    const [m00, m01, , m10, m11] = similarityTransform(mirrored);
    expect(m00 * m11 - m01 * m10).toBeGreaterThan(0); // positive determinant: no reflection
  });

  it("returns null when the landmarks coincide", () => {
    expect(similarityTransform(new Array(10).fill(3))).toBeNull();
  });
});

describe("canvas transform", () => {
  it("applies OpenCV's pixel-centre convention on a canvas", () => {
    const matrix = similarityTransform(landmarksFor({ scale: 0.4, angleDeg: -8, tx: -60, ty: 10 }));
    const [a, b, c, d, e, f] = canvasTransform(matrix);
    // A source pixel centre is at x + 0.5 on a canvas; it must land 0.5 after OpenCV's target.
    for (const [x, y] of [
      [0, 0],
      [300, 120],
      [77.25, 410.5],
    ]) {
      const [cvX, cvY] = applyAffine(matrix, x, y);
      expect(a * (x + 0.5) + c * (y + 0.5) + e).toBeCloseTo(cvX + 0.5, 9);
      expect(b * (x + 0.5) + d * (y + 0.5) + f).toBeCloseTo(cvY + 0.5, 9);
    }
  });

  it("maps a square of the frame onto the 112×112 crop", () => {
    const matrix = squareCropTransform(100, 50, 224);
    expect(applyAffine(matrix, 100, 50)).toEqual([0, 0]);
    expect(applyAffine(matrix, 324, 274)).toEqual([112, 112]);
  });
});
