import { describe, expect, it } from "vitest";
import {
  attentionObservations,
  largestFaceIndex,
} from "../../src/engines/face/FaceLandmarkerEngine.js";
import {
  EYE_MODEL,
  LANDMARKS,
  blendshapeScore,
  eyeMeasures,
  gazeAngles,
  headPoseFromMatrix,
} from "../../src/engines/face/faceGeometry.js";

const RAD = Math.PI / 180;

/** 3×3 product. @param {number[][]} a @param {number[][]} b */
const multiply = (a, b) =>
  a.map((row) => [0, 1, 2].map((j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));

/**
 * MediaPipe-style transformation matrix (camera space: X right in the image, Y up, Z toward the
 * camera) for a head turned to the person's right by `yaw`, up by `pitch`, tilted toward the
 * right shoulder by `roll` (degrees), 50 cm in front of the camera.
 */
function poseMatrix({ yaw = 0, pitch = 0, roll = 0 }, layout = "column-major") {
  const a = -yaw * RAD;
  const b = -pitch * RAD;
  const c = roll * RAD;
  const ry = [
    [Math.cos(a), 0, Math.sin(a)],
    [0, 1, 0],
    [-Math.sin(a), 0, Math.cos(a)],
  ];
  const rx = [
    [1, 0, 0],
    [0, Math.cos(b), -Math.sin(b)],
    [0, Math.sin(b), Math.cos(b)],
  ];
  const rz = [
    [Math.cos(c), -Math.sin(c), 0],
    [Math.sin(c), Math.cos(c), 0],
    [0, 0, 1],
  ];
  const r = multiply(multiply(ry, rx), rz);
  const m = [
    [...r[0], 1.5],
    [...r[1], -2],
    [...r[2], -50],
    [0, 0, 0, 1],
  ];
  const data = [];
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      data.push(layout === "column-major" ? m[j][i] : m[i][j]);
    }
  }
  return data;
}

describe("headPoseFromMatrix", () => {
  it("recovers yaw and pitch with the person's-view signs, in either layout", () => {
    for (const layout of ["column-major", "row-major"]) {
      const pose = headPoseFromMatrix(poseMatrix({ yaw: 25, pitch: -10 }, layout));
      expect(pose).toMatchObject({ layout });
      expect(pose.yawDeg).toBeCloseTo(25, 6);
      expect(pose.pitchDeg).toBeCloseTo(-10, 6);
      expect(pose.distanceCm).toBeCloseTo(Math.hypot(1.5, 2, 50), 6);
    }
    expect(headPoseFromMatrix(poseMatrix({ yaw: -40 })).yawDeg).toBeCloseTo(-40, 6);
    expect(headPoseFromMatrix(poseMatrix({ pitch: 15 })).pitchDeg).toBeCloseTo(15, 6);
  });

  it("recovers roll toward the right shoulder as positive", () => {
    expect(headPoseFromMatrix(poseMatrix({ roll: 12 })).rollDeg).toBeCloseTo(12, 6);
    expect(headPoseFromMatrix(poseMatrix({ roll: -20 })).rollDeg).toBeCloseTo(-20, 6);
  });

  it("matches a matrix MediaPipe produced for a portrait with the head turned to the person's right", () => {
    // Face Landmarker 1.2.2 on a public-domain portrait (Vermeer, about 1665): the head is
    // turned about 35–40° toward the person's right (the image's left), slightly lowered.
    const measured = [
      0.794, -0.257, 0.551, 0, 0.055, 0.933, 0.355, 0, -0.606, -0.251, 0.755, 0, -2.197, 4.032,
      -46.203, 1,
    ];
    const pose = headPoseFromMatrix(measured);
    expect(pose.layout).toBe("column-major");
    // The fixture is rounded to 3 decimals, so allow 0.1°.
    expect(Math.abs(pose.yawDeg - 38.73)).toBeLessThan(0.1);
    expect(Math.abs(pose.pitchDeg + 14.56)).toBeLessThan(0.1);
    expect(Math.abs(pose.distanceCm - 46.4)).toBeLessThan(0.1);
  });

  it("rejects malformed matrices", () => {
    expect(headPoseFromMatrix([1, 0, 0])).toBeNull();
    expect(headPoseFromMatrix(new Array(16).fill(Number.NaN))).toBeNull();
    expect(headPoseFromMatrix(new Array(16).fill(0))).toBeNull();
  });
});

/**
 * 478 landmarks in a 1000 × 1000 image: eyes 60 px wide on y = 500, the person's right eye on
 * the image's left. `irisShift` moves both irises along x (pixels), `lid` is the half lid
 * opening (pixels).
 */
function faceLandmarks({ irisShift = 0, irisDrop = 0, lid = 10, count = 478 } = {}) {
  const flat = new Float32Array(count * 3).fill(0.5);
  /** @param {number} index @param {number} x @param {number} y */
  const set = (index, x, y) => {
    flat[index * 3] = x / 1000;
    flat[index * 3 + 1] = y / 1000;
  };
  const eye = (/** @type {{ ear: number[] }} */ indices, /** @type {number} */ outerX, sign) => {
    const [p1, p2, p3, p4, p5, p6] = indices.ear;
    const innerX = outerX + sign * 60;
    set(p1, outerX, 500);
    set(p4, innerX, 500);
    set(p2, outerX + sign * 20, 500 - lid);
    set(p3, outerX + sign * 40, 500 - lid);
    set(p6, outerX + sign * 20, 500 + lid);
    set(p5, outerX + sign * 40, 500 + lid);
  };
  eye(LANDMARKS.rightEye, 400, 1);
  eye(LANDMARKS.leftEye, 600, -1);
  if (count >= 478) {
    // Index order deliberately swapped: the ring nearer each eye is used.
    set(473, 430 + irisShift, 500 + irisDrop);
    set(468, 570 + irisShift, 500 + irisDrop);
  }
  return flat;
}

describe("eyeMeasures", () => {
  it("measures eye width, aspect ratio, and iris offsets in eye widths", () => {
    const eyes = eyeMeasures(faceLandmarks({ irisShift: -6, irisDrop: 3 }), 1000, 1000);
    expect(eyes.right.widthPx).toBeCloseTo(60, 3);
    expect(eyes.left.widthPx).toBeCloseTo(60, 3);
    expect(eyes.interocularPx).toBeCloseTo(140, 3);
    expect(eyes.right.ear).toBeCloseTo(20 / 60, 3);
    // Toward the image's left (−x) and down (+y), in eye widths.
    expect(eyes.right.irisX).toBeCloseTo(-0.1, 3);
    expect(eyes.left.irisX).toBeCloseTo(-0.1, 3);
    expect(eyes.right.irisY).toBeCloseTo(0.05, 3);
  });

  it("reports a lower aspect ratio for closing lids", () => {
    const open = eyeMeasures(faceLandmarks({ lid: 10 }), 1000, 1000);
    const closing = eyeMeasures(faceLandmarks({ lid: 2 }), 1000, 1000);
    expect(closing.left.ear).toBeLessThan(open.left.ear / 4);
  });

  it("has no iris offsets without the iris landmarks, and nothing without eye landmarks", () => {
    const eyes = eyeMeasures(faceLandmarks({ count: 468 }), 1000, 1000);
    expect(eyes.right.irisX).toBeNull();
    expect(eyeMeasures(new Float32Array(30), 1000, 1000)).toBeNull();
  });
});

describe("gazeAngles", () => {
  const frontal = { yawDeg: 0, pitchDeg: 0 };

  it("is straight ahead for centred irises and a frontal head", () => {
    // Landmarks are float32, so allow 0.001°.
    const gaze = gazeAngles(eyeMeasures(faceLandmarks(), 1000, 1000), frontal);
    expect(gaze.yawDeg).toBeCloseTo(0, 3);
    expect(gaze.pitchDeg).toBeCloseTo(0, 3);
  });

  it("turns irises toward the image's left into gaze to the person's right, and down into negative pitch", () => {
    const gaze = gazeAngles(
      eyeMeasures(faceLandmarks({ irisShift: -6, irisDrop: 6 }), 1000, 1000),
      frontal,
    );
    const expected = Math.asin(0.1 / EYE_MODEL.IRIS_RADIUS_RATIO) / RAD;
    expect(gaze.yawDeg).toBeCloseTo(expected, 3);
    expect(gaze.pitchDeg).toBeCloseTo(-expected, 3);
    expect(gaze.eyeYawDeg).toBeCloseTo(expected, 3);
  });

  it("puts gaze near the camera for a portrait with the head turned and the eyes on the viewer", () => {
    // Measured on the same portrait as the matrix test: iris offsets and head pose as the
    // engine reported them. Head alone: 38.7° right; gaze (head + eyes) within a few degrees.
    const eyes = {
      right: { widthPx: 24.5, ear: 0.5, irisX: 0.0767, irisY: -0.0677 },
      left: { widthPx: 24.5, ear: 0.4, irisX: 0.0767, irisY: -0.0677 },
      interocularPx: 62.6,
    };
    const gaze = gazeAngles(eyes, { yawDeg: 38.73, pitchDeg: -14.56 });
    expect(Math.abs(gaze.yawDeg)).toBeLessThan(7);
    expect(Math.abs(gaze.pitchDeg)).toBeLessThan(7);
    expect(gaze.eyeYawDeg).toBeLessThan(-30);
  });

  it("weights eyes by apparent width and leaves out skipped eyes", () => {
    const eyes = {
      right: { widthPx: 30, ear: 0.3, irisX: 0.1, irisY: 0 },
      left: { widthPx: 10, ear: 0.3, irisX: -0.1, irisY: 0 },
      interocularPx: 60,
    };
    expect(gazeAngles(eyes, frontal).irisX).toBeCloseTo(0.05, 6);
    expect(gazeAngles(eyes, frontal, { skip: ["right"] }).irisX).toBeCloseTo(-0.1, 6);
    expect(gazeAngles(eyes, frontal, { skip: ["right", "left"] })).toBeNull();
  });
});

describe("attentionObservations (FaceLandmarkerEngine)", () => {
  const options = { outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true };
  /** @param {Float32Array} flat */
  const toObjects = (flat) =>
    Array.from({ length: flat.length / 3 }, (_, i) => ({
      x: flat[i * 3],
      y: flat[i * 3 + 1],
      z: flat[i * 3 + 2],
    }));
  /** @param {{ blinkLeft?: number, blinkRight?: number, matrix?: boolean }} [o] */
  const result = ({ blinkLeft = 0.05, blinkRight = 0.05, matrix = true } = {}) => ({
    faceLandmarks: [toObjects(faceLandmarks({ irisShift: -6 }))],
    faceBlendshapes: [
      {
        categories: [
          { categoryName: "eyeBlinkLeft", score: blinkLeft },
          { categoryName: "eyeBlinkRight", score: blinkRight },
        ],
      },
    ],
    facialTransformationMatrixes: matrix
      ? [{ rows: 4, columns: 4, data: poseMatrix({ yaw: 10, pitch: -5 }) }]
      : [],
  });
  const image = { width: 1000, height: 1000 };

  it("reports head pose, gaze, and eye state of the face", () => {
    const [head, gaze, eyes] = attentionObservations(result(), 0, image, options);
    expect(head).toMatchObject({ type: "HEAD_POSE", detected: true, value: 0 });
    expect(head.metadata.yawDeg).toBeCloseTo(10, 1);
    expect(head.metadata.pitchDeg).toBeCloseTo(-5, 1);
    expect(gaze).toMatchObject({ type: "EYE_GAZE", detected: true });
    expect(gaze.metadata.eyes).toBe(2);
    // Irises toward the image's left: the eyes look further to the person's right.
    expect(gaze.metadata.eyeYawDeg).toBeGreaterThan(5);
    expect(eyes.metadata).toMatchObject({ blinkLeft: 0.05, blinkRight: 0.05 });
    expect(eyes.metadata.earLeft).toBeCloseTo(0.333, 3);
  });

  it("leaves out an eye that is closing, and has no gaze when both are", () => {
    const [, oneEye] = attentionObservations(result({ blinkLeft: 0.8 }), 0, image, options);
    expect(oneEye.metadata.eyes).toBe(1);
    const [, none] = attentionObservations(
      result({ blinkLeft: 0.8, blinkRight: 0.9 }),
      0,
      image,
      options,
    );
    expect(none).toMatchObject({ detected: false, metadata: { reason: "both eyes closing" } });
  });

  it("has no head pose or gaze without the transformation matrix", () => {
    const [head, gaze] = attentionObservations(result({ matrix: false }), 0, image, options);
    expect(head.detected).toBe(false);
    expect(gaze).toMatchObject({ detected: false, metadata: { reason: "no head pose" } });
  });

  it("picks the largest face", () => {
    const box = (width, height) => ({ box: { x: 0, y: 0, width, height } });
    expect(largestFaceIndex([box(0.1, 0.1), box(0.3, 0.2), box(0.2, 0.2)])).toBe(1);
    expect(largestFaceIndex([])).toBe(-1);
  });
});

describe("blendshapeScore", () => {
  it("finds a category by name", () => {
    const blendshapes = { names: ["eyeBlinkLeft", "eyeBlinkRight"], scores: [0.1, 0.9] };
    expect(blendshapeScore(blendshapes, "eyeBlinkRight")).toBe(0.9);
    expect(blendshapeScore(blendshapes, "jawOpen")).toBeNull();
    expect(blendshapeScore(undefined, "eyeBlinkLeft")).toBeNull();
  });
});
