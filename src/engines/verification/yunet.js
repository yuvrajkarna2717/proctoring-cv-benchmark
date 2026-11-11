import { LabError } from "../../utils/errors.js";

/**
 * YuNet face detector (OpenCV Zoo `face_detection_yunet_2026may.onnx`): input preparation and
 * output decoding. Follows OpenCV's FaceDetectorYN (`modules/objdetect/src/face_detect.cpp`,
 * 4.x): BGR input with values 0–255, padded at the right and bottom to multiples of 32; 12
 * outputs (cls, obj, bbox, kps for strides 8, 16, 32); score = sqrt(cls × obj); greedy
 * non-maximum suppression.
 *
 * @typedef {Object} DetectedFace in detector-input pixels
 * @property {number} x left
 * @property {number} y top
 * @property {number} width
 * @property {number} height
 * @property {number} score 0–1, sqrt(cls × obj); a detector score, not a probability
 * @property {number[]} landmarks x, y of: right eye, left eye, nose tip, right mouth corner,
 *   left mouth corner ("right" and "left" from the subject's point of view, so the right eye is
 *   on the image's left in an unmirrored frame)
 */

export const YUNET_STRIDES = Object.freeze([8, 16, 32]);
const DIVISOR = 32;

/** @param {number} stride */
export function yunetOutputNames(stride) {
  return [`cls_${stride}`, `obj_${stride}`, `bbox_${stride}`, `kps_${stride}`];
}

/**
 * Detector input for a frame: scaled to `targetWidth` (never enlarged), aspect ratio kept, then
 * padded at the right and bottom to multiples of 32.
 *
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {number} targetWidth
 */
export function detectorInputSize(frameWidth, frameHeight, targetWidth) {
  const width = Math.max(1, Math.min(targetWidth, frameWidth));
  const height = Math.max(1, Math.round((frameHeight * width) / frameWidth));
  return {
    width,
    height,
    paddedWidth: Math.ceil(width / DIVISOR) * DIVISOR,
    paddedHeight: Math.ceil(height / DIVISOR) * DIVISOR,
    scaleX: width / frameWidth,
    scaleY: height / frameHeight,
  };
}

/**
 * Canvas RGBA pixels → planar float32 in BGR order with values 0–255, which is what
 * `cv::dnn::blobFromImage` makes of an OpenCV (BGR) image.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} [out]
 */
export function rgbaToBgrPlanar(rgba, width, height, out = new Float32Array(3 * width * height)) {
  const plane = width * height;
  for (let pixel = 0, i = 0; pixel < plane; pixel += 1, i += 4) {
    out[pixel] = rgba[i + 2];
    out[plane + pixel] = rgba[i + 1];
    out[2 * plane + pixel] = rgba[i];
  }
  return out;
}

/**
 * Decodes YuNet outputs into faces (detector-input pixels), highest score first.
 *
 * @param {Record<string, { data: ArrayLike<number> }>} outputs by output name
 * @param {{ paddedWidth: number, paddedHeight: number, scoreThreshold: number,
 *   nmsThreshold: number, topK: number }} options `topK` limits the candidates before
 *   suppression, as in OpenCV
 * @returns {DetectedFace[]}
 */
export function decodeYunet(
  outputs,
  { paddedWidth, paddedHeight, scoreThreshold, nmsThreshold, topK },
) {
  /** @type {DetectedFace[]} */
  const candidates = [];
  for (const stride of YUNET_STRIDES) {
    const cols = Math.floor(paddedWidth / stride);
    const rows = Math.floor(paddedHeight / stride);
    const [cls, obj, bbox, kps] = yunetOutputNames(stride).map((name, index) => {
      const tensor = outputs[name];
      const expected = rows * cols * [1, 1, 4, 10][index];
      if (!tensor || tensor.data.length !== expected) {
        throw new LabError(
          `YuNet output ${name} has ${tensor ? tensor.data.length : "no"} values; expected ${expected} for a ${paddedWidth}×${paddedHeight} input`,
          { code: "MODEL_OUTPUT_SHAPE" },
        );
      }
      return tensor.data;
    });
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        const score = Math.sqrt(clamp01(cls[index]) * clamp01(obj[index]));
        if (score < scoreThreshold) continue;
        const centerX = (col + bbox[index * 4]) * stride;
        const centerY = (row + bbox[index * 4 + 1]) * stride;
        const width = Math.exp(bbox[index * 4 + 2]) * stride;
        const height = Math.exp(bbox[index * 4 + 3]) * stride;
        const landmarks = new Array(10);
        for (let point = 0; point < 5; point += 1) {
          landmarks[point * 2] = (kps[index * 10 + point * 2] + col) * stride;
          landmarks[point * 2 + 1] = (kps[index * 10 + point * 2 + 1] + row) * stride;
        }
        candidates.push({
          x: centerX - width / 2,
          y: centerY - height / 2,
          width,
          height,
          score,
          landmarks,
        });
      }
    }
  }
  return nonMaxSuppression(candidates, nmsThreshold, topK);
}

/**
 * Greedy non-maximum suppression like `cv::dnn::NMSBoxes`: candidates sorted by score, the best
 * `topK` considered, and a candidate is dropped when its IoU with an already kept face exceeds
 * `iouThreshold`.
 *
 * @param {DetectedFace[]} candidates
 * @param {number} iouThreshold
 * @param {number} topK
 * @returns {DetectedFace[]}
 */
export function nonMaxSuppression(candidates, iouThreshold, topK) {
  const ordered = [...candidates].sort((a, b) => b.score - a.score).slice(0, topK);
  /** @type {DetectedFace[]} */
  const kept = [];
  for (const candidate of ordered) {
    if (kept.every((face) => intersectionOverUnion(face, candidate) <= iouThreshold)) {
      kept.push(candidate);
    }
  }
  return kept;
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} a
 * @param {{ x: number, y: number, width: number, height: number }} b
 */
export function intersectionOverUnion(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

/** @param {number} value */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
