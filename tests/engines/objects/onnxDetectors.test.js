import { describe, expect, it } from "vitest";
import { COCO_LABELS } from "../../../src/engines/objects/cocoLabels.js";
import {
  ONNX_DETECTORS,
  decodeNanodet,
  decodeYolox,
  iou,
  letterbox,
  nanodetLevels,
  nonMaxSuppression,
  toFrameDetection,
  toPlanarTensor,
} from "../../../src/engines/objects/onnxDetectors.js";

const NANODET = ONNX_DETECTORS["ocv-nanodet-plus"];
const YOLOX = ONNX_DETECTORS["ocv-yolox-s"];
const PHONE = COCO_LABELS.indexOf("cell phone");
const BOOK = COCO_LABELS.indexOf("book");

describe("letterbox", () => {
  it("fits a 1280×720 frame into NanoDet's 416 input, centred (demo.py integer maths)", () => {
    expect(letterbox(1280, 720, NANODET)).toEqual({
      size: 416,
      width: 416,
      height: 234, // trunc(416 × 720 / 1280)
      offsetX: 0,
      offsetY: 91, // trunc((416 − 234) / 2)
      scaleX: 416 / 1280,
      scaleY: 234 / 720,
      fill: 0,
    });
    const portrait = letterbox(480, 640, NANODET);
    expect(portrait).toMatchObject({ width: 312, height: 416, offsetX: 52, offsetY: 0 });
    // Odd padding: int((416 − 233) / 2) truncates to 91.
    expect(letterbox(1280, 718, NANODET)).toMatchObject({ height: 233, offsetY: 91 });
  });

  it("puts a 1280×720 frame at the top-left of YOLOX's 640 input, padded with 114", () => {
    expect(letterbox(1280, 720, YOLOX)).toEqual({
      size: 640,
      width: 640,
      height: 360,
      offsetX: 0,
      offsetY: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      fill: 114,
    });
  });
});

describe("toPlanarTensor", () => {
  it("writes planes in the model's channel order with its mean and std", () => {
    // 1×1 image, RGBA (10, 20, 30, 255).
    const rgba = new Uint8ClampedArray([10, 20, 30, 255]);
    const bgr = toPlanarTensor(rgba, 1, { mean: [1, 2, 3], std: [1, 2, 3], channels: "bgr" });
    // Planes B, G, R: (30 − 1) / 1, (20 − 2) / 2, (10 − 3) / 3.
    expect(bgr[0]).toBe(29);
    expect(bgr[1]).toBe(9);
    expect(bgr[2]).toBeCloseTo(7 / 3, 5);
    const rgb = toPlanarTensor(rgba, 1, { mean: [0, 0, 0], std: [1, 1, 1], channels: "rgb" });
    expect([...rgb]).toEqual([10, 20, 30]);
  });

  it("uses BGR for both OpenCV Zoo detectors and NanoDet's normalization", () => {
    expect(NANODET.channels).toBe("bgr");
    expect(YOLOX.channels).toBe("bgr");
    const pixel = new Uint8ClampedArray([123.675, 116.28, 103.53, 255].map(Math.round));
    const out = toPlanarTensor(pixel, 1, NANODET);
    for (const value of out) expect(Math.abs(value)).toBeLessThan(0.01);
  });
});

/** NanoDet level with one anchor scoring `score` for `classId` and box logits per side. */
function nanodetLevel(stride, { anchor, classId, score, sideBins }) {
  const cols = Math.ceil(416 / stride);
  const anchors = cols * cols;
  const scores = new Float32Array(anchors * 80);
  scores[anchor * 80 + classId] = score;
  const bins = NANODET.regMax + 1;
  const boxes = new Float32Array(anchors * 4 * bins).fill(-100);
  sideBins.forEach((bin, side) => {
    boxes[anchor * 4 * bins + side * bins + bin] = 100; // softmax ≈ one-hot at `bin`
  });
  return { scores, boxes, stride, anchors };
}

describe("decodeNanodet", () => {
  it("decodes distances as softmax expectations × stride from the anchor centre", () => {
    // Stride 16, anchor at column 3, row 2 → centre (3·16 + 7.5, 2·16 + 7.5) = (55.5, 39.5).
    const level = nanodetLevel(16, {
      anchor: 2 * 26 + 3,
      classId: PHONE,
      score: 0.8,
      sideBins: [1, 2, 3, 4],
    });
    const [detection, ...rest] = decodeNanodet([level], NANODET, 0.3);
    expect(rest).toEqual([]);
    expect(detection.classId).toBe(PHONE);
    expect(detection.score).toBeCloseTo(0.8, 6);
    expect(detection.x1).toBeCloseTo(55.5 - 16, 4);
    expect(detection.y1).toBeCloseTo(39.5 - 32, 4);
    expect(detection.x2).toBeCloseTo(55.5 + 48, 4);
    expect(detection.y2).toBeCloseTo(39.5 + 64, 4);
  });

  it("averages the bins (expectation, not argmax) and clips boxes to the input", () => {
    const level = nanodetLevel(8, { anchor: 0, classId: BOOK, score: 0.5, sideBins: [7, 0, 0, 0] });
    // Two equal bins (2 and 4) on the right side → expectation 3.
    const bins = NANODET.regMax + 1;
    level.boxes[2 * bins + 0] = -100;
    level.boxes[2 * bins + 2] = 100;
    level.boxes[2 * bins + 4] = 100;
    const [detection] = decodeNanodet([level], NANODET, 0.3);
    expect(detection.x1).toBe(0); // 3.5 − 56, clipped
    expect(detection.x2).toBeCloseTo(3.5 + 24, 4);
  });

  it("drops anchors below the score threshold", () => {
    const level = nanodetLevel(32, {
      anchor: 5,
      classId: PHONE,
      score: 0.29,
      sideBins: [1, 1, 1, 1],
    });
    expect(decodeNanodet([level], NANODET, 0.3)).toEqual([]);
  });

  it("matches outputs to strides by shape, whatever their names", () => {
    const level8 = nanodetLevel(8, { anchor: 0, classId: 0, score: 0.9, sideBins: [1, 1, 1, 1] });
    const level16 = nanodetLevel(16, { anchor: 0, classId: 0, score: 0.9, sideBins: [1, 1, 1, 1] });
    const level32 = nanodetLevel(32, { anchor: 0, classId: 0, score: 0.9, sideBins: [1, 1, 1, 1] });
    const tensor = (data, last, anchors) => ({ data, dims: [1, anchors, last] });
    const outputs = {
      839: tensor(level32.boxes, 32, 169),
      792: tensor(level8.scores, 80, 2704),
      817: tensor(level16.boxes, 32, 676),
      814: tensor(level16.scores, 80, 676),
      795: tensor(level8.boxes, 32, 2704),
      836: tensor(level32.scores, 80, 169),
    };
    const levels = nanodetLevels(outputs, NANODET);
    expect(levels.map((l) => l.stride)).toEqual([8, 16, 32]);
    expect(levels[0].scores).toBe(level8.scores);
    expect(levels[2].boxes).toBe(level32.boxes);
    expect(() => nanodetLevels({ 792: outputs[792] }, NANODET)).toThrow(/stride 8/);
  });
});

describe("decodeYolox", () => {
  /** Output with one anchor set; anchors run row by row per stride (80², 40², 20²). */
  function yoloxOutput(anchor, values) {
    const out = new Float32Array(8400 * 85);
    out.set(values, anchor * 85);
    return out;
  }

  it("decodes (offset + grid) × stride and exp(size) × stride; score = objectness × class", () => {
    // Stride 16 starts after 80² anchors; row 3, column 5 of the 40×40 grid.
    const anchor = 6400 + 3 * 40 + 5;
    const values = new Array(85).fill(0);
    values.splice(0, 5, 0.5, 0.25, Math.log(4), Math.log(2), 0.9);
    values[5 + PHONE] = 0.8;
    values[5 + BOOK] = 0.7;
    const [detection, ...rest] = decodeYolox(yoloxOutput(anchor, values), YOLOX, 0.3);
    expect(rest).toEqual([]);
    expect(detection.classId).toBe(PHONE);
    expect(detection.score).toBeCloseTo(0.72, 6);
    // Centre ((0.5 + 5) × 16, (0.25 + 3) × 16) = (88, 52); size 64 × 32.
    expect(detection.x1).toBeCloseTo(56, 4);
    expect(detection.y1).toBeCloseTo(36, 4);
    expect(detection.x2).toBeCloseTo(120, 4);
    expect(detection.y2).toBeCloseTo(68, 4);
  });

  it("drops candidates whose product is below the threshold", () => {
    const values = new Array(85).fill(0);
    values[4] = 0.5;
    values[5 + PHONE] = 0.5; // 0.25
    expect(decodeYolox(yoloxOutput(0, values), YOLOX, 0.3)).toEqual([]);
  });
});

describe("nonMaxSuppression", () => {
  const box = (classId, score, x1) => ({ classId, score, x1, y1: 0, x2: x1 + 10, y2: 10 });

  it("keeps the higher score of overlapping boxes; class-aware keeps other classes", () => {
    const candidates = [
      box(PHONE, 0.6, 1),
      box(PHONE, 0.9, 0),
      box(BOOK, 0.7, 0),
      box(PHONE, 0.5, 50),
    ];
    expect(iou(candidates[0], candidates[1])).toBeCloseTo(9 / 11, 6);
    const aware = nonMaxSuppression(candidates, 0.5, { classAware: true, maxDetections: 10 });
    expect(aware.map((d) => [d.classId, d.score])).toEqual([
      [PHONE, 0.9],
      [BOOK, 0.7],
      [PHONE, 0.5],
    ]);
    const agnostic = nonMaxSuppression(candidates, 0.5, { classAware: false, maxDetections: 10 });
    expect(agnostic.map((d) => d.score)).toEqual([0.9, 0.5]);
  });

  it("keeps overlaps at or below the IoU threshold and stops at maxDetections", () => {
    const candidates = [box(PHONE, 0.9, 0), box(PHONE, 0.8, 5)]; // IoU 5/15
    expect(
      nonMaxSuppression(candidates, 0.4, { classAware: true, maxDetections: 10 }),
    ).toHaveLength(2);
    expect(
      nonMaxSuppression(candidates, 0.3, { classAware: true, maxDetections: 10 }),
    ).toHaveLength(1);
    expect(nonMaxSuppression(candidates, 0.4, { classAware: true, maxDetections: 1 })).toHaveLength(
      1,
    );
    // IoU equal to the threshold is not "above" it.
    const equal = iou(candidates[0], candidates[1]);
    expect(
      nonMaxSuppression(candidates, equal, { classAware: true, maxDetections: 10 }),
    ).toHaveLength(2);
  });
});

describe("toFrameDetection", () => {
  it("undoes NanoDet's centred letterbox", () => {
    const lb = letterbox(1280, 720, NANODET);
    // Input box covering the image's middle quarter horizontally and its full height.
    const detection = toFrameDetection(
      { classId: PHONE, score: 0.8, x1: 104, y1: 91, x2: 312, y2: 91 + 234 },
      lb,
      1280,
      720,
    );
    expect(detection.label).toBe("cell phone");
    expect(detection.box.x).toBeCloseTo(0.25, 6);
    expect(detection.box.y).toBeCloseTo(0, 6);
    expect(detection.box.width).toBeCloseTo(0.5, 6);
    expect(detection.box.height).toBeCloseTo(1, 6);
  });

  it("undoes the horizontal padding of a portrait frame", () => {
    const lb = letterbox(480, 640, NANODET); // 312 wide at x 52
    const detection = toFrameDetection(
      { classId: PHONE, score: 0.8, x1: 52 + 78, y1: 0, x2: 52 + 312, y2: 208 },
      lb,
      480,
      640,
    );
    expect(detection.box.x).toBeCloseTo(0.25, 6);
    expect(detection.box.width).toBeCloseTo(0.75, 6);
    expect(detection.box.height).toBeCloseTo(0.5, 6);
  });

  it("undoes YOLOX's top-left letterbox and clamps boxes in the padding", () => {
    const lb = letterbox(1280, 720, YOLOX);
    const detection = toFrameDetection(
      { classId: BOOK, score: 0.6, x1: 320, y1: 180, x2: 700, y2: 500 },
      lb,
      1280,
      720,
    );
    expect(detection.label).toBe("book");
    expect(detection.box).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
  });
});
