import { describe, expect, it } from "vitest";
import {
  decodeYunet,
  detectorInputSize,
  intersectionOverUnion,
  nonMaxSuppression,
  rgbaToBgrPlanar,
  yunetOutputNames,
} from "../../../src/engines/verification/yunet.js";

/** Zero-filled YuNet outputs for a padded input size, with a setter for one anchor. */
function createOutputs(paddedWidth, paddedHeight) {
  const outputs = {};
  for (const stride of [8, 16, 32]) {
    const anchors = (paddedWidth / stride) * (paddedHeight / stride);
    const [cls, obj, bbox, kps] = yunetOutputNames(stride);
    outputs[cls] = { data: new Float32Array(anchors) };
    outputs[obj] = { data: new Float32Array(anchors) };
    outputs[bbox] = { data: new Float32Array(anchors * 4) };
    outputs[kps] = { data: new Float32Array(anchors * 10) };
  }
  const set = (stride, row, col, { cls, obj, bbox, kps = new Array(10).fill(0) }) => {
    const index = row * (paddedWidth / stride) + col;
    const [clsName, objName, bboxName, kpsName] = yunetOutputNames(stride);
    outputs[clsName].data[index] = cls;
    outputs[objName].data[index] = obj;
    outputs[bboxName].data.set(bbox, index * 4);
    outputs[kpsName].data.set(kps, index * 10);
  };
  return { outputs, set };
}

const OPTIONS = {
  paddedWidth: 64,
  paddedHeight: 32,
  scoreThreshold: 0.9,
  nmsThreshold: 0.3,
  topK: 5000,
};

describe("YuNet input", () => {
  it("scales frames to the target width, never enlarges them, and pads to multiples of 32", () => {
    expect(detectorInputSize(1280, 720, 640)).toEqual({
      width: 640,
      height: 360,
      paddedWidth: 640,
      paddedHeight: 384,
      scaleX: 0.5,
      scaleY: 0.5,
    });
    expect(detectorInputSize(640, 480, 640)).toMatchObject({ paddedWidth: 640, paddedHeight: 480 });
    expect(detectorInputSize(320, 240, 640)).toMatchObject({
      width: 320,
      height: 240,
      paddedWidth: 320,
      paddedHeight: 256,
      scaleX: 1,
    });
  });

  it("converts RGBA pixels to planar BGR with values 0-255", () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(Array.from(rgbaToBgrPlanar(rgba, 2, 1))).toEqual([30, 60, 20, 50, 10, 40]);
  });
});

describe("YuNet decoding", () => {
  it("decodes boxes, landmarks, and score = sqrt(cls × obj) like OpenCV's FaceDetectorYN", () => {
    const { outputs, set } = createOutputs(64, 32);
    set(8, 1, 2, {
      cls: 0.81,
      obj: 1,
      bbox: [0.5, 0.25, Math.log(4), Math.log(2)],
      kps: [0.1, 0.2, 1, 0, 0.5, 0.5, 0, 1, 1, 1],
    });
    const [face, ...rest] = decodeYunet(outputs, OPTIONS);
    expect(rest).toEqual([]);
    expect(face.score).toBeCloseTo(0.9, 6);
    expect(face.x).toBeCloseTo(4, 5); // centre (2 + 0.5) × 8 = 20, width 4 × 8 = 32
    expect(face.y).toBeCloseTo(2, 5); // centre (1 + 0.25) × 8 = 10, height 2 × 8 = 16
    expect(face.width).toBeCloseTo(32, 5);
    expect(face.height).toBeCloseTo(16, 5);
    const expected = [16.8, 9.6, 24, 8, 20, 12, 16, 16, 24, 16];
    face.landmarks.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5));
  });

  it("clamps cls and obj to [0, 1], drops low scores, and suppresses overlapping duplicates", () => {
    const { outputs, set } = createOutputs(64, 32);
    const box = [0, 0, Math.log(4), Math.log(4)];
    set(8, 1, 2, { cls: 1.4, obj: 1, bbox: box }); // clamped to score 1
    set(8, 1, 3, { cls: 0.9, obj: 0.95, bbox: [-0.5, 0, Math.log(4), Math.log(4)] }); // duplicate
    set(8, 0, 7, { cls: 0.5, obj: 0.5, bbox: box }); // score 0.5, below threshold
    set(32, 0, 1, { cls: 0.95, obj: 0.95, bbox: [0, 0, 0, 0] }); // separate face
    const faces = decodeYunet(outputs, OPTIONS);
    expect(faces.map((face) => Number(face.score.toFixed(3)))).toEqual([1, 0.95]);
    expect(faces[1].x).toBeCloseTo(16, 5); // stride 32, col 1: centre 32, width 32
  });

  it("rejects outputs that do not match the input size", () => {
    const { outputs } = createOutputs(64, 32);
    expect(() => decodeYunet(outputs, { ...OPTIONS, paddedWidth: 96 })).toThrow(
      expect.objectContaining({ code: "MODEL_OUTPUT_SHAPE" }),
    );
  });
});

describe("non-maximum suppression", () => {
  const face = (x, score) => ({ x, y: 0, width: 10, height: 10, score, landmarks: [] });

  it("keeps the best of overlapping faces and every separate face", () => {
    const kept = nonMaxSuppression([face(0, 0.91), face(1, 0.99), face(50, 0.95)], 0.3, 10);
    expect(kept.map((f) => f.score)).toEqual([0.99, 0.95]);
  });

  it("drops a face only when its IoU exceeds the threshold, and limits candidates to topK", () => {
    // x offset 5 of 10: intersection 50, union 150, IoU 1/3
    expect(nonMaxSuppression([face(0, 0.9), face(5, 0.8)], 1 / 3, 10)).toHaveLength(2);
    expect(nonMaxSuppression([face(0, 0.9), face(5, 0.8)], 0.3, 10)).toHaveLength(1);
    expect(nonMaxSuppression([face(0, 0.9), face(50, 0.8), face(100, 0.7)], 0.3, 2)).toHaveLength(
      2,
    );
  });

  it("computes intersection over union", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(intersectionOverUnion(a, a)).toBe(1);
    expect(intersectionOverUnion(a, { ...a, x: 20 })).toBe(0);
    expect(intersectionOverUnion(a, { ...a, x: 5 })).toBeCloseTo(1 / 3, 10);
  });
});
