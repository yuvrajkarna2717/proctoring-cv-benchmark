# Phase 2 report — Face detection and temporal evaluation

Date: 2026-11-10. Deliverable: MediaPipe Face Landmarker in a worker on the GPU and CPU delegates, a canvas overlay, and a temporal evaluation and violation engine for `NO_FACE` and `MULTIPLE_FACES`, verified with unit tests and the browser smoke test. Update 2026-11-10: the user ran the real-webcam checklist and reported both rules accurate; per-delegate latency with a face is still unrecorded (see "Exit criteria"). Phase 2 is closed; Phase 3 started.

## What was built

- **Face engine** (`src/engines/face/`, `src/workers/face.worker.js`): MediaPipe Face Landmarker in `VIDEO` mode, up to 3 faces, GPU (WebGL2 in the worker) or CPU (XNNPACK WASM) delegate, automatic CPU fallback with the reason shown, live delegate switch in the same worker, strictly increasing timestamps from camera capture times. Observations `FACE_COUNT` and `FACE` (box from landmarks, partly-out-of-frame flag); landmarks travel to the main thread as transferred `Float32Array`s. Blendshapes and transformation matrices can be switched on for Phase 4.
- **Assets**: `npm run fetch-models` downloads the model and keeps it only if its size and SHA-256 match the pinned values; the engine checks the SHA-256 again after loading. A Vite plugin serves the MediaPipe WASM from the installed npm package in dev and emits it, with a license notice, into the build. Nothing is loaded from a CDN.
- **Violations** (`src/pipeline/TemporalCondition.js`, `ViolationEngine.js`): per-rule minimum duration measured from the onset frame, hysteresis, cooldown, gap handling, start and end events, severity, bounded history, per-rule statistics, hidden-page flag. Rules are editable live in the UI.
- **UI**: face overlay on the preview (boxes, optional landmarks, mirrored with the preview), Violations panel (rule state, editable thresholds, history), face controls in the engine card (delegate, max faces, confidences, provider, fallback reason, task-creation times, blocked requests), "configuring" state during a delegate switch.
- **Security**: the CSP is now also sent as a response header, so it applies inside the workers; worker CSP violations are reported to the page; every worker has an egress guard that refuses requests to other origins, because MediaPipe 1.2.2 sends usage statistics to Google.
- **Smoke test**: new scenarios for the face engine on both delegates, the violation rules, and security inside the face worker; the browser can resolve only localhost and every request is checked.
- **Fixes to existing code**: error class names survive minification; a `configure` request gets the init timeout (creating a GPU task with its warm-up takes 3.5–4 s).

## Files

| Area      | New                                                                                                                                                      | Changed                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project   | `scripts/fetch-models.mjs`, `scripts/vite-plugin-mediapipe-wasm.js`, `public/models/README.md`                                                           | `package.json` (dependency, `fetch-models` script), `package-lock.json`, `vite.config.js` (plugin, CSP header, `optimizeDeps`)                                                                                  |
| Config    | `src/config/modelAssets.js`                                                                                                                              | `src/config/schema.js`, `src/config/detection.config.js`                                                                                                                                                        |
| Engines   | `src/engines/face/FaceLandmarkerEngine.js`, `faceLandmarkerConfig.js`, `mediapipeRuntime.js`, `mediapipeAssets.js`                                       | `src/engines/BaseDetectionEngine.js`, `EngineContract.js`, `engineKinds.js`                                                                                                                                     |
| Workers   | `src/workers/face.worker.js`, `egressGuard.js`                                                                                                           | `src/workers/protocol.js`, `engineHost.js`, `WorkerEngineClient.js`, `workerFactories.js`, `diagnostic.worker.js`                                                                                               |
| Pipeline  | `src/pipeline/TemporalCondition.js`, `ViolationEngine.js`                                                                                                | —                                                                                                                                                                                                               |
| App, UI   | `src/ui/camera/FaceOverlay.jsx`, `src/ui/violations/ViolationsPanel.jsx`                                                                                 | `src/app/LabController.js`, `App.jsx`, `app.css`, `routes/LiveTestingPage.jsx`, `src/ui/camera/CameraPanel.jsx`, `ConsentNotice.jsx`, `src/ui/detections/EngineCard.jsx`, `src/ui/common/CommitNumberInput.jsx` |
| Utilities | —                                                                                                                                                        | `src/utils/errors.js`                                                                                                                                                                                           |
| Tests     | `tests/engines/FaceLandmarkerEngine.test.js`, `tests/pipeline/TemporalCondition.test.js`, `ViolationEngine.test.js`, `tests/workers/egressGuard.test.js` | `tests/helpers/fakes.js`, `tests/workers/engineRpc.test.js`, `tests/app/LabController.test.js`, `tests/config/config.test.js`, `tests/utils/errors.test.js`, `scripts/browser-smoke.mjs`                        |
| Docs      | this report                                                                                                                                              | `README.md`, `docs/IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `MODEL_LICENSES.md`, `TESTING_GUIDE.md`, `KNOWN_LIMITATIONS.md`                                                                                  |

## Dependencies added

| Package                   | Version       | Kind    | Why                                                                                      |
| ------------------------- | ------------- | ------- | ---------------------------------------------------------------------------------------- |
| `@mediapipe/tasks-vision` | 1.2.2 (exact) | runtime | Face Landmarker; its WASM files are served from the installed package by the Vite plugin |

No other dependencies changed. `npm audit` reports no finding in runtime dependencies and 4 moderate findings in ESLint's development dependency chain (`minimatch`, GHSA-g3hv-75wg-m249), which is not shipped.

Build output added by Phase 2: `face.worker` chunk 7.4 kB, `FaceLandmarkerEngine` 77.5 kB, `mediapipeRuntime` (MediaPipe JavaScript) 155 kB, WASM loader 334 kB, WASM binary 14.6 MB (4.19 MB gzip). The model (3.8 MB) is copied from `public/models/`.

## Models and licenses

| ID                   | File                                 | Size (bytes) | SHA-256                                                            | License                  | Status                                                        |
| -------------------- | ------------------------------------ | -----------: | ------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------- |
| `mp-face-landmarker` | `face_landmarker.task` (float16, v1) |    3,758,596 | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` | Apache-2.0 (model cards) | Integrated; cleared for POC, review before production         |
| `mp-blazeface-short` | `blaze_face_short_range.tflite`      |      229,746 | —                                                                  | Apache-2.0 (model card)  | Optional baseline deferred (not needed for the exit criteria) |

- Source: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`. The download matched the MD5 Google Cloud Storage reports for the object.
- The model cards name AR and entertainment as the intended use, exclude human life-critical decisions, and put surveillance and identity recognition out of scope. Proctoring needs legal and ethics review before production.
- Whether Apache-2.0 covers every file inside the `.task` bundle is an open question (public forum thread, no maintainer answer).
- **MediaPipe Tasks Vision 1.2.2 sends usage statistics** (task type, running mode, platform, library version, initialization time, call counts, latencies; no image or landmark data seen) to `https://odml.pa.googleapis.com/v1/log` every 60 s and when a task is closed, with an API key embedded in the library. The API has no switch to turn it off. The lab refuses these requests in the workers and logs the refusal; production builds also block them with the CSP. Details: `docs/MODEL_LICENSES.md`.

## Tests performed

- `npm run verify`: ESLint (0 problems), Prettier check, 179 unit tests in 15 files (129 in 11 files at the end of Phase 1; 50 added), production build.
- New unit tests: `FaceLandmarkerEngine` (16), `TemporalCondition` (12), `ViolationEngine` (9), `egressGuard` (5); additions to the RPC, controller, config, and error tests. Coverage per area is listed in `docs/TESTING_GUIDE.md`.
- Mutation checks: 18 small changes to the new logic (temporal rules, violation gating, egress guard, payload transfer, face engine, controller), each run against its test file. All 18 made a test fail; two did so only after a test was strengthened and one was added. A nineteenth hit redundant code, which was removed.
- `npm run fetch-models -- --check` detected a deliberately flipped byte in the model file, and a fetch restored the file.
- Browser smoke test, headless, Chromium synthetic camera at 1280×720 and 20 fps (no face), five production-build runs and one dev-server run, all passing:

| Run                                                         | Browser              | Functional                                  | Performance |
| ----------------------------------------------------------- | -------------------- | ------------------------------------------- | ----------- |
| `reports/phase2-smoke-chrome-2026-11-10T09-13-27-402Z.json` | Chrome 156.0.8078.80 | 52/52 (before the error-name check existed) | 9/9         |
| `reports/phase2-smoke-chrome-2026-11-10T09-18-30-071Z.json` | Chrome 156.0.8078.80 | 53/53                                       | 9/9         |
| `reports/phase2-smoke-msedge-2026-11-10T09-21-02-315Z.json` | Edge 157.0.4341.42   | 53/53                                       | 9/9         |
| `reports/phase2-smoke-chrome-2026-11-10T09-32-01-984Z.json` | Chrome 156.0.8078.80 | 53/53                                       | 9/9         |
| `reports/phase2-smoke-chrome-2026-11-10T09-45-24-425Z.json` | Chrome 156.0.8078.80 | 53/53                                       | 9/9         |
| `reports/phase2-smoke-chrome-2026-11-10T09-23-18-918Z.json` | Chrome, dev server   | 49/49 (4 checks need the build's CSP)       | 9/9         |

Three other runs failed: one on a test bug since fixed (the CSP `eval` probe ran inside a DevTools evaluation, which may compile strings despite the CSP), and two because the synthetic camera ended its track (Chrome during the memory measurement in window C; Edge at startup). Their reports are kept in `reports/`.

- Not verified yet: anything with a real face (latency with the landmark model, MULTIPLE_FACES, the end of NO_FACE when the face returns, the cooldown in the browser, the overlay on a face), Firefox with the face engine, other machines and cameras.

## Measured results

Host: i5-12450H (12 threads), 16 GB, Intel UHD Graphics, Windows 11; headless Chrome and Edge used the GPU through ANGLE (Direct3D 11). Machine-wide CPU load during the face windows was 19–32%. The synthetic camera shows no face, so every frame ran the face detector only; the landmark model never ran. 8 s windows, 40–41 frames per delegate and run, 1280×720 input. Ranges are across the five production-build runs.

**Initialization (GPU delegate)**

| Metric                                   | Range              |
| ---------------------------------------- | ------------------ |
| Worker spawn → ready                     | 3809–4106 ms       |
| — engine and MediaPipe module load       | 38–95 ms           |
| — model fetch and SHA-256 check (3.8 MB) | 168–286 ms         |
| — GPU task creation                      | 269–362 ms         |
| — warm-up (shader compilation)           | 3278–3470 ms       |
| Live switch to CPU, request → done       | 258–322 ms         |
| — CPU task creation / warm-up            | 177–225 / 59–73 ms |

**Inference per delegate** (`detectForVideo` in the worker), ms:

| Run                | GPU mean / p50 / p95 / max    | CPU mean / p50 / p95 / max    |
| ------------------ | ----------------------------- | ----------------------------- |
| Chrome 09-13       | 11.51 / 10.61 / 14.02 / 44.59 | 11.86 / 10.21 / 21.17 / 34.30 |
| Chrome 09-18       | 14.63 / 12.98 / 29.09 / 50.48 | 14.80 / 12.75 / 32.08 / 33.09 |
| Edge 09-21         | 11.42 / 10.66 / 13.89 / 29.47 | 12.05 / 11.11 / 14.94 / 33.24 |
| Chrome 09-32       | 14.46 / 11.98 / 31.11 / 43.13 | 12.69 / 11.63 / 20.36 / 26.54 |
| Chrome 09-45       | 12.91 / 12.96 / 16.75 / 19.17 | 13.61 / 12.98 / 18.79 / 36.24 |
| Chrome, dev server | 15.36 / 13.90 / 29.85 / 46.95 | 12.16 / 11.54 / 16.82 / 17.51 |

| Metric (production build)                   | GPU          | CPU          |
| ------------------------------------------- | ------------ | ------------ |
| Camera capture → result on main thread, p50 | 12.2–15.1 ms | 11.6–15.4 ms |
| Camera capture → result on main thread, p95 | 15.6–36.9 ms | 17.7–33.9 ms |
| Capture (`createImageBitmap`) p95           | 0.5–0.9 ms   | 0.5–0.8 ms   |
| Transport (both `postMessage` hops) p95     | 0.8–4.3 ms   | 0.7–1.8 ms   |
| Average FPS (target 5)                      | 5.01–5.04    | 5.00–5.04    |
| Frames over 100 ms                          | 0            | 0            |

**Violations**: with the NO_FACE minimum duration set to 1500 ms in the UI, NO_FACE was confirmed 1596–1646 ms after its onset frame (one frame interval is 200 ms) and 1631–1677 ms after the Start detection click. Stopping detection ended it with reason `stopped`. MULTIPLE_FACES never fired.

**Memory** (one run, Chrome, GPU delegate, `measureUserAgentSpecificMemory`, 14 s): face worker 15.4 MB (JavaScript and WASM heap, including the model), page 6.7 MB, unattributed 1.1 MB, total 23.3 MB. GPU memory is not observable. For comparison, the two diagnostic workers plus page measured 9.3 MB in the same run.

**Network**: 17 requests per production-build run, all to the app's origin; none to another origin in any run. MediaPipe's usage-statistics request was refused once per run, when the GPU task closed during the delegate switch.

What the numbers show:

- Without a face, the two delegates are within run-to-run variation of each other. These runs cannot decide the default delegate; the real-webcam reports (landmark model running) will. GPU stays the default until then.
- GPU costs its time at start: about 3.4 s of shader compilation per GPU task, against about 0.06 s of CPU warm-up. A live switch to CPU takes about 0.3 s, and frames keep flowing on the old task meanwhile.
- The face engine held 5 FPS in every window, and the main-thread side of each frame stayed small: capture p95 at most 0.9 ms, transport p95 at most 1.8 ms except one Edge GPU window (4.3 ms).
- NO_FACE confirmation landed 96–146 ms after the minimum duration, inside one sampling interval, as designed.

## Problems found and fixed

| Problem                                                                                                                                                       | Found by                                   | Fix                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MediaPipe 1.2.2 posts usage statistics to `odml.pa.googleapis.com` every 60 s and on task close                                                               | Request monitoring in a browser experiment | Egress guard in every worker, refusals reported and logged; CSP as a header (below); smoke test checks it                                 |
| Dedicated workers did not get the CSP: it was only a `<meta>` tag, which workers do not inherit (Phase 1 workers ran without a CSP)                           | Review of how workers get their policy     | CSP also sent as a response header by `vite preview`; worker CSP violations forwarded to the page; smoke test probes `eval` in the worker |
| A second MediaPipe task in the same worker (delegate switch) failed with "ModuleFactory not set."                                                             | Browser experiment                         | The runtime restores `globalThis.ModuleFactory` from the WASM loader's default export                                                     |
| The dev server reloaded the page when the face engine first loaded (`face_landmarker.task net::ERR_ABORTED`)                                                  | Dev-server experiment                      | `optimizeDeps.include` for `@mediapipe/tasks-vision` (imported only from worker code)                                                     |
| The egress guard blocked the Vite dev client's WebSocket in the worker ("Failed to send error to Vite server")                                                | Dev-server experiment                      | WebSockets to the same host and port are allowed                                                                                          |
| Vite's license report covers only the main bundle, not workers or copied WASM                                                                                 | Review of the build output                 | `LICENSE-NOTICE.txt` emitted next to the WASM                                                                                             |
| Minified builds renamed error classes, so logs and reports showed names like `bi` and `deserializeError` could not restore the class (also in Phase 1 builds) | Smoke test (worker CSP violation log line) | Explicit `errorName` per class; unit test over all exported classes; smoke check of the logged name                                       |
| A switch to the GPU delegate (new GPU task plus warm-up, 3.5–4 s here) gave no feedback and could approach the 10 s request timeout on a slower machine       | Review                                     | `configure` uses the init timeout; the engine card shows "configuring"                                                                    |
| Violations table: empty label lines misaligned the inputs, the severity select was too narrow, a header was clipped; the header still said "Phase 1"          | Screenshot of the UI                       | Optional labels with `aria-label`, column widths, shorter headers                                                                         |

## Not reproduced: periodic inference spikes

In one headless session, inference times of 412–621 ms appeared about every 9 frames (about 1.8 s) on both delegates, also with the overlay off and the panels hidden. Seven later experiment runs (about 600 frames, including a 70 s run and a run recorded with a Chrome trace) and the six passing smoke runs showed no frame over 100 ms. The cause was not found; load from other processes during that session is the likely explanation but was not confirmed. Smoke reports now count frames over 100 ms so a recurrence is visible.

## Exit criteria

| Criterion (from `docs/IMPLEMENTATION_PLAN.md`)                                      | Status                                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Live detection works on a real webcam                                               | Done: the user ran the lab with a real webcam on 2026-11-10 and reported that it works                                     |
| `NO_FACE` and `MULTIPLE_FACES` fire and resolve correctly in the scenario checklist | Done by the user's assessment ("both of the flags are very accurate"); no exported report, so no numbers from that session |
| Per-delegate latency recorded                                                       | Partly: recorded for the detector-only path (above); with a face not recorded, because no GPU/CPU reports were exported    |
| Temporal logic covered by unit tests                                                | Done: 21 tests for `TemporalCondition` and `ViolationEngine`, plus the controller's detection-state test; mutation-checked |

## Limitations

The main ones (full list in `docs/KNOWN_LIMITATIONS.md`):

- No measurement with a face yet; no accuracy measurement (no annotated recordings until Phase 7); thresholds are the plan's starting values.
- `FACE_COUNT` is capped at 3 faces; MediaPipe gives no per-face score; strong head turns (beyond about 80°) are expected to give NO_FACE.
- Violation times are quantized to the 200 ms sampling interval; starting detection clears the history.
- The synthetic cameras of Chrome and Edge occasionally end their track; affected smoke runs must be rerun.
- The missed-callback and frame-clock stall counters still include hidden-page time (open from Phase 1).
- The deployment must send the CSP as a header, or the workers have no CSP; the egress guard alone does not cover every channel.

## Next step

1. Run the Phase 2 webcam checklist in `docs/TESTING_GUIDE.md` on the production build in Chrome (Edge and Firefox if possible), and send the two exported reports from steps 12 (GPU) and 13 (CPU), plus notes on step 8 (head turns, partial faces).
2. From those reports: choose the default delegate, and fix whatever the checklist turns up.
3. After your approval: Phase 3, face verification (YuNet detection, alignment, SFace embeddings on ONNX Runtime Web, enrollment with a quality gate, threshold calibration).
