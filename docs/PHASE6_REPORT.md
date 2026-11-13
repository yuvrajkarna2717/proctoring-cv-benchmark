# Phase 6 report — Object detection

> **Change, 2026-11-12:** `BOOK_DETECTED` (off by default) was removed at the user's request. `PHONE_DETECTED` is unchanged; the detectors still report `book` boxes in the Objects panel, without a rule.

Date: 2026-11-11. Deliverable: four COCO object detectors that run in the browser at 1 FPS and low priority, with the same observations for all of them. They are EfficientDet-Lite0 and Lite2 int8 on MediaPipe, and NanoDet-Plus and YOLOX-S on ONNX Runtime Web. Two new rules read the chosen detector: `PHONE_DETECTED` (2 of the last 3 samples) and `BOOK_DETECTED` (off by default). An Objects panel compares the models side by side. Verified with unit tests, mutation checks, 12 public-domain photos fed to the real app as the camera, and the browser smoke test in Chrome and Edge. Precision and recall on real webcam sessions are still open (Phase 7 recordings).

**Follow-up, 2026-11-12.** In a live session `PHONE_DETECTED` never fired while a phone was shown for 5 minutes. The cause was the default source model, not a pipeline bug: NanoDet-Plus on the whole frame scored a phone at arm's length below the 0.5 limit. The default is now MediaPipe EfficientDet-Lite2 with a **zoom pass** (below). In webcam-like scenes that found the phone in 14 of 17, against 5 of 17 before. The sections after this one describe the original Phase 6 work; where the follow-up changed something, it says so.

## Follow-up: no PHONE_DETECTED in a live session

**What was checked.** The full default setup ran in headless Chrome: face landmarker, face verifier, image quality, and the four object detectors at once, which none of the earlier tests did. The camera was a 1280×720 scene: a face portrait as the background, with a phone photo drawn over its lower half at full size, half size, or a third (a phone held close, at arm's length, further away), and slightly blurred like a webcam. 17 phone scenes from 7 photos, plus 6 scenes without a phone (Kindle, person reading a book, café) at two sizes, 9–15 frames each.

- **No pipeline bug.** Every engine got its frames: the object engines ran at 1 FPS with no failures, no stale frames, and no starved slots; the face engines kept their rates. NanoDet's samples reached the rules (`objectFramesEvaluated` matched its results). Whenever the source model scored a phone at ≥ 0.5 on 2 of 3 samples, `PHONE_DETECTED` started.
- **The model lost small phones.** The frames were scaled to 640 px before detection, so a phone at arm's length was 30–60 px wide in the model input. NanoDet scored those 0.42–0.49 and the rule never fired. This matches the live session.

**What changed:**

- **Zoom pass** (`src/engines/objects/tiles.js`, option `zoom` per engine). Besides the whole frame, the detector runs on overlapping squares cropped from the full-resolution frame and scaled to the model input. For 16:9, `tiles` adds two squares as tall as the frame, so objects are about 1.8 times larger (three model runs per frame); `fine` adds six squares of 3/4 frame height (seven runs).
  - Detections are mapped back to the frame and merged: of two boxes of the same label, the lower score is dropped when they overlap by IoU > 0.5, or when 80% of it lies inside the other (the partial phone a square sees at its edge).
  - Object engines now get native-resolution frames instead of 640 px.
- **MediaPipe in IMAGE mode.** Each crop is an independent image, which VIDEO mode (one timestamped frame at a time) does not fit.
- **New defaults:**
  - `objects-effdet-lite2` (MediaPipe EfficientDet-Lite2 int8, CPU delegate) with zoom `tiles` is on and is the rules' source.
  - NanoDet-Plus is off. All instances default to `tiles` except YOLOX-S (`off`, since it takes 0.5 s per run).
  - The rule is unchanged: score ≥ 0.5 on 2 of the last 3 samples. A lower limit was not needed, and it would have added false phones.
  - The engine cards have a "Zoom pass" selector.

**Before and after** (per-frame best `cell phone` score; a scene counts when it reached the 0.5 rule limit on its frames). Chrome 156 headless, all default engines running:

| Model, zoom                                 | Phone scenes at ≥ 0.5 (of 17) | Of them small: half or third size (of 10) | Scenes without a phone at ≥ 0.5 (of 6) |
| ------------------------------------------- | ----------------------------: | ----------------------------------------: | -------------------------------------: |
| NanoDet-Plus, off (old default)             |                             5 |                                         2 |                                      0 |
| NanoDet-Plus, tiles                         |                             8 |                                         4 |                                      0 |
| EfficientDet-Lite0, tiles                   |                             7 |                                         4 |                                      0 |
| EfficientDet-Lite2, off                     |                             9 |                                         3 |                        1 (Kindle 0.73) |
| **EfficientDet-Lite2, tiles (new default)** |                        **14** |                                     **7** |                    **1 (Kindle 0.82)** |
| YOLOX-S, off (9 plain-photo scenes only)    |                        7 of 9 |                                    4 of 6 |                                not run |

- Lite2 with tiles found the phone at every size in the three plain phone photos (scores 0.63–0.89); without the zoom pass it lost the phone in 3 of those 9 scenes. It missed it in three hard scenes at half size: a phone seen edge-on next to a cup (0.46), a dark scene with the phone edge-on (0.39), and a phone lying on a book in a dark room. It was also the only model to find the dark edge-on phone at full size (0.65).
- **False phone:** Lite2 called the Kindle e-reader a phone (0.82 with tiles, 0.73 without) at full size; at half size it did not. No other scene without a phone reached 0.5 for any model. The tiles never created a false phone on the background portrait (0 in the empty scene for every model).
- `fine` (seven runs) gave Lite2 0.75–0.86 on the nine plain scenes, close to `tiles`, at twice the cost (1.4 s per frame, so it fell to about 0.6 FPS). `tiles` is the better trade-off.

**Cost** (Chrome 156 headless, i5-12450H, all default engines running):

| Lite2 configuration                | Engine total p50 | Results per second (1 FPS target) |
| ---------------------------------- | ---------------: | --------------------------------: |
| zoom off, three other detectors on |           317 ms |                               1.0 |
| zoom tiles, alone (new default)    |           725 ms |                              0.98 |
| zoom fine, alone                   |          1439 ms |                              0.63 |

In the smoke runs (all four detectors with their default zoom, synthetic camera) Lite2 took 788 ms p50 in Chrome and 896 ms in Edge. Memory did not change (31 MB for the MediaPipe workers): crops are released after each run. The face engines kept their rates.

**Notebooks.** There is no notebook rule, and MediaPipe's object detector cannot add one: its models are trained on COCO, which has no notebook or paper class. `BOOK_DETECTED` (COCO `book`, off by default) found the open book a reader held up (Lite2 0.76, 0.69 at half size) but not books lying on a desk. Notebooks and cheat sheets need a custom model. MediaPipe Model Maker can retrain EfficientDet-Lite on new classes from labelled photos, and the result would run in this same engine.

## Design

- **One detector feeds the rules; the others run for comparison.** Each model is its own engine instance (`objects-effdet-lite0`, `objects-effdet-lite2`, `objects-nanodet`, `objects-yolox`), so each one can be enabled, measured, and unloaded on its own. `objects.sourceEngineId` names the instance the rules read. The Objects panel switches it with one click, and active object violations then end with the new reason `source-changed`: a phone seen by one model says nothing about another model's frames.
- **Votes over samples, not a duration.** At 1 FPS a minimum duration says little. The rule keeps the last `window` samples and holds while at least `votes` of them reached `minScore` for the rule's COCO label. With the default 2 of 3, one false detection does not start a violation and one missed frame does not end it. A gap longer than `maxGapMs` (5 s) empties the window.
- **Two score limits.** Each engine reports detections from `minScore` 0.3 up, so the panel shows near misses. The rules apply their own limit (0.5). Scores are model outputs, not probabilities, and the four models are calibrated differently, so the limit must be checked after switching the source.
- **Same observations for every model** (`objectObservations.js`): one `OBJECTS` summary per frame (count, and the best score per label, which the rules read) and one `OBJECT` per detection (label, score, normalized box). The overlay draws the payload's boxes per enabled model in that model's colour.

## What was built

- **Engines and workers** (`src/engines/objects/`, `src/workers/objects-{mediapipe,onnx}.worker.js`):
  - `MediapipeObjectDetectorEngine` (kind `mp-object-detector`): MediaPipe Tasks `ObjectDetector` (VIDEO mode at first, IMAGE mode since the follow-up). It asks for every result above 0.1 and filters with the shared options. The CPU delegate is the default (see the GPU finding below).
  - `OnnxObjectDetectorEngine` (kind `ort-object-detector`): NanoDet-Plus or YOLOX-S on ONNX Runtime Web (WASM by default, WebGPU selectable). It letterboxes the frame on an `OffscreenCanvas`, normalizes the tensor, and decodes and runs NMS in JavaScript (`onnxDetectors.js`).
  - Pre- and postprocessing follow OpenCV Zoo's reference code. The details are in `docs/MODEL_LICENSES.md` ("NanoDet-Plus and YOLOX-S").
  - Both kinds check the pinned SHA-256 after loading the model, as the face engines do.
- **Defaults** (`src/config/detection.config.js`): all four at 1 FPS, priority 1, yielding to the face engines for up to 500 ms. At first, frames were scaled to 640 px wide during capture and only `objects-nanodet` was on, as the rules' source; since the follow-up, frames arrive at native resolution and `objects-effdet-lite2` with the zoom pass is the source. Reported classes: cell phone, book, laptop, tv, remote, keyboard, mouse, person.
- **Rules** (`ViolationEngine.observeObjects`):

| Rule             | Default                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `PHONE_DETECTED` | on; label `cell phone`, score ≥ 0.5 on 2 of the last 3 samples; severity high; cooldown 10 s |
| `BOOK_DETECTED`  | off; label `book`, same votes; severity low; cooldown 30 s                                   |

Each violation records its label and the highest score (`maxScore`). The log line reads, for example, "PHONE_DETECTED started (cell phone at score up to 0.9 for 0.0 s, severity high)". Unloading or restarting the source engine ends object violations with `data-gap`.

- **Main thread**: `ObjectMonitor` (`src/objects/objectMonitor.js`) keeps per-engine counts: frames, frames that reached each rule's limit, the highest score per label, and recent samples. It passes on the source engine's samples only.
- **UI**:
  - An Objects panel: one row per model with its state and provider, frames, frames at each rule's limit and the highest score, inference and engine p50/p95, init time, the last frame's detections, and a "Use" button that makes the model the rules' source.
  - An "Object boxes" switch over the camera preview.
  - Delegate or provider, reporting score, maximum detections, and NMS IoU in the engine cards.
  - In the Violations panel: the label, score limit, and votes/window of the object rules, and "cell phone 0.82" as the measure.

## Files

| Area             | New                                                                                                                                                                                                                   | Changed                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engines, workers | `src/engines/objects/{MediapipeObjectDetectorEngine,OnnxObjectDetectorEngine,onnxDetectors,objectObservations,objectDetectorConfig,cocoLabels,letterboxCanvas,tiles,cropFrame}.js`; `src/workers/objects-*.worker.js` | `src/engines/engineKinds.js`, `src/engines/face/mediapipeRuntime.js` (`createObjectDetector`), `src/workers/workerFactories.js`, `src/config/modelAssets.js` (pins)    |
| Objects, rules   | `src/objects/objectMonitor.js`                                                                                                                                                                                        | `src/pipeline/ViolationEngine.js` (object input, votes, `setObjectSource`), `TemporalCondition.js` (`source-changed`)                                                  |
| Config           | —                                                                                                                                                                                                                     | `src/config/schema.js` (`ObjectRuleSchema`, `objects`), `detection.config.js`                                                                                          |
| App, UI          | `src/ui/objects/{ObjectsPanel.jsx,objectEngines.js}`, `src/ui/camera/ObjectOverlay.jsx`                                                                                                                               | `src/app/LabController.js`, `routes/LiveTestingPage.jsx`, `src/ui/camera/CameraPanel.jsx`, `src/ui/detections/EngineCard.jsx`, `src/ui/violations/ViolationsPanel.jsx` |
| Tests            | `tests/engines/objects/{onnxDetectors,objectEngines,tiles}.test.js`, `tests/objects/objectMonitor.test.js`, `tests/pipeline/ObjectRules.test.js`                                                                      | `tests/app/LabController.test.js`, `scripts/browser-smoke.mjs` (scenario S)                                                                                            |
| Docs             | this report                                                                                                                                                                                                           | `README.md`, `docs/IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `TESTING_GUIDE.md`, `KNOWN_LIMITATIONS.md`, `MODEL_LICENSES.md`                                         |

## Dependencies and models

No package added: MediaPipe Tasks Vision 1.2.2 and ONNX Runtime Web 1.31.1 were already installed. Four model files, pinned by size and SHA-256 and downloaded by `npm run fetch-models` (details and sources in `docs/MODEL_LICENSES.md`):

| ID                     | Model                           | Input   | Size    | License                                            |
| ---------------------- | ------------------------------- | ------- | ------- | -------------------------------------------------- |
| `mp-effdet-lite0-int8` | EfficientDet-Lite0, int8        | 320×320 | 4.6 MB  | Apache-2.0 (Kaggle Models listing; automl LICENSE) |
| `mp-effdet-lite2-int8` | EfficientDet-Lite2, int8        | 448×448 | 7.5 MB  | Apache-2.0 (as above)                              |
| `ocv-nanodet-plus`     | NanoDet-Plus-m-1.5x, OpenCV Zoo | 416×416 | 3.8 MB  | Apache-2.0 (OpenCV Zoo directory)                  |
| `ocv-yolox-s`          | YOLOX-S, OpenCV Zoo             | 640×640 | 35.9 MB | Apache-2.0 (OpenCV Zoo directory)                  |

All four are trained on COCO 2017 (annotations CC BY 4.0, images under their Flickr terms). The EfficientDet license comes from the Kaggle Models API, which lists "Apache 2.0" for every EfficientDet instance. Google publishes no license statement that names the MediaPipe-hosted files themselves.

## Tests performed

- `npm run verify`: ESLint, Prettier, 420 unit tests in 38 files after the follow-up (407 in 37 before it; 364 in 33 after Phase 5), production build. The main chunk is 554 kB (537 kB after Phase 5), so Vite's "chunks larger than 500 kB" warning remains.
- **Mutation checks:** 39 small changes to the new logic (decoders, letterbox, NMS, box mapping, filters, both engines, monitor, votes, source switching, schema, controller wiring). The first run caught 35. The 4 survivors pointed at untested cases: odd letterbox padding, IoU exactly at the threshold, horizontal padding of portrait frames, and a score exactly at the rule limit. After adding those tests, all 39 were caught. The follow-up added 18 more for the zoom pass (tile layout and overlap, box mapping, merging, crop sizes and release in both engines); 17 were caught on the first run, and the survivor (merging of same-label boxes that overlap but neither contains the other) led to a stronger test. The list is in `docs/TESTING_GUIDE.md`.
- **Photo test.** 12 CC0 photos from Wikimedia Commons (Unsplash uploads) were fed to the real app as a 1280×720 camera (letterboxed), in headless Chrome 156. They were used locally and are not in the repository. All four models ran together at 1 FPS on 8–9 frames per photo. 8 photos contain a phone; 4 do not (a person reading a book, a café scene, a Kindle e-reader, a face portrait). The table shows the highest `cell phone` score per photo; "–" means no phone above the 0.3 reporting limit.

| Photo                                    | Phone | Lite0           | Lite2      | NanoDet    | YOLOX      |
| ---------------------------------------- | ----- | --------------- | ---------- | ---------- | ---------- |
| Phone lying on a book, dark room         | yes   | –               | 0.35       | –          | **0.69**   |
| Desk from above: laptop, books, phone    | yes   | –               | **0.50**   | **0.53**   | **0.87**   |
| Hand holding a phone, back side          | yes   | **0.59**        | **0.50**   | –          | **0.86**   |
| Phone seen edge-on, close-up, coffee cup | yes   | –               | –          | –          | –          |
| Hand holding a phone, screen to camera   | yes   | 0.48            | –          | **0.65**   | **0.93**   |
| Dark scene, phone edge-on in two hands   | yes   | –               | **0.63**   | –          | –          |
| Hand using a phone, screen lit           | yes   | **0.72**        | –          | **0.66**   | **0.92**   |
| Two hands holding a phone at a table     | yes   | – (remote 0.70) | **0.86**   | **0.56**   | **0.70**   |
| Person reading a book                    | no    | –               | –          | –          | –          |
| Café, person at a table                  | no    | –               | –          | –          | –          |
| Kindle e-reader                          | no    | –               | 0.67 (FP)  | –          | –          |
| Face portrait                            | no    | –               | –          | –          | –          |
| **Phone photos at ≥ 0.5 (rule limit)**   |       | **2 of 8**      | **4 of 8** | **4 of 8** | **6 of 8** |
| **False phones at ≥ 0.5**                |       | 0 of 4          | 1 of 4     | 0 of 4     | 0 of 4     |

- Each photo is a still image, so every frame of a photo scored the same. These are 12 samples, not 100: they show which model finds which kind of phone, not rates.
- Books (COCO `book`, at the 0.5 limit): only the open book held by the reader was found, by Lite0 (0.59) and Lite2 (0.76); YOLOX gave 0.47 and NanoDet nothing. The stack of books on the desk scored 0.34–0.42 in every model, and the book under the phone was not found. YOLOX called the open book a "laptop" (0.61).
- **Channel order (NanoDet, YOLOX).** OpenCV Zoo's demos convert frames to RGB before both models, but both were trained on OpenCV-read (BGR) images. The same photos were run in both orders. BGR found more phones at 0.5: NanoDet 4 of 8 against 3 in RGB, YOLOX 6 of 8 against 5 (RGB missed the phone on the book). The lab feeds BGR.
- **MediaPipe GPU delegate.** With the GPU delegate, the int8 EfficientDet files gave wrong results on every photo: Lite0 returned one box per frame such as "boat" at 0.16 across the top of the image, and Lite2 returned nothing above 0.3, not even the person in the portrait. On the CPU delegate the same files work. The float16 Lite0 file (downloaded for this test, not pinned) worked on the GPU delegate. Its results were close to int8 on the CPU: phones at ≥ 0.5 in 2 of 8 photos, the book at 0.51, no false phone. So the GPU delegate fails with the int8 files on this machine. The lab defaults to the CPU delegate, and the engine card marks the GPU option.
- **Smoke test** (headless, synthetic camera). The new scenario S loads all four models next to each other, with detection running. It checks:
  - results without failures (12 per model in 12 s);
  - the configured providers;
  - an `OBJECTS` summary on every result, with the rules reading NanoDet;
  - no `PHONE_DETECTED` or `BOOK_DETECTED` on the test pattern;
  - the `.tflite` and `.onnx` files loaded from the app's origin;
  - the panel's four rows and four overlays;
  - switching the rules' source from the panel and back.

  The object engines are off in A–R so those scenarios measure what they did before.

| Run                                                         | Browser           | Functional | Performance |
| ----------------------------------------------------------- | ----------------- | ---------- | ----------- |
| `reports/phase6-smoke-chrome-2026-11-11T13-27-18-919Z.json` | Chrome 156, build | 90/90      | 12/12       |
| `reports/phase6-smoke-msedge-2026-11-11T13-32-26-970Z.json` | Edge 157, build   | 90/90      | 12/12       |

One earlier Edge attempt (`…13-32-08-531Z.json`) stopped in scenario A because the synthetic camera ended its track, the known Chromium device issue.

After the follow-up (Lite2 with tiles as the default source; scenario S now unchecks and restores Lite2):

| Run                                                         | Browser           | Functional | Performance |
| ----------------------------------------------------------- | ----------------- | ---------- | ----------- |
| `reports/phase6-smoke-chrome-2026-11-12T05-45-36-416Z.json` | Chrome 156, build | 90/90      | 12/12       |
| `reports/phase6-smoke-msedge-2026-11-12T05-50-49-404Z.json` | Edge 157, build   | 90/90      | 12/12       |

## Measured results

**Each model alone** (Chrome 156 headless, i5-12450H with Intel UHD, the "two hands at a table" photo as the camera). These runs used a 2 FPS target for more samples: 15 s windows, 30 frames, 21 for YOLOX on WASM, which could not keep up. Memory is the worker's JavaScript and WASM heap from `measureUserAgentSpecificMemory` and does not include GPU memory.

| Model, provider                 | Init (worker → ready)     | Inference p50 / p95 | Engine total p50 / p95 | Worker memory | Download |
| ------------------------------- | ------------------------- | ------------------: | ---------------------: | ------------: | -------: |
| Lite0 int8, CPU (default)       | 0.6 s                     |          73 / 96 ms |             73 / 96 ms |       12.7 MB |   4.6 MB |
| Lite0 int8, GPU                 | 4.5 s (3.8 s warm-up)     |        101 / 108 ms |          wrong results |       12.9 MB |          |
| Lite2 int8, CPU (default)       | 0.9 s                     |        202 / 293 ms |           202 / 293 ms |       18.3 MB |   7.5 MB |
| Lite2 int8, GPU                 | 1.9 s                     |        199 / 212 ms |          wrong results |       18.4 MB |          |
| NanoDet, WASM (default)         | 1.0 s                     |          25 / 27 ms |             39 / 43 ms |       34.7 MB |   3.8 MB |
| NanoDet, WebGPU                 | 2.5 s (1.5 s warm-up)     |          64 / 89 ms |            78 / 109 ms |       29.2 MB |          |
| YOLOX, WASM (default)           | 6.1 s (2.1 s model fetch) |        603 / 799 ms |           628 / 821 ms |      122.9 MB |  35.9 MB |
| YOLOX, WebGPU                   | 7.4 s (4.9 s warm-up)     |        216 / 231 ms |           235 / 249 ms |      120.4 MB |          |
| Lite0 float16, GPU (not pinned) | 5.0 s (4.2 s warm-up)     |         80 / 108 ms |            80 / 108 ms |       18.0 MB |   7.3 MB |
| Lite0 float16, CPU (not pinned) | 0.9 s                     |        115 / 137 ms |           115 / 137 ms |       17.8 MB |          |

- NanoDet's engine total includes 13 ms of preprocessing: the letterbox drawn on the canvas and read back. YOLOX spends 18–21 ms there.

**All four together** (smoke scenario S, 1 FPS each, synthetic camera, machine-wide CPU load 58–59%). Values are p50; engine total p95 in brackets.

| Model   | Chrome inference | Edge inference | Chrome engine total | Edge engine total |
| ------- | ---------------: | -------------: | ------------------: | ----------------: |
| Lite0   |           155 ms |         158 ms |        156 (173) ms |      158 (169) ms |
| Lite2   |           372 ms |         367 ms |        372 (473) ms |      368 (390) ms |
| NanoDet |            50 ms |          52 ms |         98 (119) ms |      104 (111) ms |
| YOLOX   |           505 ms |         500 ms |        555 (588) ms |      548 (599) ms |

Memory with all four loaded: 30.9 MB for the two MediaPipe instances (same worker script, reported together) and 156–158 MB for NanoDet plus YOLOX.

**What the numbers show:**

- **YOLOX-S found the most phones** (6 of 8, no false phone). It is also the most expensive model: 0.6 s per frame on WASM (about 60% of one 1 FPS slot), 123 MB, a 36 MB download, and 6 s to load. On WebGPU it took 235 ms, the only model here that was faster on this laptop's GPU than on WASM.
- **NanoDet-Plus was the first default source.** It found 4 of 8 phones with no false phone, at 39 ms per frame on WASM, with a 3.8 MB download and a 1 s load. The live session showed that this was not enough for phones at arm's length; see the follow-up, which made Lite2 with the zoom pass the default.
- **EfficientDet-Lite2** also found 4 of 8, a different four, but at 5 times NanoDet's cost and with a false phone on the Kindle. **Lite0** found 2 of 8 and called a phone a "remote".
- Every model missed the phone seen edge-on. A phone held flat toward the camera, or lying on a desk, is found far more often than one seen from the side.

## Exit criteria

| Criterion (from `docs/IMPLEMENTATION_PLAN.md`)                                                           | Status                                                                                             |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Compare EfficientDet-Lite0/Lite2 (MediaPipe) with NanoDet-Plus and YOLOX-S (ONNX) at 1 FPS, low priority | Done; all four selectable, comparable side by side                                                 |
| `PHONE_DETECTED` (2 of 3), configurable score thresholds                                                 | Done                                                                                               |
| False-positive review on ordinary desk objects                                                           | **Partly**: 4 photos without a phone (no false phone except Lite2 on a Kindle). Real desks pending |
| Notebook detection evaluated and documented with its limitations                                         | Done as far as COCO `book` goes: `BOOK_DETECTED` off by default; see limitations                   |
| Per-model latency and memory                                                                             | Done (above)                                                                                       |
| Precision and recall on annotated recordings                                                             | **Open**: needs Phase 7 recordings                                                                 |

## Limitations

The main ones (full list in `docs/KNOWN_LIMITATIONS.md`):

- Photos and composed scenes, not webcam sessions. The follow-up's scenes imitate a phone at arm's length, but a real candidate's hand, webcam noise, and motion are unmeasured, and so are false phones on real desks (dark remotes, calculators, power banks, wallets, a mouse).
- COCO `book` is not a notebook class. Loose paper, notes, and an open notebook flat on a desk are not what it was trained on; even the books in the photos scored below 0.5 except the one held up. `BOOK_DETECTED` stays off.
- Phones seen edge-on or partly hidden by a hand are often missed; the zoom pass helps with small phones, not with these. A phone below the camera's view is invisible to any model.
- Lite2 calls a Kindle e-reader a phone (0.82). Tablets and e-readers on a desk will likely raise `PHONE_DETECTED`.
- The zoom pass makes Lite2 cost 0.7–0.9 s of CPU per frame (three runs) next to the face engines. On slower laptops it may run below 1 FPS; the zoom selector in the engine card trades this against small-phone recall.
- Scores are not calibrated across models. The 0.5 limit was kept for Lite2 with the zoom pass, which scored found phones 0.52–0.89; check it after switching the source.
- MediaPipe's GPU delegate gave wrong results with the int8 files on this machine; only the CPU delegate is usable for them. The float16 files work on the GPU but are not pinned.
- Detection runs at 1 FPS, so a phone shown for less than about 2 s is missed by design (2 of 3 votes).

## Next step

1. Run the Phase 6 checklist in `docs/TESTING_GUIDE.md` with a real webcam: phone held up, on the desk, face down, in the lap; a book and a notebook; ordinary desk objects for false phones. Enable all four models and use the Objects panel to compare them; export a report.
2. Repeat the phone test that failed, with the new default (Lite2, zoom "Tiles"): phone held up at arm's length for 30 s, then at the edge of the view. `PHONE_DETECTED` should start within about 2–3 s. If it still does not, export the report right after: the Objects panel and the report show each frame's phone score, which tells a model limit from a bug.
3. Notebooks need a custom model (MediaPipe Model Maker, labelled photos of notebooks and paper on desks). Decide whether to collect such photos.
4. After your approval: Phase 7 (recording, replay, annotation), so that every rule, including `PHONE_DETECTED`, gets measured precision and recall.
