# Implementation plan

Goal: answer, with measurements, which browser-executable models can replace or reduce cloud computer vision (AWS Rekognition) in the proctoring product. Each phase ends with a verification run and a phase report (`docs/PHASE<n>_REPORT.md`).

## Environment at project start (2026-11-09)

| Item      | Value                                                                           |
| --------- | ------------------------------------------------------------------------------- |
| OS / CPU  | Windows 11 (10.0.26200), Intel Core i5-12450H (8 cores / 12 threads), 16 GB     |
| GPU       | Intel UHD Graphics (WebGPU adapter `intel gen-12lp` available)                  |
| Toolchain | Node 24.20.0, npm 11.19.0                                                       |
| Browsers  | Chrome 156, Edge 157, Firefox 157                                               |
| Key libs  | Vite 8.3.6, React 19.3.1, MediaPipe Tasks Vision 1.2.2, ONNX Runtime Web 1.31.1 |

## Technical decisions

| Decision                                                                                | Reason                                                                                                            |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| JavaScript with JSDoc contracts, Zod for configuration                                  | Requested; Zod catches invalid thresholds at load time and in the UI.                                             |
| One dedicated worker per engine instance, one worker entry file per engine kind         | Isolation (a hung model cannot stall others), true parallelism, independent restart, per-kind memory attribution. |
| Main thread only schedules and copies frames; frames move as transferred `ImageBitmap`s | Keeps the preview and UI responsive; one copy per dispatched request.                                             |
| Capture on demand instead of a frame queue                                              | An engine always receives the newest frame; a slow engine loses sampling slots instead of building a backlog.     |
| `requestVideoFrameCallback` clock with watchdog fallback                                | Camera capture timestamps for latency; detection continues if the compositor stops presenting frames.             |
| COOP/COEP headers and self-hosted models/WASM                                           | Multi-threaded WASM and cross-worker memory measurement need cross-origin isolation.                              |
| CSP with `connect-src 'self'` in builds, sent as a header so workers get it too         | Enforces "no webcam data leaves the browser" technically.                                                         |
| Egress guard in every worker                                                            | Refuses requests to other origins also in dev, where there is no CSP; MediaPipe 1.2.2 sends usage statistics.     |
| Exact pin of `@mediapipe/tasks-vision`; WASM served from the installed package          | Benchmarks stay reproducible; the WASM always matches the bundled JavaScript; no CDN.                             |
| Model files downloaded by a script with a pinned SHA-256 and checked again at load      | No binaries in git; a replaced or corrupted file is refused.                                                      |
| Identity decisions on the main thread; engines only report embeddings                   | The verifier never sees the reference; gates, comparison, and calibration are testable without models.            |
| Identity data only as templates in IndexedDB, deletable, never in reports               | Local-only processing; a reference survives reloads without storing images.                                       |
| MediaPipe for face/landmarks/object detection, ONNX Runtime Web for OpenCV Zoo models   | Covers the selected models with two runtimes. TF.js and OpenCV.js are not added (see `docs/MODEL_LICENSES.md`).   |
| Headless smoke test with `playwright-core` driving installed browsers                   | Verifies the real camera → worker path; no browser download.                                                      |

## Phases

### Phase 1 — Foundation (done)

Delivered: Vite/React scaffold, camera capture, frame clock, per-engine schedulers, worker RPC with timeouts and restart, engine contract, diagnostic engine, performance monitor, device profiler, live testing UI, report export, unit tests, browser smoke test. See `docs/PHASE1_REPORT.md`.

### Phase 2 — Face detection and temporal evaluation (done)

- `FaceLandmarkerEngine` (MediaPipe Face Landmarker, `numFaces` 3, VIDEO mode). Measure GPU and CPU delegates; keep the faster one that passes validation.
- Observations: face count, boxes (from landmarks), landmark payload sent as transferable `Float32Array`s, blendshapes and transformation matrices kept for Phase 4.
- Optional baseline: BlazeFace-only Face Detector engine for face presence, compared on latency and agreement.
- Canvas overlay for boxes and landmarks.
- Temporal evaluation layer and violation engine (separate from engines): duration thresholds, hysteresis, cooldowns, event start/end, severity, history. Events `NO_FACE` (800–1000 ms) and `MULTIPLE_FACES` (500–800 ms) as configurable starting values.
- `scripts/fetch-models.mjs`: downloads from the URLs in `docs/MODEL_LICENSES.md` and verifies pinned SHA-256; MediaPipe WASM self-hosted.
- Exit: live detection works on a real webcam; `NO_FACE` and `MULTIPLE_FACES` fire and resolve correctly in the scenario checklist; per-delegate latency recorded; temporal logic covered by unit tests.

Status (2026-11-10): everything above is implemented except the optional BlazeFace baseline, which is deferred. Unit tests and the smoke test pass (see `docs/PHASE2_REPORT.md`). The user then ran the real-webcam checklist and reported that detection works and that both rules are accurate. No GPU/CPU reports were exported, so per-delegate latency with a face is still unrecorded and GPU remains the default delegate.

Found during Phase 2 and handled: MediaPipe Tasks Vision 1.2.2 sends usage statistics to Google (refused in the workers; `docs/MODEL_LICENSES.md`); dedicated workers did not get the CSP from the `<meta>` tag (now sent as a header); minified builds renamed error classes (now explicit names).

### Phase 3 — Face verification (1:1) (implemented; real-face calibration pending)

- `FaceVerificationEngine`: YuNet detection → 5-point similarity alignment to 112×112 → SFace embedding (fp32 and int8 variants) → cosine similarity. ONNX Runtime Web with WebGPU, falling back to WASM; record which provider ran.
- Enrollment with a quality gate (face size, blur, brightness) before any comparison. Reference embedding stored in IndexedDB, separate from benchmark data, deletable.
- Threshold calibration tool: capture genuine and impostor pairs (lighting, angle, distance, camera); compute FAR, FRR, ROC, EER, and score distributions. Thresholds are configuration, never hardcoded; similarity is never presented as a probability.
- Exit: FAR/FRR measured on a defined local test set with its composition documented; SFace provenance status restated.

Status (2026-11-11): implemented as planned, with one change: WASM is the default provider and WebGPU is opt-in, because WASM was faster for both models on the development laptop (Intel UHD): verifier engine time 2.4–5 times lower in the three smoke runs, 1.5–5.7 times per model including a standalone experiment; WebGPU falls back to WASM when it cannot start. Added: a `FACE_MISMATCH` rule (similarity below the threshold for 2 s on frames that pass the verification gate), per-model latency breakdown, and a self-check embedding that compares providers. SFace provenance restated in `docs/MODEL_LICENSES.md` (opencv_zoo#318 still unanswered). Open: the FAR/FRR exit criterion needs captures of real persons with the checklist in `docs/TESTING_GUIDE.md`; the synthetic camera has no face. See `docs/PHASE3_REPORT.md`.

### Phase 4 — Head pose, gaze, eye state (implemented; real-person checks pending)

- Head pose (yaw, pitch, roll) from MediaPipe's transformation matrix; optional `solvePnP` comparison.
- Gaze from iris position relative to eye corners, normalized by a per-user calibration of the normal viewing position.
- Eye openness from blendshapes (`eyeBlinkLeft/Right`) and eye aspect ratio; blink and prolonged closure as separate observations.
- Temporal rules: `GAZE_AWAY` (1500–2000 ms), `HEAD_TURNED` (1500 ms), `EYES_CLOSED` (1500 ms), all configurable.
- Exit: each observation measurable on its own against annotated recordings; calibration flow works.

Status (2026-11-11): implemented, with additions aimed at users finding the old gaze check too strict or too easy to cheat:

- Every rule is measured against the person's own screen area (a guided 15 s calibration, or a baseline learned in the first 10 s) instead of a fixed angle.
- Gaze combines the head pose with the eye direction.
- A second rule, `GAZE_AWAY_REPEATED`, reported repeated short looks toward the same side (4 in 30 s); removed on 2026-11-12 at the user's request.
- Long violations escalate in severity.
- Lenient, balanced, and strict presets set tolerances and timings together.

Defaults (balanced): GAZE_AWAY 100 ms, clear after 100 ms, cooldown 1000 ms (tuned by the user for fast reports; first 2000 / 600 / 3000, then 500 / 300 / 2000 after a real-webcam test), HEAD_TURNED 1500 ms, EYES_CLOSED 2000 ms. Conventions were checked on one public-domain portrait; enabling blendshapes and matrices added no measurable latency. `solvePnP` was not compared (it needs OpenCV.js). Open: real-person checks (checklist in `docs/TESTING_GUIDE.md`) and annotated recordings (Phase 7). See `docs/PHASE4_REPORT.md`.

### Phase 5 — Image quality (implemented; real-condition checks pending)

- Brightness, under/over-exposure, contrast, Laplacian-variance blur on the face region and the full frame, face size relative to frame; 1 FPS.
- Events `LIGHTING_ISSUE`, `LOW_IMAGE_QUALITY` (the latter removed on 2026-11-12; image problems are now context on other violations only).
- Measure whether CPU readback (`getImageData`) cost matters; Phase 1 measured about 7–8 ms per 720p frame for the diagnostic engine.

Status (2026-11-11): implemented as a model-free engine at 1 FPS that measures the face region from the face landmarker's latest face box (passed with the frame as a hint).

- Sharpness is normalized by contrast, so a dark but sharp face is not called blurry.
- Both rules are severity low with 5 s minimum.
- Other violations record the image problems present when they started (`imageIssues`).
- Read-back cost: one read per sample at 640 px, 8.9 ms (Chrome) and 12.5 ms (Edge) p50 in the smoke runs; much higher while the GPU was busy in the portrait runs.

Open: limits checked on real rooms and webcams, and with diverse skin tones. See `docs/PHASE5_REPORT.md`.

### Phase 6 — Object detection (implemented; real-webcam checks pending)

- Compare EfficientDet-Lite0 int8 and Lite2 (MediaPipe) with NanoDet-Plus and YOLOX-S (ONNX Runtime Web) at 1 FPS and low priority.
- `PHONE_DETECTED` (2 of 3 detections), configurable score thresholds, false-positive review on ordinary desk objects.
- Notebook detection evaluated separately and documented with its limitations; COCO `book` is not a notebook class.
- Exit: per-model latency, memory, precision, recall on annotated recordings.

Status (2026-11-11): all four detectors integrated as separate engine instances at 1 FPS, compared in an Objects panel; one of them feeds the rules.

- `PHONE_DETECTED` on 2 of the last 3 samples at score 0.5. `BOOK_DETECTED` (off by default) was removed on 2026-11-12.
- On 12 photos (8 with a phone): YOLOX-S found 6 phones, NanoDet-Plus and Lite2 4 each, Lite0 2; one false phone (Lite2, a Kindle).
- Latency alone, Chrome, WASM/CPU: NanoDet 39 ms, Lite0 73 ms, Lite2 202 ms, YOLOX 628 ms per frame (YOLOX 235 ms on WebGPU).
- MediaPipe's GPU delegate gave wrong results with the int8 files; the CPU delegate is the default.

Follow-up (2026-11-12): `PHONE_DETECTED` never fired in a live session with NanoDet-Plus, which scored phones at arm's length below 0.5. A zoom pass now also runs each detector on full-resolution crops. MediaPipe EfficientDet-Lite2 with it is the default source: phones found in 14 of 17 webcam-like scenes (NanoDet before: 5), one false phone on a Kindle, about 0.7–0.9 s per frame. Notebooks need a custom model (COCO has no such class).

Open: precision and recall on real webcam sessions and recordings (Phase 7), false phones on real desks, a custom model for notebooks. See `docs/PHASE6_REPORT.md`.

### Phase 7 — Recording, replay, annotation

- Record sessions with `MediaRecorder` plus JSON metadata (configuration, model versions, device profile, observations).
- Replay a recording through any engine configuration in two modes: real time (same scheduler as live) and stepped (every sampled frame processed, no drops) for deterministic accuracy comparison.
- Interval-based manual annotation (face present, face count, identity, gaze, head orientation, eyes, phone, notebook, lighting). Annotations are the ground truth; no model output is used as ground truth for another model.
- Local storage in IndexedDB with export/import and delete-all.

### Phase 8 — Evaluation report

- Accuracy (TP/FP/TN/FN, precision, recall, F1, FPR, FNR; FAR/FRR/ROC/EER for identity; IoU-based matching for objects) and performance, per engine and configuration, from replayed recordings.
- `docs/MODEL_COMPARISON.md`, `docs/KNOWN_LIMITATIONS.md` update, and recommendations: which components are ready to extract into the product and how much Rekognition usage they can replace.

## Benchmark protocol (applies from Phase 2)

- Close other heavy applications; record machine CPU load with every run (the smoke test does this). In Phase 1, one run on a heavily loaded machine (97% CPU load measured right after it) recorded a 131 ms mean engine time and a 6 fps frame callback rate, against about 8 ms and 20 fps on a quieter machine.
- Use headed browsers and real webcams for reported numbers; headless runs with the synthetic camera are regression checks.
- Measure production builds (`npm run build`, then `npm run preview`). The dev server inflates memory and worker start time: the Chrome smoke test measured 41.9 MB and 105 ms against the dev server, and 7.37 MB and 38 ms against the production build.
- Run detection for at least a minute per configuration, keep the page visible and focused, and check the log for page-hidden events and main-thread stalls before using a run.
- Repeat each configuration at least three times and report the spread.
- Store every run's configuration, model versions, device profile, and raw summaries in the exported report.

## Risks

| Risk                                                                                      | Mitigation                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| The selected face-recognition weights (SFace) have no documented training-data provenance | Benchmark SFace only; escalate to legal; keep the embedding engine replaceable. |
| MediaPipe model cards place surveillance and life-critical decisions out of intended use  | Legal/ethics review; keep humans in the review loop for violations.             |
| Browser differences (Firefox, Safari)                                                     | Feature detection with fallbacks; manual test pass per phase.                   |
| Results depend on machine load and hardware                                               | Benchmark protocol above; device profile and CPU load stored with results.      |
| Synthetic camera differs from real webcams                                                | Phase 7 recordings from real webcams become the comparison baseline.            |
