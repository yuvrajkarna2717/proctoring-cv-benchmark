# Model and license register

Last verified: 2026-11-11. Integrated so far: the MediaPipe Face Landmarker bundle (`mp-face-landmarker`, Phase 2), YuNet 2026may and SFace int8bq, fp32, and int8 (`ocv-yunet-2026may`, `ocv-sface-int8bq`, `ocv-sface`, `ocv-sface-int8`, Phase 3). `npm run fetch-models` downloads them and keeps each file only if its size and pinned SHA-256 match. This register lists the exact artifacts selected for Phases 2–6 and what was verified about each.

Rules:

- A model enters the default pipeline only when its row says **Cleared for POC**. Production use needs legal review regardless of the row.
- Weights are downloaded only from the source URLs below. When a model is integrated, a fetch script pins its SHA-256 and the app serves it from `public/models/` (same origin, required by COEP).
- An open-source runtime does not make the weights commercially usable. Weights, training data, and intended-use statements are checked separately.

Status values:

| Status                                    | Meaning                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Cleared for POC                           | License text verified at the source. Usable in this local research POC.                                        |
| Cleared for POC, review before production | Weights license verified, but training-data provenance or the publisher's intended-use statement needs review. |
| Candidate                                 | Will be evaluated; license verified, not yet integrated.                                                       |
| Not selected / Excluded                   | Not used; reason given.                                                                                        |

## Runtimes and libraries

| Package                   | Version                                  | License      | Use                                                               |
| ------------------------- | ---------------------------------------- | ------------ | ----------------------------------------------------------------- |
| `@mediapipe/tasks-vision` | 1.2.2 (exact pin, installed in Phase 2)  | Apache-2.0   | Face Landmarker (Phase 2); Face Detector, Object Detector (later) |
| `onnxruntime-web`         | 1.31.1 (exact pin, installed in Phase 3) | MIT          | YuNet, SFace (Phase 3); NanoDet-Plus, YOLOX (later)               |
| `react`, `react-dom`      | 19.3.1                                   | MIT          | UI                                                                |
| `react-bootstrap`         | 2.10.10                                  | MIT          | UI components                                                     |
| `bootstrap`               | 5.3.8                                    | MIT          | CSS                                                               |
| `zod`                     | 4.6.7                                    | MIT          | Configuration validation                                          |
| `react-transition-group`  | 4.4.5                                    | BSD-3-Clause | Transitive dependency of react-bootstrap                          |

`npm run build` writes `dist/.vite/license.md` with the license of every package bundled into the main chunk. It does not cover worker bundles or copied files, so the MediaPipe plugin emits `dist/vendor/mediapipe/tasks-vision@1.2.2/LICENSE-NOTICE.txt` next to the redistributed WASM files. Development-only packages (Vite, ESLint, Prettier, Vitest, playwright-core) are not shipped.

### `@mediapipe/tasks-vision` 1.2.2

- Installed with an exact version (`--save-exact`) so benchmark results stay reproducible. Its `package.json` declares Apache-2.0; the npm package contains no LICENSE file, so the notice refers to the Apache-2.0 text.
- Redistributed files: the ES-module WASM loader and binary (`vision_wasm_module_internal.js`, `.wasm`, 14.6 MB, unmodified), served from the app's origin. The package's JavaScript is bundled unmodified into the face worker chunk.
- **Usage statistics.** The library posts usage statistics to `https://odml.pa.googleapis.com/v1/log`: every 60 s, and when a task is closed (for example on a delegate switch). The logger is created for every task. The 1.2.2 API offers no switch to turn it off: the type declarations list an `enableLogging()` method, but no method of that name exists in the published bundle. The request carries an API key embedded in the library and a protobuf with task type (FaceLandmarker), running mode, platform, library version, initialization time, call counts, and latencies. No image or landmark data was seen in it. The lab refuses these requests in its workers and logs each refusal ("Blocked a request from the worker to https://odml.pa.googleapis.com/v1/log (fetch): MediaPipe usage statistics …"); production builds block them with the CSP as well. A production integration must block or remove this call, or disclose it.
- npm audit (2026-11-10): no findings in runtime dependencies; 4 moderate findings in ESLint's development dependency chain (`minimatch`, GHSA-g3hv-75wg-m249), which is not shipped.

### `onnxruntime-web` 1.31.1

- Latest release on 2026-11-11, installed with an exact version. Its `package.json` declares MIT; the npm package contains no LICENSE file, so the emitted `LICENSE-NOTICE.txt` refers to the repository (github.com/Microsoft/onnxruntime). Runtime dependencies added: `onnxruntime-common` 1.31.1, `flatbuffers`, `guid-typescript`, `long`, `platform`, `protobufjs`.
- The app imports `onnxruntime-web/webgpu` with the `onnxruntime-web-use-extern-wasm` resolve condition. That build loads `ort-wasm-simd-threaded.asyncify.mjs` (53 kB, the Emscripten glue, also the entry of the WASM thread workers) and `ort-wasm-simd-threaded.asyncify.wasm` (28.7 MB, the native WebGPU execution provider plus the CPU provider) from `vendor/onnxruntime-web@1.31.1/`, served unmodified from the installed package.
- No outbound request from ONNX Runtime was seen: the smoke runs record every request of pages and workers, and the verification worker's egress guard reported only the smoke test's own probe. No telemetry code was looked for in the binary.
- npm audit (2026-11-11) after the install: still no findings in runtime dependencies (`npm audit --omit=dev`); the 4 moderate development-only findings above are unchanged. npm did not run `protobufjs`'s postinstall script (not allowed by the npm configuration); the package works without it.

OpenCV.js (Apache-2.0) is not added. Face alignment, Laplacian variance, and head pose (from MediaPipe's transformation matrix) need small JS functions only. Phase 4 did not add it: the optional `solvePnP` comparison was skipped, since the matrix's conventions were checked on a real portrait instead.

## Selected artifacts

Sizes are the `Content-Length` returned by the source on 2026-11-09.

| ID                     | File                                          | Size (bytes) | Format / runtime                      | Input                                      | License                        | Status                                                              | Phase |
| ---------------------- | --------------------------------------------- | -----------: | ------------------------------------- | ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------- | ----- |
| `mp-face-landmarker`   | `face_landmarker.task` (float16, v1)          |    3,758,596 | MediaPipe task bundle / tasks-vision  | detector 192×192, landmarks 256×256 crop   | Apache-2.0 (model cards)       | Integrated (Phase 2); cleared for POC, review before production     | 2, 4  |
| `mp-blazeface-short`   | `blaze_face_short_range.tflite` (float16, v1) |      229,746 | TFLite / tasks-vision Face Detector   | 128×128                                    | Apache-2.0 (model card)        | Candidate (face-presence baseline)                                  | 2     |
| `ocv-yunet-2023mar`    | `face_detection_yunet_2023mar.onnx`           |      232,589 | ONNX / ONNX Runtime Web               | fixed 640×640 (read from the graph)        | MIT                            | Not used: same weights as 2026may, fixed input                      | 3     |
| `ocv-yunet-2026may`    | `face_detection_yunet_2026may.onnx`           |      229,738 | ONNX / ONNX Runtime Web               | dynamic H×W (multiples of 32)              | MIT                            | Integrated (Phase 3); cleared for POC, review before production     | 3     |
| `ocv-sface-int8bq`     | `face_recognition_sface_2021dec_int8bq.onnx`  |   10,667,852 | ONNX int8 weights / ONNX Runtime Web  | 112×112 aligned face → 128-d embedding     | Apache-2.0                     | Integrated (Phase 3, default); cleared for POC benchmarking only    | 3     |
| `ocv-sface`            | `face_recognition_sface_2021dec.onnx`         |   38,696,353 | ONNX / ONNX Runtime Web               | as above                                   | Apache-2.0                     | Integrated (Phase 3, selectable); cleared for POC benchmarking only | 3     |
| `ocv-sface-int8`       | `face_recognition_sface_2021dec_int8.onnx`    |    9,896,933 | ONNX int8 / ONNX Runtime Web          | as above                                   | Apache-2.0                     | Integrated (Phase 3, selectable); cleared for POC benchmarking only | 3     |
| `mp-effdet-lite0-int8` | `efficientdet_lite0.tflite` (int8, v1)        |    4,602,795 | TFLite / tasks-vision Object Detector | 320×320                                    | Apache-2.0 (origin, see notes) | Candidate; confirm license in Phase 6                               | 6     |
| `mp-effdet-lite0-f16`  | `efficientdet_lite0.tflite` (float16, v1)     |    7,254,339 | TFLite / tasks-vision Object Detector | 320×320                                    | as above                       | Candidate                                                           | 6     |
| `mp-effdet-lite2-int8` | `efficientdet_lite2.tflite` (int8, v1)        |    7,515,971 | TFLite / tasks-vision Object Detector | 448×448                                    | as above                       | Candidate                                                           | 6     |
| `mp-effdet-lite2-f16`  | `efficientdet_lite2.tflite` (float16, v1)     |   12,138,859 | TFLite / tasks-vision Object Detector | 448×448                                    | as above                       | Candidate                                                           | 6     |
| `ocv-nanodet-plus`     | `object_detection_nanodet_2022nov.onnx`       |    3,800,954 | ONNX / ONNX Runtime Web               | 416×416 (NanoDet-Plus-m-1.5x)              | Apache-2.0                     | Cleared for POC                                                     | 6     |
| `ocv-yolox-s`          | `object_detection_yolox_2022nov.onnx`         |   35,858,002 | ONNX / ONNX Runtime Web               | YOLOX-S (input read from graph in Phase 6) | Apache-2.0                     | Cleared for POC                                                     | 6     |

Source URLs:

- MediaPipe models: `https://storage.googleapis.com/mediapipe-models/` + `face_landmarker/face_landmarker/float16/1/face_landmarker.task`, `face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`, `object_detector/efficientdet_lite0/{int8,float16}/1/efficientdet_lite0.tflite`, `object_detector/efficientdet_lite2/{int8,float16}/1/efficientdet_lite2.tflite`.
- OpenCV Zoo models (Git LFS): `https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/<model dir>/<file>`, where `<model dir>` is `face_detection_yunet`, `face_recognition_sface`, `object_detection_nanodet`, or `object_detection_yolox`. Repository: [opencv/opencv_zoo](https://github.com/opencv/opencv_zoo).

## Notes per model

### MediaPipe Face Landmarker bundle (`mp-face-landmarker`)

- Integrated in Phase 2. Pinned in `src/config/modelAssets.js`: 3,758,596 bytes, SHA-256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`. The downloaded file also matched the MD5 that Google Cloud Storage reports for the object (`sOcnSQehZEQE/vZrKN1thQ==`, last modified 2023-05-03). `npm run fetch-models` keeps the file only if size and SHA-256 match, and the engine checks the SHA-256 again after loading it. The file is not committed (`public/models/` is ignored by git except its README); attribution is in `public/models/README.md`.
- Contains the BlazeFace short-range face detector, the Face Mesh V2 landmark model (478 landmarks including iris), and the Blendshape V2 model (52 coefficients). Outputs also include an optional 4×4 face transformation matrix per face. Since Phase 4 the lab uses the blendshapes (blink scores) and the matrix (head pose) for the attention rules. Source: [Face Landmarker guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
- License: the three model cards (BlazeFace Short Range, Face Mesh V2, Blendshape V2) each state "Licensed under Apache License, Version 2.0". Verified by extracting the text of the official PDFs on 2026-11-09.
- Intended use (review before production): the Face Mesh V2 card names AR entertainment as the primary application and says the model is not intended for human life-critical decisions and does not provide recognition or identification. The BlazeFace card says any form of surveillance or identity recognition is out of scope. Apache-2.0 does not restrict field of use, but exam proctoring is a monitoring use the cards do not cover, so legal/ethics review is needed before production.
- Documented operating limits that matter for proctoring: Face Mesh V2 is not suited to faces turned more than 80° away, less than 50% visible, or too far away; BlazeFace short range targets faces within about 2 m with roll/pitch within 45° and yaw within 90°. Expect `NO_FACE` observations for strong head turns; Phase 2 must measure this rather than treat it as a model failure.
- Open question: a public forum thread (Nov 2026) asks whether Apache-2.0 covers every file inside the `.task` bundle, including geometry pipeline metadata. No maintainer answer was found.

### Phase 3 pins (OpenCV Zoo, Git LFS)

The download URLs name the commit that last changed each file, so the content behind a URL cannot change. Each pinned SHA-256 equals the `oid` in the file's Git LFS pointer at that commit, and the downloaded size equals the pointer's size (checked 2026-11-10).

| ID                             | Commit (date)                                           | SHA-256                                                            | Graph (read with ONNX Runtime)                                                        |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ocv-yunet-2026may`            | `26cc381e4d2594bb9f47a26eb8fd96c94a13660d` (2026-05-22) | `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0` | input `input` [1, 3, H, W]; outputs `cls`, `obj`, `bbox`, `kps` for strides 8, 16, 32 |
| `ocv-sface`                    | `ba91a3b91d00d76e86540d4013f944bd6b514e39` (2022-01-06) | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | input `data` [1, 3, 112, 112]; output `fc1` [1, 128]                                  |
| `ocv-sface-int8`               | `088c3571ec70df15100a5e4c26894d95951e92e9` (2023-03-21) | `2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a` | as above                                                                              |
| `ocv-sface-int8bq`             | `25f423d0e04c31a17254620e58febd7386da523b` (2024-11-06) | `fb143eea07838aa532d1c95df5f69899974ea0140e1fba05e94204be13ed74ee` | as above, plus 29 declared inputs that no node reads (see the SFace notes)            |
| `ocv-yunet-2023mar` (not used) | `f12e12798e8314f7c074a6656816c048dcc95b7a` (2023-06-06) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | input [1, 3, 640, 640]                                                                |

Pre- and postprocessing follow OpenCV's own implementations (`FaceDetectorYN` and `FaceRecognizerSF` in `modules/objdetect`, 4.x), see `docs/ARCHITECTURE.md`. OpenCV Zoo's default cosine threshold for SFace (0.363, from its `sface.py`) is the starting value of `FACE_MISMATCH`; the YuNet demo's score threshold 0.9 and NMS threshold 0.3 are the detector defaults.

### YuNet (`ocv-yunet-*`)

- MIT license for all files in `models/face_detection_yunet` ([README](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)). Model source: libfacedetection.train.
- The README states that the 2026may file is the 2023mar file re-exported with symbolic height and width; both have the same outputs for the same input shape.
- Training data: WIDER FACE, per libfacedetection.train. The dataset's own terms were not verified in this phase (its site was unreachable). Legal review should confirm whether they affect use of the trained weights.
- Detects faces of roughly 10×10 to 300×300 pixels (README). The 2026may file has dynamic input shape; the 2023mar file has a fixed shape.

### SFace (`ocv-sface-int8bq`, `ocv-sface`, `ocv-sface-int8`)

- Apache-2.0 for all files in `models/face_recognition_sface` ([README](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface), LICENSE file verified). MobileFaceNet trained with the SFace loss; ONNX conversion contributed to OpenCV Zoo.
- Training data is not documented for the published checkpoint. The SFace paper trains on several web-scraped face datasets, some of which have research-only terms. An open issue asks OpenCV for the dataset and for upstream authorization ([opencv_zoo#318](https://github.com/opencv/opencv_zoo/issues/318)); still no maintainer answer when checked on 2026-11-11.
- The three files hold the same network. They differ in how the weights are stored and computed (graphs read by the lab's protobuf reader):

| ID                 | Opsets               | Compute                                                                           | Weights                                                                 |
| ------------------ | -------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ocv-sface`        | 11                   | float32: Conv 27, BatchNormalization 29, PRelu 27, Gemm 1                         | float32                                                                 |
| `ocv-sface-int8`   | 11 + `com.microsoft` | int8 (static QDQ): QLinearConv 27, QLinearMatMul, QLinearAdd, QLinearMul          | int8; activations are quantized too                                     |
| `ocv-sface-int8bq` | 21                   | float32 Conv and Gemm; 29 DequantizeLinear + 27 Reshape rebuild the float weights | int8 in blocks of 64 (`tools/quantize/block_quantize.py`), weights only |

- Published accuracy on LFW (OpenCV Zoo README, `tools/eval`, YuNet boxes, InsightFace's LFW protocol): fp32 0.9940, int8bq 0.9942, int8 0.9932. The lab has not measured accuracy on real faces; see `docs/PHASE3_REPORT.md`, "Quantized SFace".
- Embedding agreement with fp32 on the same synthetic input (ONNX Runtime, WASM and WebGPU): int8bq 0.999445, int8 0.951531. A reference enrolled with one variant is never compared with another; calibration results are computed per variant.
- int8bq defect handled by the lab: the graph still declares the 29 original float weight names (e.g. `conv_1_conv2d_weight`) as graph inputs, although no node reads them. ONNX Runtime lists them in `inputNames` and `run()` demands a feed for each. After the SHA-256 check the engine drops those 29 declarations (`src/engines/verification/onnxGraph.js`); nodes, initializers, and outputs are unchanged. The engine reports the count as `prunedGraphInputs` in the model info.
- int8bq is loaded with ONNX Runtime's session option `session.disable_quant_qdq = 1`, so that the DequantizeLinear nodes over constant weights fold into float32 weights when the session is created. Without it, every run dequantized all weights again (WASM, 1 thread, Node: 66.8 ms per run vs 47.4 ms with folding; outputs identical, cosine 1.0000000).
- Decision: use only to benchmark 1:1 verification accuracy and latency in this POC. Before any production use, either obtain written provenance or replace it with a model whose training data is cleared for commercial use.

### EfficientDet-Lite (`mp-effdet-*`)

- Trained on COCO 2017; EfficientNet-Lite backbone with BiFPN. Inputs 320×320 (Lite0) and 448×448 (Lite2). Source: [Object Detector guide](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector).
- No model card or LICENSE file accompanies the MediaPipe-hosted `.tflite` files. The models come from the Apache-2.0 [google/automl](https://github.com/google/automl/tree/master/efficientdet) implementation and the TF Hub EfficientDet-Lite release. Confirm the license statement for the hosted artifact in Phase 6.
- COCO annotations are CC BY 4.0; COCO images carry their original Flickr terms.

### NanoDet-Plus and YOLOX-S (`ocv-nanodet-plus`, `ocv-yolox-s`)

- Apache-2.0 for all files in the OpenCV Zoo directories. Weights from [RangiLyu/nanodet](https://github.com/RangiLyu/nanodet) and [Megvii-BaseDetection/YOLOX](https://github.com/Megvii-BaseDetection/YOLOX).
- Published COCO 2017 val results relevant to proctoring (from the OpenCV Zoo READMEs):

| Model                   | COCO AP (0.50:0.95) | `cell phone` AP | `book` AP |
| ----------------------- | ------------------: | --------------: | --------: |
| NanoDet-Plus-m-1.5x 416 |               0.304 |            22.8 |       7.3 |
| YOLOX-S                 |               0.405 |            32.4 |      15.0 |

- These are general-scene numbers. Webcam close-ups of phones and notebooks are a different distribution and must be measured in Phase 6. COCO `book` is not a notebook or cheat-sheet class; its low AP is an early warning that notebook detection is unlikely to work without a custom model.

## Not selected or excluded

| Candidate                                      | Decision     | Reason                                                                                                                           |
| ---------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| InsightFace pretrained model packs             | Excluded     | Pretrained models are licensed for non-commercial research only.                                                                 |
| Ultralytics YOLOv5 / YOLOv8 / YOLO11 and later | Excluded     | AGPL-3.0 or a paid enterprise license.                                                                                           |
| YOLOv7, YOLOv9                                 | Excluded     | GPL-3.0.                                                                                                                         |
| YOLO-NAS pretrained weights                    | Excluded     | Weights under a non-commercial license.                                                                                          |
| TensorFlow.js COCO-SSD                         | Not selected | Apache-2.0, but adds a third runtime (TF.js) for an older SSD model; EfficientDet-Lite covers the same classes inside MediaPipe. |
| MediaPipe Image Embedder                       | Not selected | Generic image embeddings, not trained for face identity.                                                                         |
| Face anti-spoofing models                      | Deferred     | Separate research module after Phase 3; each candidate needs its own license and data review.                                    |
