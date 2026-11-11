/**
 * Model files the lab serves from `public/models/` (same origin, which COEP requires).
 *
 * `scripts/fetch-models.mjs` downloads each file from `url` and keeps it only if its size and
 * SHA-256 match. Engines check the SHA-256 again after loading, so a replaced file is rejected.
 * Sources, licenses, and intended-use notes: docs/MODEL_LICENSES.md.
 *
 * This module has no browser or Node dependencies; the fetch script, the Vite config, and the
 * workers all import it.
 *
 * @typedef {Object} ModelAsset
 * @property {string} id registry id from docs/MODEL_LICENSES.md
 * @property {string} version publisher's variant and version
 * @property {string} file file name
 * @property {string} url download source
 * @property {number} bytes expected size
 * @property {string} sha256 expected SHA-256, lowercase hex
 * @property {string} license license of the weights as verified for the registry
 * @property {boolean=} pruneUnusedGraphInputs the graph declares inputs that no node reads;
 *   the engine drops those declarations after the hash check (see onnxGraph.js)
 * @property {boolean=} foldWeightDequantization weights are stored quantized behind
 *   DequantizeLinear nodes; ONNX Runtime should dequantize them once when it creates the session
 *   instead of on every run
 */

/**
 * OpenCV Zoo files are Git LFS objects. The URLs name the commit that last changed each file, so
 * the download cannot change under the pinned hash; each SHA-256 equals the `oid` of the file's
 * LFS pointer at that commit.
 *
 * @param {string} commit
 * @param {string} path below `models/`
 */
const openCvZoo = (commit, path) =>
  `https://media.githubusercontent.com/media/opencv/opencv_zoo/${commit}/models/${path}`;

/** @type {Readonly<Record<string, Readonly<ModelAsset>>>} */
export const MODEL_ASSETS = Object.freeze({
  "mp-face-landmarker": Object.freeze({
    id: "mp-face-landmarker",
    version: "float16/1",
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    bytes: 3_758_596,
    sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    license: "Apache-2.0",
  }),
  // Same weights as face_detection_yunet_2023mar.onnx, re-exported with dynamic height and width
  // (OpenCV Zoo README), so frames are not letterboxed into 640×640.
  "ocv-yunet-2026may": Object.freeze({
    id: "ocv-yunet-2026may",
    version: "2026may",
    file: "face_detection_yunet_2026may.onnx",
    url: openCvZoo(
      "26cc381e4d2594bb9f47a26eb8fd96c94a13660d",
      "face_detection_yunet/face_detection_yunet_2026may.onnx",
    ),
    bytes: 229_738,
    sha256: "ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0",
    license: "MIT",
  }),
  "ocv-sface": Object.freeze({
    id: "ocv-sface",
    version: "2021dec",
    file: "face_recognition_sface_2021dec.onnx",
    url: openCvZoo(
      "ba91a3b91d00d76e86540d4013f944bd6b514e39",
      "face_recognition_sface/face_recognition_sface_2021dec.onnx",
    ),
    bytes: 38_696_353,
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    license: "Apache-2.0",
  }),
  "ocv-sface-int8": Object.freeze({
    id: "ocv-sface-int8",
    version: "2021dec int8",
    file: "face_recognition_sface_2021dec_int8.onnx",
    url: openCvZoo(
      "088c3571ec70df15100a5e4c26894d95951e92e9",
      "face_recognition_sface/face_recognition_sface_2021dec_int8.onnx",
    ),
    bytes: 9_896_933,
    sha256: "2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a",
    license: "Apache-2.0",
  }),
  // Weight-only block quantization (int8 weights in blocks of 64, opset 21 DequantizeLinear)
  // of the same SFace weights; convolutions still run in float32. The graph still declares the
  // 29 original float weights as inputs, which nothing reads; ONNX Runtime would require feeds.
  "ocv-sface-int8bq": Object.freeze({
    id: "ocv-sface-int8bq",
    version: "2021dec int8bq",
    file: "face_recognition_sface_2021dec_int8bq.onnx",
    url: openCvZoo(
      "25f423d0e04c31a17254620e58febd7386da523b",
      "face_recognition_sface/face_recognition_sface_2021dec_int8bq.onnx",
    ),
    bytes: 10_667_852,
    sha256: "fb143eea07838aa532d1c95df5f69899974ea0140e1fba05e94204be13ed74ee",
    license: "Apache-2.0",
    pruneUnusedGraphInputs: true,
    foldWeightDequantization: true,
  }),
});

/**
 * Location of a model file below the site's base URL.
 *
 * @param {ModelAsset} asset
 * @returns {string} e.g. "models/mp-face-landmarker/face_landmarker.task"
 */
export function modelAssetPath(asset) {
  return `models/${asset.id}/${asset.file}`;
}
