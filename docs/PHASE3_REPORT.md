# Phase 3 report — Face verification (1:1)

Date: 2026-11-11. Deliverable: YuNet face detection, five-point alignment, and SFace embeddings on ONNX Runtime Web in a worker; enrollment of a reference with a quality gate, stored in IndexedDB; live comparison with the reference and a `FACE_MISMATCH` rule; a calibration tool for FAR, FRR, EER, and ROC. Verified with unit tests, mutation checks, and the browser smoke test. The exit criterion (FAR/FRR on a documented local test set) needs real faces and is still open (see "Exit criteria").

## What was built

- **Face verification engine** (`src/engines/verification/`, `src/workers/verification.worker.js`): YuNet 2026may (dynamic input) finds faces in a copy of the frame scaled to 640 px; the largest face is aligned from the full-resolution frame to a 112×112 crop with a five-point similarity transform; SFace (int8bq default since the quantization follow-up; fp32 and int8 selectable) computes a 128-value embedding, L2-normalized in the worker. Pre- and postprocessing follow OpenCV's `FaceDetectorYN` and `FaceRecognizerSF`. Quality measurements of each embedded face: detector score, eye distance, roll, a yaw proxy, face size, in-frame flag, brightness and sharpness of the crop.
- **Providers**: ONNX Runtime Web 1.31.1, WASM (default, SIMD, 4 threads) or WebGPU, from one self-hosted binary; WebGPU falls back to WASM with the reason shown; live provider and model switches in the same worker; a self-check embedding of a fixed synthetic input after every session creation.
- **Identity layer** (`src/identity/`, main thread): quality gates for enrollment and verification with every check's measured value and limit; enrollment of 5 spaced, gated samples into a template, refused when the samples disagree; comparison of every gated frame with the reference (same recognizer model only); calibration captures of labelled persons and conditions, scored without within-capture pairs, with FAR/FRR at the threshold, EER, FAR ≤ 1% and ≤ 0.1% thresholds, ROC, histograms, and composition; export without embeddings; IndexedDB storage with a self-test and "Delete all identity data".
- **FACE_MISMATCH rule**: similarity below the threshold (0.363) on every compared frame for 2 s; ends 1 s after it is back at or above; 5 s cooldown; severity high; ends with `reference-changed` when the reference is replaced or deleted, and with `data-gap` after 2 s without a comparison.
- **UI**: verifier controls in the engine card (provider, recognizer, detector score and width, centre-crop diagnostic); dashed YuNet boxes with scores and five points on the preview; Identity panel (reference, enrollment progress with the gate table, last similarity and a similarity chart, gate settings, storage test, delete all); Calibration panel (capture form with pseudonym and conditions, captures, results, "use" buttons for the EER and FAR thresholds, export); a rule-value column for the threshold; per-model latency rows in the metrics table; consent text for stored templates.
- **Generalizations**: `scripts/vite-plugin-vendor-assets.js` serves and emits runtime files of both MediaPipe and ONNX Runtime with version checks and license notices (replaces the MediaPipe-only plugin); `src/engines/modelFiles.js` (shared model loading and hash check); `StageTimer.record()` and the monitor's `breakdownMs` for per-model timing; `ModelInfo.components` for engines with two models.
- **Fix during this phase**: a half-applied edit to `PerformanceMonitor.reset()` made Start detection fail with "Cannot read properties of undefined (reading 'clear')" in a build the user had made at that moment. Fixed, with a regression test; see "Problems found and fixed".

## Files

| Area     | New                                                                                                                                                                                                                    | Changed                                                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project  | `scripts/vite-plugin-vendor-assets.js` (replaces `vite-plugin-mediapipe-wasm.js`)                                                                                                                                      | `package.json`, `package-lock.json`, `vite.config.js` (vendor packages, resolve condition, `optimizeDeps`), `scripts/browser-smoke.mjs`                                                                                                                               |
| Config   | —                                                                                                                                                                                                                      | `src/config/modelAssets.js` (three models), `schema.js` (FACE_MISMATCH, identity, quality gates), `detection.config.js` (verifier, identity)                                                                                                                          |
| Engines  | `src/engines/modelFiles.js`; `src/engines/verification/FaceVerificationEngine.js`, `faceVerifierConfig.js`, `ortRuntime.js`, `ortAssets.js`, `canvasImageOps.js`, `yunet.js`, `alignment.js`, `sface.js`, `quality.js` | `src/engines/EngineContract.js` (breakdown, components), `engineKinds.js`, `face/mediapipeRuntime.js`, `face/mediapipeAssets.js`                                                                                                                                      |
| Workers  | `src/workers/verification.worker.js`                                                                                                                                                                                   | `src/workers/WorkerEngineClient.js`, `workerFactories.js`                                                                                                                                                                                                             |
| Identity | `src/identity/IdentityManager.js`, `IdentityStore.js`, `calibration.js`, `qualityGate.js`, `embeddings.js`                                                                                                             | —                                                                                                                                                                                                                                                                     |
| Pipeline | —                                                                                                                                                                                                                      | `src/pipeline/ViolationEngine.js`, `TemporalCondition.js`; `src/benchmark/PerformanceMonitor.js`                                                                                                                                                                      |
| App, UI  | `src/ui/identity/IdentityPanel.jsx`, `CalibrationPanel.jsx`, `GateChecks.jsx`, `Charts.jsx`; `src/ui/common/ConfirmButton.jsx`                                                                                         | `src/app/LabController.js`, `App.jsx`, `routes/LiveTestingPage.jsx`, `src/ui/camera/CameraPanel.jsx`, `FaceOverlay.jsx`, `ConsentNotice.jsx`, `src/ui/detections/EngineCard.jsx`, `src/ui/violations/ViolationsPanel.jsx`, `src/ui/benchmarks/EngineMetricsTable.jsx` |
| Tests    | `tests/engines/verification/{yunet,alignment,sfaceQuality,FaceVerificationEngine}.test.js`, `tests/identity/{calibration,qualityGate,IdentityManager}.test.js`                                                         | `tests/app/LabController.test.js`, `tests/pipeline/ViolationEngine.test.js`, `tests/benchmark/PerformanceMonitor.test.js`                                                                                                                                             |
| Docs     | this report                                                                                                                                                                                                            | `README.md`, `docs/IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `MODEL_LICENSES.md`, `TESTING_GUIDE.md`, `KNOWN_LIMITATIONS.md`, `PHASE2_REPORT.md` (user's confirmation)                                                                                              |

## Dependencies added

| Package           | Version        | Kind    | Why                                                                                                |
| ----------------- | -------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `onnxruntime-web` | 1.31.1 (exact) | runtime | YuNet and SFace; its WASM glue and binary are served from the installed package by the Vite plugin |

Transitive runtime packages: `onnxruntime-common` 1.31.1, `flatbuffers`, `guid-typescript`, `long`, `platform`, `protobufjs`. `npm audit --omit=dev`: 0 findings. Full audit: the same 4 moderate findings in ESLint's development chain as in Phase 2.

Build output added: verification worker 7.8 kB, `FaceVerificationEngine` chunk 84 kB, `ortRuntime` (ONNX Runtime JavaScript) 71 kB, ONNX Runtime glue 53 kB and WASM 28.7 MB, models 59.5 MB (all three SFace variants are copied; only the selected one is loaded, 10.7 MB by default).

## Models and licenses

| ID                  | File                                         | Size (bytes) | SHA-256 (= Git LFS oid)                                            | License    | Status                                                         |
| ------------------- | -------------------------------------------- | -----------: | ------------------------------------------------------------------ | ---------- | -------------------------------------------------------------- |
| `ocv-yunet-2026may` | `face_detection_yunet_2026may.onnx`          |      229,738 | `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0` | MIT        | Integrated; cleared for POC, review before production          |
| `ocv-sface-int8bq`  | `face_recognition_sface_2021dec_int8bq.onnx` |   10,667,852 | `fb143eea07838aa532d1c95df5f69899974ea0140e1fba05e94204be13ed74ee` | Apache-2.0 | Integrated (default); **cleared for POC benchmarking only**    |
| `ocv-sface`         | `face_recognition_sface_2021dec.onnx`        |   38,696,353 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | Apache-2.0 | Integrated (selectable); **cleared for POC benchmarking only** |
| `ocv-sface-int8`    | `face_recognition_sface_2021dec_int8.onnx`   |    9,896,933 | `2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a` | Apache-2.0 | Integrated (selectable); **cleared for POC benchmarking only** |

- Downloaded from commit-pinned OpenCV Zoo URLs; each hash and size equal the file's Git LFS pointer. The engine re-checks both hashes at load.
- `face_detection_yunet_2023mar.onnx` (fixed 640×640, same weights) was inspected and is not used.
- **SFace provenance (restated)**: the weights are Apache-2.0, but the training data of the published checkpoint is undocumented, and the question to OpenCV ([opencv_zoo#318](https://github.com/opencv/opencv_zoo/issues/318)) still has no maintainer answer on 2026-11-11. SFace may be used to benchmark verification in this POC, not in production without written provenance or a replacement model.
- ONNX Runtime Web: MIT, no LICENSE file in the npm package; a license notice is emitted next to its WASM. No outbound request was observed from it.
- A face template is biometric data in many jurisdictions. The lab stores templates only in this browser, deletable, and never in reports; production use needs legal review.

## Tests performed

- `npm run verify`: ESLint (0 problems), Prettier, 256 unit tests in 22 files (179 in 15 files at the end of Phase 2; 77 added), production build.
- Mutation checks: 24 small changes to the new logic (YuNet decoding, alignment, engine, gates, calibration, identity manager, FACE_MISMATCH, controller wiring, monitor); every one made a test fail. List in `docs/TESTING_GUIDE.md`.
- Browser smoke test, headless, Chromium synthetic camera at 1280×720 and 20 fps (no face). New scenarios M (verifier on WASM), N (live switch to WebGPU), O (identity storage, enrollment refusing frames without a face, no FACE_MISMATCH without a reference, deletion, verification worker CSP and egress guard).

| Run                                                         | Browser           | Functional                            | Performance |
| ----------------------------------------------------------- | ----------------- | ------------------------------------- | ----------- |
| `reports/phase3-smoke-chrome-2026-11-11T04-53-50-093Z.json` | Chrome 156, build | 71/71                                 | 12/12       |
| `reports/phase3-smoke-msedge-2026-11-11T05-05-43-962Z.json` | Edge 157, build   | 71/71                                 | 12/12       |
| `reports/phase3-smoke-chrome-2026-11-11T05-02-17-379Z.json` | Chrome 156, dev   | 65/65 (6 checks need the build's CSP) | 12/12       |

Five other runs failed: one on a bug in the new scenarios (fixed), four because the synthetic camera ended its track (Edge twice, Chrome dev twice). A bare `getUserMedia` page without app code reproduced the track ending in Edge, so this is the synthetic device.

- Quantization follow-up: 265 unit tests in 24 files (9 added: `onnxGraph` on synthetic ONNX protobufs, including subgraph inputs, graph-output passthrough, and malformed bytes; the int8bq load path of the engine; the serial queue). Disabling the input pruning made the engine test fail. Smoke test with int8bq as the default and a new check that its 29 unread inputs were dropped: `reports/phase3-smoke-chrome-2026-11-11T06-34-37-472Z.json` (Chrome, build) 72/72 and 12/12; `reports/phase3-smoke-msedge-2026-11-11T06-39-02-131Z.json` (Edge, build) 72/72 and 12/12. Five more attempts (one Chrome, four Edge) stopped in scenario A because the synthetic camera ended its track, as described above.
- Not verified: anything with a real face (enrollment, comparison, FACE_MISMATCH in the browser, calibration rates), Firefox, other GPUs and machines.

## Measured results

Host: i5-12450H (12 threads), 16 GB, Intel UHD Graphics, Windows 11; headless browsers. 8 s windows at 2 FPS, 16 frames each. No face: YuNet runs on every frame and finds none; SFace embeds a centre crop of the frame. Machine-wide CPU load during the verifier windows (all processes): 32–34% in the Chrome runs, 43% (WASM) and 84% (WebGPU) in the Edge run, so the Edge WebGPU numbers were taken on a heavily loaded machine.

**Initialization**

| Metric                                     |       Chrome build |           Edge build |         Chrome dev |
| ------------------------------------------ | -----------------: | -------------------: | -----------------: |
| Worker spawn → ready (WASM)                |            2704 ms |              4112 ms |            1360 ms |
| — model fetch and SHA-256 (38.9 MB)        |            1603 ms |              2452 ms |             202 ms |
| — session creation (detector + recognizer) | 875 (759 + 116) ms | 1313 (1169 + 143) ms | 822 (664 + 156) ms |
| — warm-up (both models once)               |             171 ms |               255 ms |             171 ms |
| Live switch to WebGPU (request → done)     |            4013 ms |             20449 ms |            3227 ms |
| — WebGPU session creation / warm-up        |      591 / 1799 ms |      2025 / 14136 ms |      849 / 1956 ms |

Model fetch and hashing varied from 202 to 2452 ms across the three runs; the cause was not investigated.

**Per-frame latency, p50 in ms** (engine total includes the detector input copy and decoding)

| Run               | Provider | Engine total | Detector (YuNet 640×384) | Alignment crop | Recognizer (SFace fp32) | Camera → result p95 |
| ----------------- | -------- | -----------: | -----------------------: | -------------: | ----------------------: | ------------------: |
| Chrome build      | WASM     |         80.3 |                     25.8 |            5.9 |                    28.0 |               101.0 |
| Chrome build      | WebGPU   |        304.4 |                    147.4 |            6.7 |                   125.3 |               323.2 |
| Edge build        | WASM     |        102.6 |                     32.9 |            8.1 |                    35.4 |               123.6 |
| Edge build        | WebGPU   |        241.2 |                    114.5 |            8.8 |                    80.9 |               444.4 |
| Chrome dev server | WASM     |         60.5 |                     14.1 |            5.7 |                    22.3 |                97.6 |
| Chrome dev server | WebGPU   |        301.7 |                    147.8 |            7.9 |                   120.9 |               446.9 |

Standalone experiment before integration (module worker with the app's headers, 20 runs after warm-up, Chrome headless, medians): YuNet 640×384 14.2 ms on WASM against 59.1 ms on WebGPU; SFace fp32 25.1 ms against 36.8 ms; **SFace int8 129 ms on WASM and 354 ms on WebGPU**, slower than fp32 on both. The first WebGPU run of SFace fp32 took 4029 ms.

**Embedding agreement**: the self-check embedding of the same synthetic input was identical on WASM and WebGPU (cosine 1.000000 in all three runs). fp32 and int8 SFace gave cosine 0.9515 for the same input, so their embeddings are not interchangeable.

**Memory** (Chrome, WASM, fp32, one measurement): verification worker 135.2 MB, page 8.8 MB, total 145.3 MB (the face landmarker was not loaded).

**Rate**: 1.99–2.04 FPS on both providers in all runs, against the 2 FPS target.

What the numbers show:

- On this laptop WASM is the faster provider for both models, in both browsers; WebGPU on Intel UHD added 2.4–5 times to the engine time. WASM is the default; WebGPU stays selectable for other GPUs.
- int8 SFace is 5 times slower than fp32 on WASM here. It saves 28.8 MB of download, not time. (The follow-up below makes int8bq the default.)
- At 2 FPS the WASM verifier uses 60–100 ms of one worker per frame, which leaves headroom; the face landmarker held its 5 FPS in the same runs (I–K), but the two were not measured running together.
- The run-to-run spread is large (WASM p50 60.5–102.6 ms), and the Edge run had more machine load; more runs, and runs with a real face, are needed before comparing browsers.
- Switching to WebGPU costs seconds of shader compilation (1.8–2.0 s warm-up at normal load, 14.1 s on the loaded machine); frames keep flowing on WASM meanwhile.
- The verifier worker's 135 MB is the largest memory cost in the lab so far.

## Quantized SFace (follow-up, 2026-11-11)

Question from the review: can a quantized SFace replace the 38.7 MB fp32 file? OpenCV Zoo publishes two quantized files of the same network. They work differently:

- `ocv-sface-int8` (9.9 MB): static QDQ quantization. Weights and activations are int8 and the convolutions run as `QLinearConv`.
- `ocv-sface-int8bq` (10.7 MB): weight-only block quantization (blocks of 64). Weights are stored as int8 and turned back into float32 by `DequantizeLinear`; the convolutions run in float32.

**Published accuracy** (OpenCV Zoo README, LFW, YuNet boxes, InsightFace's LFW protocol): fp32 0.9940, int8bq 0.9942, int8 0.9932.

**Measured in the app** (Chrome headless, same host as above; each variant in a fresh verification worker; 10 s windows at 2 FPS with 20 recognizer runs each; three rounds on WASM in alternating order, one on WebGPU; centre crop without a face; memory measured once, in round 1):

| WASM                            | SFace fp32       | SFace int8bq     | SFace int8          |
| ------------------------------- | ---------------- | ---------------- | ------------------- |
| Recognizer p50, ms (rounds 1–3) | 26.1, 21.2, 22.2 | 21.3, 21.3, 21.5 | 119.9, 101.5, 97.3  |
| Recognizer p95, ms              | 41.5, 23.6, 23.5 | 22.7, 23.6, 26.9 | 136.6, 141.0, 103.7 |
| Engine total p50, ms            | 59.4, 50.8, 51.6 | 49.3, 51.7, 51.6 | 155.6, 130.8, 126.8 |
| Worker spawn → ready, ms        | 2054, 1381, 1364 | 696, 701, 663    | 887, 709, 618       |
| — model fetch and SHA-256, ms   | 1515, 1100, 1076 | 345, 350, 333    | 340, 322, 275       |
| Verification worker memory      | 130.2 MB         | 130.9 MB         | 51.2 MB             |
| Machine CPU load in the window  | 19–30%           | 19–31%           | 25–52%              |

| WebGPU (round 1)     | SFace fp32 | SFace int8bq | SFace int8 |
| -------------------- | ---------: | -----------: | ---------: |
| Recognizer p50, ms   |      113.8 |        108.9 |      334.8 |
| Engine total p50, ms |      225.1 |        220.8 |      436.8 |

**Agreement with fp32** (self-check embedding of the fixed synthetic input; cosine similarity): int8bq 0.999445, int8 0.951531. On a second, pseudo-random input (ONNX Runtime in Node, WASM): int8bq 0.991150. Each variant gave the same embedding on WASM and WebGPU (cosine 1.000000, 0.999999 for int8).

**Making int8bq load and run fast** (both in the engine; the pinned file is unchanged):

- The int8bq graph still declares its 29 original float weights as graph inputs, though no node reads them. ONNX Runtime then demands a feed for each, and the engine's signature check refused the model. After the SHA-256 check, the engine now drops graph inputs that no node (including subgraph nodes) reads and that are not graph outputs (`src/engines/verification/onnxGraph.js`, 18.8 ms for this file in Node). The same function leaves the fp32, int8, and YuNet files byte-identical.
- By default ONNX Runtime keeps `DequantizeLinear` nodes out of constant folding, so every run dequantized all weights again: recognizer p50 44.6–61.8 ms on WASM, at 72.4–72.6 MB worker memory. With the session option `session.disable_quant_qdq = 1` the weights fold to float32 once, when the session is created: 21.3–21.5 ms, at fp32's memory (table above). Outputs were identical either way (cosine 1.0000000).

What this shows:

- int8bq is as fast as fp32 on both providers, gives practically the same embeddings, and has the same published LFW accuracy. Its download is 28.0 MB smaller, which made the worker ready 0.7–1.4 s sooner here; on a slow network the saving is larger.
- int8bq saves download size only. With folding, the weights are float32 in memory, so the worker uses as much memory as with fp32. Without folding it would use about 58 MB less, at twice the recognizer time. Folding is chosen because it keeps the latency equal to fp32; the trade-off is one flag (`foldWeightDequantization`) in `src/config/modelAssets.js`.
- int8 is 4.5–5.6 times slower than fp32 on WASM and 2.9 times on WebGPU, and its embeddings differ (cosine 0.95). It needs 79 MB less memory than fp32. It stays selectable but is not a candidate for the default.
- **Decision: SFace int8bq is the new default recognizer.** fp32 and int8 stay selectable in the engine card.

Not measured: agreement and accuracy on real faces. The repository has no face images (licensing and privacy), and the synthetic inputs above are not faces. The calibration panel computes FAR, FRR, and EER per variant, so the checklist captures in `docs/TESTING_GUIDE.md` will give the real numbers for int8bq. OpenCV Zoo's threshold 0.363 was published for fp32 SFace; it is the starting value for int8bq too and must be checked with those captures.

Files of the follow-up. New: `src/engines/verification/onnxGraph.js`, `src/utils/serialQueue.js`, `tests/engines/verification/onnxGraph.test.js`, `tests/utils/serialQueue.test.js`, `tests/helpers/onnxProto.js`. Changed: `src/config/modelAssets.js` (int8bq pin and its two flags), `FaceVerificationEngine.js`, `ortRuntime.js`, `faceVerifierConfig.js` (default), `src/app/LabController.js`, `src/config/detection.config.js`, `src/ui/detections/EngineCard.jsx`, `scripts/browser-smoke.mjs`, `tests/engines/verification/FaceVerificationEngine.test.js`, and the docs. No dependency was added.

Consequence for existing data: a reference or calibration capture made with fp32 is not compared with int8bq embeddings (the Identity panel shows the model mismatch). Re-enroll and capture again, or switch the recognizer back to fp32.

## Problems found and fixed

| Problem                                                                                                                                                      | Found by                  | Fix                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| int8bq SFace refused with "The recognizer model must have one input and an embedding output"                                                                 | Quantization benchmark    | Graph inputs that no node reads are dropped after the hash check (`onnxGraph.js`); unit tests with synthetic ONNX protobufs and a smoke check (29 dropped)                                                         |
| int8bq SFace ran 2–3 times slower than fp32 because the weights were dequantized on every run                                                                | Quantization benchmark    | Session option `session.disable_quant_qdq = 1` for weight-only quantized models, so the weights fold once at load                                                                                                  |
| A model or option change during detection broke the WebGPU worker ("memory access out of bounds" on every later run; looked like "int8 on WebGPU times out") | Quantization benchmark    | All ONNX Runtime calls in a worker go through one queue (`src/utils/serialQueue.js`). Same sequence with fp32: failed 2 of 2 times before, passed 2 of 2 after; all variants now switch on WebGPU during detection |
| Start detection failed with "TypeError: Cannot read properties of undefined (reading 'clear')"                                                               | User report               | A two-part edit to `PerformanceMonitor` was half applied when the user built; completed, regression test added, the stale build reproduced the error and the fresh one did not                                     |
| ONNX Runtime's default import inlines its WASM glue, which cannot then start its thread workers under the CSP                                                | Inspection of the package | "Extern WASM" build via a resolve condition; glue and binary served from the package                                                                                                                               |
| SFace logs one warning per weight (initializers listed as graph inputs)                                                                                      | Model inspection          | ONNX Runtime log level set to errors                                                                                                                                                                               |
| A provider switch could release sessions while a frame was still running on them                                                                             | Unit test                 | Old sessions are released after the running frame settles                                                                                                                                                          |
| One controller test counted results of every engine and broke when the verifier was added                                                                    | Unit test                 | The test now runs only the engine it is about                                                                                                                                                                      |
| The gate table showed nine dashes when no face was in view                                                                                                   | UI screenshot             | One line "no face detected" instead                                                                                                                                                                                |

## Exit criteria

| Criterion (from `docs/IMPLEMENTATION_PLAN.md`)                                                                   | Status                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| FaceVerificationEngine with YuNet, alignment, SFace fp32 and int8, provider recorded                             | Done; int8bq added and made the default                                                          |
| Enrollment with a quality gate; reference in IndexedDB, separate, deletable                                      | Done; storage round trip and deletion checked in the browser; enrollment with a face not yet run |
| Calibration tool: FAR, FRR, ROC, EER, score distributions; thresholds configurable; similarity not a probability | Done (unit-tested math; UI rendered)                                                             |
| FAR/FRR measured on a defined local test set with its composition documented                                     | **Open**: needs captures of real persons (checklist in `docs/TESTING_GUIDE.md`)                  |
| SFace provenance status restated                                                                                 | Done (above and in `docs/MODEL_LICENSES.md`)                                                     |

## Limitations

The main ones (full list in `docs/KNOWN_LIMITATIONS.md`):

- No real face has been enrolled, verified, or calibrated; 0.363 is OpenCV Zoo's default, not a calibrated threshold.
- Latency was measured on a centre crop without a face; alignment from real landmarks and multi-face frames are not covered.
- Only the largest face is embedded; FACE_MISMATCH does not fire for frames that fail the verification gate.
- The yaw proxy is uncalibrated; quality-gate thresholds are starting values.
- SFace training-data provenance is undocumented; benchmarking only.
- Face templates are biometric data; stored locally until deleted, browsers may evict IndexedDB.

## Next step

1. Run the Phase 3 checklist in `docs/TESTING_GUIDE.md` with a real webcam (with int8bq, the new default; a reference enrolled with fp32 must be enrolled again): enroll yourself, check verification and FACE_MISMATCH with a second person, then capture at least two persons under a few conditions in the Calibration panel. Send the calibration export and an exported report (WASM, and WebGPU if you try it).
2. From those: FAR/FRR at 0.363 and the EER and FAR ≤ 1% thresholds on that test set, and a threshold decision for FACE_MISMATCH.
3. After your approval: Phase 4, head pose, gaze, and eye state (from MediaPipe's transformation matrix, iris landmarks, and blendshapes).
