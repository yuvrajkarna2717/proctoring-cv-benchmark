import { COCO_LABELS } from "./cocoLabels.js";

/**
 * Pre- and postprocessing of the OpenCV Zoo object detectors (ONNX), following their reference
 * code (`models/object_detection_nanodet/{nanodet,demo}.py` and
 * `models/object_detection_yolox/{yolox,demo}.py`, opencv_zoo main). Pure functions.
 *
 * @typedef {Object} Letterbox how a frame is placed into the square model input
 * @property {number} size model input size (square)
 * @property {number} width scaled frame width inside the input
 * @property {number} height scaled frame height
 * @property {number} offsetX left padding
 * @property {number} offsetY top padding
 * @property {number} scaleX input pixels per frame pixel, horizontally
 * @property {number} scaleY
 * @property {number} fill padding value (each channel)
 *
 * @typedef {Object} RawDetection in model-input pixels
 * @property {number} classId
 * @property {number} score
 * @property {number} x1
 * @property {number} y1
 * @property {number} x2
 * @property {number} y2
 *
 * @typedef {Object} ObjectDetection normalized to the frame
 * @property {number} classId
 * @property {string} label
 * @property {number} score
 * @property {{ x: number, y: number, width: number, height: number }} box
 */

/**
 * Model specifications. `channels` is the channel order fed to the model. Both upstream
 * training pipelines read images with OpenCV (BGR); the OpenCV Zoo demos convert to RGB first.
 * On the Phase 6 test photos BGR found more phones at score 0.5: NanoDet 4 of 8 phone photos
 * (RGB 3), YOLOX 6 of 8 (RGB 5, missing a phone on a book in a dark room). Neither order gave a
 * false phone on the 4 photos without one. See docs/PHASE6_REPORT.md.
 */
export const ONNX_DETECTORS = Object.freeze({
  "ocv-nanodet-plus": Object.freeze({
    family: "nanodet",
    inputSize: 416,
    /** Centred letterbox with black padding (demo.py `letterbox`, INTER_AREA resize). */
    align: "center",
    fill: 0,
    /** (pixel − mean) / std per channel, in BGR order (NanoDet's training pipeline). */
    mean: [103.53, 116.28, 123.675],
    std: [57.375, 57.12, 58.395],
    channels: "bgr",
    strides: [8, 16, 32],
    regMax: 7,
    /** nanodet.py uses class-agnostic NMS (cv2.dnn.NMSBoxes). */
    classAwareNms: false,
    /** Top candidates per level before NMS (nanodet.py `nms_pre`). */
    preNmsTopK: 1000,
  }),
  "ocv-yolox-s": Object.freeze({
    family: "yolox",
    inputSize: 640,
    /** Top-left letterbox padded with 114 (demo.py `letterbox`). */
    align: "top-left",
    fill: 114,
    /** No normalization: raw 0–255 (yolox.py `preprocess` only transposes). */
    mean: [0, 0, 0],
    std: [1, 1, 1],
    channels: "bgr",
    strides: [8, 16, 32],
    /** yolox.py uses per-class NMS (cv2.dnn.NMSBoxesBatched). */
    classAwareNms: true,
    preNmsTopK: 8400,
  }),
});

/** @typedef {keyof typeof ONNX_DETECTORS} OnnxDetectorId */

/**
 * Where a frame of the given size lands in the model input.
 *
 * NanoDet's demo fits the longer side to the input and centres the other (integer sizes,
 * offsets `int((size − scaled) / 2)`); YOLOX's scales by min(size/h, size/w), truncates the
 * scaled size, and puts it at the top-left.
 *
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {{ inputSize: number, align: 'center' | 'top-left', fill: number }} spec
 * @returns {Letterbox}
 */
export function letterbox(frameWidth, frameHeight, spec) {
  const size = spec.inputSize;
  let width;
  let height;
  if (spec.align === "center") {
    if (frameWidth === frameHeight) {
      width = size;
      height = size;
    } else if (frameHeight > frameWidth) {
      height = size;
      width = Math.trunc(size / (frameHeight / frameWidth));
    } else {
      width = size;
      height = Math.trunc(size * (frameHeight / frameWidth));
    }
  } else {
    const ratio = Math.min(size / frameHeight, size / frameWidth);
    width = Math.trunc(frameWidth * ratio);
    height = Math.trunc(frameHeight * ratio);
  }
  const offsetX = spec.align === "center" ? Math.trunc((size - width) / 2) : 0;
  const offsetY = spec.align === "center" ? Math.trunc((size - height) / 2) : 0;
  return {
    size,
    width,
    height,
    offsetX,
    offsetY,
    scaleX: width / frameWidth,
    scaleY: height / frameHeight,
    fill: spec.fill,
  };
}

/**
 * RGBA pixels of the letterboxed input → normalized planar tensor in the model's channel order.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba size × size × 4
 * @param {number} size
 * @param {{ mean: number[], std: number[], channels: 'rgb' | 'bgr' }} spec mean and std are in
 *   the model's channel order
 * @param {Float32Array} [out]
 */
export function toPlanarTensor(rgba, size, spec, out = new Float32Array(3 * size * size)) {
  const plane = size * size;
  // Source channel (in RGBA) for each output plane.
  const source = spec.channels === "bgr" ? [2, 1, 0] : [0, 1, 2];
  for (let c = 0; c < 3; c += 1) {
    const mean = spec.mean[c];
    const scale = 1 / spec.std[c];
    const offset = c * plane;
    const s = source[c];
    for (let pixel = 0, i = s; pixel < plane; pixel += 1, i += 4) {
      out[offset + pixel] = (rgba[i] - mean) * scale;
    }
  }
  return out;
}

/**
 * NanoDet-Plus heads: for each level, class scores [anchors × 80] (sigmoid applied in the
 * model) and box distributions [anchors × 4 × (regMax + 1)] (logits). The distance to each side
 * is the expectation of the softmax over the bins, times the stride, from the anchor centre
 * (x · stride + (stride − 1) / 2). Boxes are clipped to the input.
 *
 * @param {Array<{ scores: ArrayLike<number>, boxes: ArrayLike<number>, stride: number }>} levels
 * @param {{ inputSize: number, regMax: number, preNmsTopK: number, numClasses?: number }} spec
 * @param {number} scoreThreshold
 * @returns {RawDetection[]} candidates above the threshold (before NMS)
 */
export function decodeNanodet(levels, spec, scoreThreshold) {
  const numClasses = spec.numClasses ?? COCO_LABELS.length;
  const bins = spec.regMax + 1;
  const size = spec.inputSize;
  /** @type {RawDetection[]} */
  const out = [];
  const softmax = new Float64Array(bins);
  for (const { scores, boxes, stride } of levels) {
    const cols = Math.ceil(size / stride);
    const anchors = scores.length / numClasses;
    // Best class per anchor, then the preNmsTopK anchors by that score (nanodet.py nms_pre).
    const best = [];
    for (let a = 0; a < anchors; a += 1) {
      let classId = 0;
      let score = scores[a * numClasses];
      for (let c = 1; c < numClasses; c += 1) {
        const value = scores[a * numClasses + c];
        if (value > score) {
          score = value;
          classId = c;
        }
      }
      best.push({ a, classId, score });
    }
    const kept =
      anchors > spec.preNmsTopK
        ? best.sort((p, q) => q.score - p.score).slice(0, spec.preNmsTopK)
        : best;
    for (const { a, classId, score } of kept) {
      if (score < scoreThreshold) continue;
      const cx = (a % cols) * stride + 0.5 * (stride - 1);
      const cy = Math.floor(a / cols) * stride + 0.5 * (stride - 1);
      const distance = [0, 0, 0, 0];
      for (let side = 0; side < 4; side += 1) {
        const base = a * 4 * bins + side * bins;
        let max = -Infinity;
        for (let b = 0; b < bins; b += 1) max = Math.max(max, boxes[base + b]);
        let sum = 0;
        for (let b = 0; b < bins; b += 1) {
          softmax[b] = Math.exp(boxes[base + b] - max);
          sum += softmax[b];
        }
        let expectation = 0;
        for (let b = 0; b < bins; b += 1) expectation += (b * softmax[b]) / sum;
        distance[side] = expectation * stride;
      }
      out.push({
        classId,
        score,
        x1: clamp(cx - distance[0], 0, size),
        y1: clamp(cy - distance[1], 0, size),
        x2: clamp(cx + distance[2], 0, size),
        y2: clamp(cy + distance[3], 0, size),
      });
    }
  }
  return out;
}

/**
 * YOLOX output [anchors × (4 + 1 + classes)]: box centre offsets and log sizes per grid cell,
 * objectness, class scores (sigmoid applied in the model). Grid cells run row by row for each
 * stride; score = objectness × class score.
 *
 * @param {ArrayLike<number>} output
 * @param {{ inputSize: number, strides: number[], numClasses?: number }} spec
 * @param {number} scoreThreshold
 * @returns {RawDetection[]}
 */
export function decodeYolox(output, spec, scoreThreshold) {
  const numClasses = spec.numClasses ?? COCO_LABELS.length;
  const stride5 = 5 + numClasses;
  /** @type {RawDetection[]} */
  const out = [];
  let anchor = 0;
  for (const stride of spec.strides) {
    const cells = Math.floor(spec.inputSize / stride);
    for (let row = 0; row < cells; row += 1) {
      for (let col = 0; col < cells; col += 1, anchor += 1) {
        const base = anchor * stride5;
        const objectness = output[base + 4];
        if (objectness < scoreThreshold) continue; // score = obj × cls ≤ obj
        let classId = 0;
        let classScore = output[base + 5];
        for (let c = 1; c < numClasses; c += 1) {
          if (output[base + 5 + c] > classScore) {
            classScore = output[base + 5 + c];
            classId = c;
          }
        }
        const score = objectness * classScore;
        if (score < scoreThreshold) continue;
        const cx = (output[base] + col) * stride;
        const cy = (output[base + 1] + row) * stride;
        const w = Math.exp(output[base + 2]) * stride;
        const h = Math.exp(output[base + 3]) * stride;
        out.push({
          classId,
          score,
          x1: cx - w / 2,
          y1: cy - h / 2,
          x2: cx + w / 2,
          y2: cy + h / 2,
        });
      }
    }
  }
  return out;
}

/**
 * Greedy non-maximum suppression, highest score first: a box is dropped when its IoU with a
 * kept box exceeds `iouThreshold` (per class when `classAware`).
 *
 * @param {RawDetection[]} candidates
 * @param {number} iouThreshold
 * @param {{ classAware: boolean, maxDetections: number }} options
 */
export function nonMaxSuppression(candidates, iouThreshold, { classAware, maxDetections }) {
  const ordered = [...candidates].sort((a, b) => b.score - a.score);
  /** @type {RawDetection[]} */
  const kept = [];
  for (const candidate of ordered) {
    if (kept.length >= maxDetections) break;
    const suppressed = kept.some(
      (box) =>
        (!classAware || box.classId === candidate.classId) && iou(box, candidate) > iouThreshold,
    );
    if (!suppressed) kept.push(candidate);
  }
  return kept;
}

/**
 * Model-input pixels → box normalized to the frame (undoing the letterbox), clamped to [0, 1].
 *
 * @param {RawDetection} detection
 * @param {Letterbox} box
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @returns {ObjectDetection}
 */
export function toFrameDetection(detection, box, frameWidth, frameHeight) {
  const x1 = clamp((detection.x1 - box.offsetX) / box.scaleX / frameWidth, 0, 1);
  const y1 = clamp((detection.y1 - box.offsetY) / box.scaleY / frameHeight, 0, 1);
  const x2 = clamp((detection.x2 - box.offsetX) / box.scaleX / frameWidth, 0, 1);
  const y2 = clamp((detection.y2 - box.offsetY) / box.scaleY / frameHeight, 0, 1);
  return {
    classId: detection.classId,
    label: COCO_LABELS[detection.classId] ?? `class ${detection.classId}`,
    score: detection.score,
    box: { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) },
  };
}

/**
 * @param {{ x1: number, y1: number, x2: number, y2: number }} a
 * @param {{ x1: number, y1: number, x2: number, y2: number }} b
 */
export function iou(a, b) {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const intersection = w * h;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Splits NanoDet's outputs (by shape: last dimension 80 = scores, 4 × (regMax + 1) = boxes;
 * rows = anchors of one level) into levels, matching anchors to strides.
 *
 * @param {Record<string, { data: ArrayLike<number>, dims: readonly number[] }>} outputs
 * @param {{ inputSize: number, strides: number[], regMax: number, numClasses?: number }} spec
 */
export function nanodetLevels(outputs, spec) {
  const numClasses = spec.numClasses ?? COCO_LABELS.length;
  const boxWidth = 4 * (spec.regMax + 1);
  const tensors = Object.values(outputs);
  return spec.strides.map((stride) => {
    const anchors = Math.ceil(spec.inputSize / stride) ** 2;
    const find = (/** @type {number} */ last) =>
      tensors.find((t) => t.dims.at(-1) === last && t.dims.at(-2) === anchors);
    const scores = find(numClasses);
    const boxes = find(boxWidth);
    if (!scores || !boxes) {
      throw new Error(`NanoDet output for stride ${stride} (${anchors} anchors) not found`);
    }
    return { scores: scores.data, boxes: boxes.data, stride };
  });
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
