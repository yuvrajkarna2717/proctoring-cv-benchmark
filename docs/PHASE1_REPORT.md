# Phase 1 report — Foundation

Date: 2026-11-09, updated 2026-11-10 after the first real-webcam sessions (see "Real-webcam sessions" and "Fixes after real-webcam testing"). Deliverable: stable webcam feed and a working inference architecture, verified with unit tests and a browser smoke test.

## What was built

- Camera capture with consent gate, device selection, ideal-constraint negotiation, stable error codes, and verified track release (`src/capture/CameraManager.js`).
- Frame clock on `requestVideoFrameCallback` with camera capture timestamps, `requestAnimationFrame` fallback, and a stall watchdog (`src/capture/VideoFrameSource.js`).
- Per-engine scheduling without queues: due-time accumulator, backpressure with skipped-slot counting, stale-frame drop in the worker, priority yielding with a starvation guard (`src/capture/FrameScheduler.js`, `src/pipeline/DetectionPipeline.js`).
- Engine contract and lifecycle base class with preprocess/inference/postprocess timing; model-free diagnostic engine (`src/engines/`).
- Worker RPC: one dedicated module worker per engine instance, transferred `ImageBitmap`s, request timeouts, hang detection, restart, error serialization (`src/workers/`).
- Performance monitor (latency series, percentiles, FPS, drops, failures, init breakdown, main-thread lag, timestamped main-thread stalls, page visibility and focus changes, Long Tasks, memory) and device profiler (`src/benchmark/`).
- Minimal Bootstrap UI: consent, camera, engine controls, metrics tables, runtime health, event log, environment page, JSON report export (`src/app/`, `src/ui/`).
- Cross-origin isolation headers, production CSP, Zod configuration schemas.

## Files

| Area       | Files                                                                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project    | `package.json`, `vite.config.js`, `vitest.config.js`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `index.html`                                                                      |
| Config     | `src/config/schema.js`, `src/config/detection.config.js`                                                                                                                                                         |
| Capture    | `src/capture/CameraManager.js`, `VideoFrameSource.js`, `FrameScheduler.js`                                                                                                                                       |
| Pipeline   | `src/pipeline/DetectionPipeline.js`                                                                                                                                                                              |
| Engines    | `src/engines/EngineContract.js`, `BaseDetectionEngine.js`, `engineKinds.js`, `diagnostic/DiagnosticEngine.js`, `diagnostic/diagnosticConfig.js`                                                                  |
| Workers    | `src/workers/protocol.js`, `engineHost.js`, `WorkerEngineClient.js`, `workerFactories.js`, `diagnostic.worker.js`                                                                                                |
| Benchmark  | `src/benchmark/PerformanceMonitor.js`, `stats.js`, `DeviceProfiler.js`                                                                                                                                           |
| Utilities  | `src/utils/clock.js`, `errors.js`, `validation.js`, `zod.js`                                                                                                                                                     |
| App and UI | `src/main.jsx`, `src/app/App.jsx`, `LabController.js`, `app.css`, `routes/LiveTestingPage.jsx`, `routes/EnvironmentPage.jsx`, `src/ui/camera/*`, `src/ui/detections/*`, `src/ui/benchmarks/*`, `src/ui/common/*` |
| Tests      | `tests/**` (11 files), `scripts/browser-smoke.mjs`                                                                                                                                                               |
| Docs       | `README.md`, `docs/IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `MODEL_LICENSES.md`, `TESTING_GUIDE.md`, `KNOWN_LIMITATIONS.md`, this report                                                                      |

## Dependencies added

| Package                                                                                       | Version                                | Kind    | Why                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------- | ------- | ------------------------------------------------------------------- |
| `react`, `react-dom`                                                                          | 19.3.1                                 | runtime | UI                                                                  |
| `bootstrap`, `react-bootstrap`                                                                | 5.3.8, 2.10.10                         | runtime | Requested UI kit                                                    |
| `zod`                                                                                         | 4.6.7                                  | runtime | Configuration validation, used in jitless mode                      |
| `vite`, `@vitejs/plugin-react`                                                                | 8.3.6, 6.3.0                           | dev     | Dev server and build                                                |
| `eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals` | 10.14.0, 10.0.1, 7.1.1, 0.5.7, 17.14.0 | dev     | Linting                                                             |
| `prettier`                                                                                    | 3.9.10                                 | dev     | Formatting                                                          |
| `vitest`                                                                                      | 5.1.0                                  | dev     | Unit tests                                                          |
| `playwright-core`                                                                             | 1.65.0                                 | dev     | Smoke test driving the installed Chrome/Edge; downloads no browsers |
| `@types/react`, `@types/react-dom`                                                            | 19.3.0                                 | dev     | Editor IntelliSense for JSX only; no TypeScript files exist         |

`@mediapipe/tasks-vision` (Phase 2) and `onnxruntime-web` (Phase 3) are not installed yet.

## Models

None in Phase 1. The artifacts selected for Phases 2–6, their sources, sizes, and license findings are in `docs/MODEL_LICENSES.md`. Main findings: MediaPipe model cards state Apache-2.0 but exclude surveillance and life-critical use from their intended scope; SFace weights are Apache-2.0 but their training data is undocumented, so SFace is cleared for POC benchmarking only.

## Tests performed

- `npm run verify`: ESLint (0 problems), Prettier check, 129 unit tests in 11 files (all pass; 115 at the end of Phase 1, 14 added with the fixes), production build.
- Mutation checks: replacing the scheduler's due-time rule with "now − last ≥ interval" fails the 7 FPS rate test (7.5 measured); removing the camera-startup race guards fails both race tests. For the fixes, each of these makes at least one test fail: removing the Firefox frame-clock fallback, counting hidden-page gaps as stalls, ignoring the window focus state, ignoring `document.hasFocus()`, removing the controller's subscription to monitor events, removing the monitor's measurement-window check, and not passing the dispatch time from the pipeline.
- Browser smoke test (`npm run smoke`), headless, Chromium synthetic camera at 1280×720, 20 fps. End of Phase 1: 24/24 functional and 5/5 performance checks on Chrome 156.0.8078.80 and Edge 157.0.4341.42 (`reports/phase1-smoke-chrome-2026-11-09T11-16-38-920Z.json`, `reports/phase1-smoke-msedge-2026-11-09T11-17-57-630Z.json`). After the fixes, with the new stall scenario H and window-accounting checks: 31/31 functional and 5/5 performance checks on both (`reports/phase1-smoke-chrome-2026-11-10T06-19-23-187Z.json`, `reports/phase1-smoke-msedge-2026-11-10T06-22-29-054Z.json`). Two other Edge runs that day failed because Edge's synthetic camera ended its track (see `docs/TESTING_GUIDE.md`).
- The same smoke test against the Vite dev server (`--dev`, Chrome): 24/24 functional checks with 3 s windows at the end of Phase 1 (`reports/phase1-smoke-chrome-2026-11-09T14-30-33-846Z.json`), and 31/31 functional and 5/5 performance checks with 8 s windows after the fixes (`reports/phase1-smoke-chrome-2026-11-10T06-20-55-059Z.json`).
- Real webcam, headed: two Chrome 156 sessions and two Firefox 157 sessions, run by the user, plus a Firefox run with two tab switches. The second pair and the tab-switch run used the fixed production build (see "Real-webcam sessions" and "Real-webcam sessions after the fixes").
- Not verified with a real webcam: a main-thread stall on a visible page (none occurred; smoke scenario H covers it in Chromium) and the frame-clock fallback on a visible page (in Firefox it ran only while the tab was hidden). Also not verified: Safari, other cameras and machines. See the manual checklist in `docs/TESTING_GUIDE.md`.

## Measured results

Host: i5-12450H (12 threads), 16 GB, Intel UHD, Windows 11. Machine-wide CPU load during windows A–C was 32–48% (other applications were running). 8 s windows, 40 samples per series in A.

**A. Pipeline overhead** — `probe-high` at 5 FPS, native 1280×720 frames. Values in ms, mean / p50 / p95 / p99.

| Series                                                     | Chrome 156                   | Edge 157                    |
| ---------------------------------------------------------- | ---------------------------- | --------------------------- |
| Engine time in worker (downsample + `getImageData` + luma) | 8.33 / 7.77 / 11.69 / 18.50  | 7.49 / 6.72 / 9.57 / 17.62  |
| Capture (`createImageBitmap`, main thread)                 | 0.46 / 0.38 / 0.91 / 2.04    | 0.36 / 0.31 / 0.56 / 1.09   |
| Transport (both `postMessage` hops + queueing)             | 0.49 / 0.46 / 0.74 / 0.91    | 0.46 / 0.39 / 0.79 / 1.01   |
| Frame age when the worker starts                           | 2.36 / 1.71 / 7.73 / 10.31   | 1.64 / 1.52 / 2.15 / 5.12   |
| Camera capture → result on main thread                     | 10.94 / 9.84 / 15.67 / 26.91 | 9.37 / 8.43 / 11.50 / 22.74 |
| Average FPS (target 5)                                     | 4.99                         | 5.00                        |

**B. Backpressure** — 450 ms of blocking work per frame in the worker, 5 FPS target.

| Metric                                           | Chrome 156      | Edge 157         |
| ------------------------------------------------ | --------------- | ---------------- |
| Average FPS                                      | 2.00            | 1.99             |
| Sampling slots skipped (busy) in 8 s             | 16              | 16               |
| Frames dispatched but not settled at the end     | 1 (in flight)   | 1 (in flight)    |
| Frame age when the worker starts, p95            | 6.76 ms         | 1.73 ms          |
| Preview frame tick rate (camera delivers 20 fps) | 19.98 fps       | 19.95 fps        |
| Main-thread event-loop lag p95 / max             | 9.83 / 11.76 ms | 10.08 / 15.11 ms |
| Long tasks                                       | 0               | 0                |

**C. Two engines** — adds `probe-low` (1 FPS, priority 1, 250 ms blocking work, 640 px input).

| Metric                                           | Chrome 156             | Edge 157               |
| ------------------------------------------------ | ---------------------- | ---------------------- |
| `probe-high` average FPS / engine mean / p95     | 4.99 / 7.65 / 10.62 ms | 4.99 / 7.49 / 10.62 ms |
| `probe-low` average FPS (target 1)               | 1.00                   | 1.00                   |
| `probe-low` capture at 640 px, mean              | 0.42 ms                | 0.41 ms                |
| Memory, total (`measureUserAgentSpecificMemory`) | 7.28 MB                | 7.33 MB                |
| — page / two workers                             | 4.74 / 1.56 MB         | 4.91 / 1.56 MB         |
| Memory measurement duration                      | 14.0 s                 | 12.0 s                 |

**Initialization**

| Metric                                 | Chrome 156 | Edge 157 |
| -------------------------------------- | ---------- | -------- |
| Worker spawn → engine ready            | 51.9 ms    | 46.2 ms  |
| — engine module load inside the worker | 21.8 ms    | 19.6 ms  |
| Worker restart → ready                 | 35.8 ms    | 43.7 ms  |

What the numbers show:

- The architecture adds about 1 ms per frame outside the engine (capture 0.4 ms, transport 0.5 ms). The main-thread cost per dispatched frame is the `createImageBitmap` call.
- A worker saturated with blocking work does not affect the preview: the frame tick rate stayed at the camera's 20 fps and event-loop lag p95 stayed near 10 ms.
- Slow engines lose sampling slots instead of queueing: the rate fell to 2 FPS, 16 slots were skipped, and frames reaching the worker stayed fresh (p95 frame age under 7 ms).
- On this 12-thread machine a 1 FPS engine with 250 ms of work did not lower the 5 FPS engine's rate. Real models also use the GPU and multiple WASM threads; contention must be measured again in Phases 2–6.
- Reading pixels back from a 720p `ImageBitmap` on the CPU costs about 7–8 ms in the worker. CPU-side model preprocessing will pay this; GPU paths should be compared.

## Problems found by testing and fixed

| Problem                                                                                                                                 | Found by                                      | Fix                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A yielding low-priority engine could be starved when the high-priority engine was due on most frames                                    | Smoke test (0 results for `probe-low`)        | `maxYieldMs` starvation guard in the scheduler                                                                               |
| If the camera track ended during startup, the app reported an active camera and engines processed 2×2 black frames from the dead stream | Smoke test on Edge                            | Camera session token, `TRACK_ENDED` error, decoded-frame check in the frame clock                                            |
| Frame callbacks stopped for the rest of one run while frames kept decoding                                                              | Smoke test on Chrome (heavily loaded machine) | Frame clock watchdog with timer fallback and stall counters                                                                  |
| Zod's eval probe raised a CSP violation in the production build                                                                         | Smoke test CSP listener                       | Zod `jitless` mode; ESLint rule against importing `zod` directly                                                             |
| A frame in flight during a metrics reset was counted in the new window                                                                  | Smoke test counters                           | Excluded from the scheduler counters; the monitor still recorded it until 2026-11-10 (see "Fixes after real-webcam testing") |
| Favicon request returned 404                                                                                                            | Smoke test request listener                   | Empty data-URL icon                                                                                                          |

Reports from the failing runs are kept as evidence (they were produced by earlier revisions of the code): `reports/phase1-smoke-chrome-2026-11-09T09-17-46-284Z.json` (heavily loaded machine: 131 ms mean engine time, 6 fps frame callbacks), `reports/phase1-smoke-chrome-2026-11-09T09-47-30-764Z.json` (frame callbacks stopped), `reports/phase1-smoke-msedge-2026-11-09T10-55-53-534Z.json` (track ended during startup).

## Real-webcam sessions

Run by the user on 2026-11-10 on the same laptop, headed, with the built-in HP Wide Vision HD Camera at 1280×720 and 30 fps, default configuration, `probe-low` enabled after detection started. The exported reports (`cv-lab-report-2026-11-10T04-20-31-321Z.json` for Chrome, `cv-lab-report-2026-11-10T04-33-11-033Z.json` for Firefox) stayed in the user's Downloads folder. They predate the fixes below; the rates in the second and third rows are recomputed from their timestamps.

| Metric                                                          | Chrome 156, dev server       | Firefox 157, production build |
| --------------------------------------------------------------- | ---------------------------- | ----------------------------- |
| Detection running                                               | 151.8 s                      | 42.9 s                        |
| `probe-high`: results, rate from detection start to last result | 759, 5.01 FPS                | 215, 5.02 FPS                 |
| `probe-low`: results, rate from engine ready to last result     | 135, 1.01 FPS                | 41, 1.02 FPS                  |
| Avg FPS as exported (old definition), high / low                | 4.83 / 0.86                  | 4.35 / 0.83                   |
| `probe-high` engine time, mean / p95                            | 4.85 / 6.39 ms               | 0.29 / 0.58 ms                |
| `probe-high` capture at 1280×720, mean / p95                    | 0.30 / 0.45 ms               | 1.62 / 3.11 ms                |
| `probe-low` capture with resize to 640 px, mean                 | 0.33 ms                      | 4.51 ms                       |
| `probe-high` transport, mean                                    | 0.36 ms                      | 0.32 ms                       |
| `probe-high` camera capture → result, mean / p95                | 10.14 / 17.23 ms             | 4.28 / 9.73 ms                |
| Frame callbacks / frames presented                              | 4640 / 4640                  | 1308 / 1358                   |
| Callbacks with camera `captureTime`                             | all                          | all                           |
| Frame-clock stalls                                              | 0                            | 0                             |
| Decoded / dropped video frames (since camera start)             | 5263 / 95                    | reported as 0 / 0             |
| Event-loop lag p95 / max (samples)                              | 10.87 / 25.52 ms (1571)      | 3.98 / 973 ms (473)           |
| Long tasks                                                      | 0                            | API missing                   |
| Memory                                                          | 41.8 MB (development build)  | not measured (API missing)    |
| `probe-high` worker spawn → ready                               | 112.2 ms (development build) | 34.0 ms                       |

What the sessions show:

- With a real 30 fps camera both browsers held 5 and 1 FPS on both engines. The exported Avg FPS was lower only because it divided by the time since the reset, which includes the 17.5 s (Chrome) and 2.5 s (Firefox) before `probe-low` was enabled and the time after detection stopped.
- Chrome showed no missed frame callbacks and no frame-clock stalls in 2.5 minutes, most of it with both engines running; the largest event-loop delay was 25.5 ms.
- Firefox moves the pixel copy into `createImageBitmap` on the main thread (1.62 ms per 720p frame, 4.51 ms with the resize), while Chrome pays for it in the worker's readback. Real engines will show the same split.
- Firefox gave no frame callback for 50 of 1358 presented frames (3.7%) and reported 0 decoded frames for the camera stream. The second point exposed a bug in the frame-clock fallback (below).
- One 973 ms event-loop gap in Firefox could not be explained from the report: Firefox has no Long Tasks API, and neither stalls nor page visibility were logged.
- The Chrome session's 41.8 MB reflects the dev server: the Chrome smoke test measured 41.9 MB against the dev server and 7.37 MB against the production build. Memory must be measured on production builds.

## Fixes after real-webcam testing

| Problem                                                                                                                                                                                                                                                                                      | Found in                                                                                                                                                        | Fix                                                                                                                                                                                                                                                                                              | Verified by                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| The frame-clock fallback timer emitted a tick only when the decoded-frame counter advanced. Firefox reports 0 for camera streams, so after an rVFC stall Firefox would have received no frame ticks at all                                                                                   | Firefox session (`playbackQuality` 0 / 0)                                                                                                                       | The counter is trusted only after it has counted a frame; until then a change of `currentTime` marks a new frame. Unreported counters are exported as `null` and shown as "not reported by this browser"                                                                                         | 2 unit tests; not yet re-tested in Firefox                                                  |
| Avg FPS = results ÷ time since the metrics reset, which counted time before an engine's first result and after detection stopped (4.35 instead of 5.02 FPS in Firefox)                                                                                                                       | Both sessions                                                                                                                                                   | Avg FPS = (results − 1) ÷ (last result − first result); `firstResultAt` is exported                                                                                                                                                                                                              | 2 unit tests; smoke checks A and C (5.01, 5.01 and 1.00 FPS in Chrome and Edge)             |
| Main-thread gaps had no timestamp and no page context, and lag samples taken while the page was hidden (timers throttled) counted as lag                                                                                                                                                     | Firefox session (973 ms gap)                                                                                                                                    | Probes at least `stallThresholdMs` (new setting, default 250 ms) late are recorded as stalls with start and end time and focus state and logged as warnings; visibility and focus changes are logged and counted; hidden-page samples and gaps are excluded from lag statistics and stall counts | 7 monitor tests and 1 controller test; smoke scenario H in Chrome, Edge, and the dev server |
| A frame in flight when metrics were reset still had its result recorded in the new window, although the scheduler had excluded it. With the new Avg FPS this added a result and a short first interval: 5.11–5.13 FPS instead of 5.0 in 8 s smoke windows, with more results than dispatches | Smoke runs after the Avg FPS fix (for example window A of `reports/phase1-smoke-chrome-2026-11-10T06-06-16-705Z.json`: 41 outcomes for 40 dispatches, 5.12 FPS) | The pipeline passes each frame's dispatch time to the monitor, and the monitor ignores results, drops, and failures of frames dispatched before the current window                                                                                                                               | 1 monitor test and 1 pipeline test; new smoke checks in A and C (results ≤ dispatches)      |

The last problem also affected Phase 1 runs in which a frame happened to be in flight at a reset (for example 41 recorded outcomes for 40 dispatches in window A of `reports/phase1-smoke-chrome-2026-11-09T09-47-30-764Z.json`). The two runs behind the Phase 1 results above had no such frame in windows A–D (outcomes never exceeded dispatches), so those results are unaffected. In the real-webcam sessions it changes at most one result in 759 or 135.

Smoke scenario H blocks the main thread for 700 ms. Chrome recorded a 636.0 ms stall that started 65 ms after the block began (when the probe was due) and ended 1.2 ms after it; Edge recorded 681.6 ms starting 19 ms in. Both logged "Main thread unavailable for … ms", showed the stall in the runtime health panel, and counted 13 missed frame callbacks in the scenario window (the block spans 14 frames at 20 fps). Frame ticks and results resumed within a second, on `requestVideoFrameCallback`. Chromium's Long Tasks observer recorded no entry for the block, which runs as a DevTools `evaluate` call; the event-loop probe recorded it in every run.

Other numbers from the final post-fix smoke runs (Chrome / Edge): average FPS 5.01 / 5.01 in A with 40 results for 40 dispatches, engine mean 6.96 / 7.01 ms, camera capture → result p95 11.17 / 10.72 ms; 2.04 / 2.01 FPS under backpressure with 16 skipped slots each; 5.01 and 1.00 FPS with two engines; memory 7.37 / 7.41 MB. Machine CPU load during window A was 18% in the Chrome run and 20% in the Edge run.

## Real-webcam sessions after the fixes

Run by the user on 2026-11-10 with the fixed production build, same laptop and camera, both engines enabled and both workers restarted before detection started. Reports: `cv-lab-report-2026-11-10T06-37-22-787Z.json` (Chrome) and `cv-lab-report-2026-11-10T06-41-46-668Z.json` (Firefox), in the user's Downloads folder.

| Metric                                                 | Chrome 156             | Firefox 157                  |
| ------------------------------------------------------ | ---------------------- | ---------------------------- |
| Detection running                                      | 103.4 s                | 163.3 s                      |
| `probe-high`: results / dispatches, Avg FPS            | 517 / 517, 5.00        | 817 / 817, 5.00              |
| `probe-low`: results / dispatches, Avg FPS             | 104 / 104, 1.00        | 164 / 164, 1.00              |
| Avg FPS with the old formula, high / low               | 4.94 / 0.99            | 4.96 / 1.00                  |
| `probe-high` engine time, mean / p95                   | 4.56 / 5.47 ms         | 0.25 / 0.50 ms               |
| `probe-high` capture at 1280×720, mean / p95           | 0.24 / 0.37 ms         | 1.28 / 1.82 ms               |
| `probe-low` capture with resize to 640 px, mean        | 0.28 ms                | 4.33 ms                      |
| `probe-high` camera capture → result, mean / p95       | 8.79 / 14.70 ms        | 2.84 / 5.85 ms               |
| Frames presented per second (camera set to 30 fps)     | 29.9                   | 28.1                         |
| Frame callbacks / frames presented                     | 3130 / 3130            | 4622 / 4622                  |
| Frame-clock stalls                                     | 0                      | 0                            |
| Decoded / dropped video frames (since camera start)    | 3725 / 0               | not reported by this browser |
| Event-loop lag p95 / max (samples)                     | 5.73 / 15.03 ms (1046) | 3.74 / 19.02 ms (1633)       |
| Main-thread stalls / page-visibility and focus changes | 0 / 0                  | 0 / 0                        |
| `probe-high` worker restart → ready                    | 21.3 ms                | 30.9 ms                      |

What these sessions show:

- The changed metrics behave as intended in real browsers: Avg FPS was 5.00 and 1.00 on both, every engine had as many results as dispatches, and Firefox's dropped-frame cell read "not reported by this browser". The old formula would have been close this time (4.94 and 4.96) because `probe-low` was enabled before detection started and the report was exported 1.2–1.5 s after detection stopped. Effective FPS at export (3.8 and 3.6) is lower for the same reason: it covers the last 5 s, which include the stop.
- Firefox ran the frame callback for every presented frame (4622 of 4622 in 163 s), and no event-loop delay exceeded 19 ms. The 50 missed callbacks of the first Firefox session are therefore not a steady Firefox property; the tab-switch check below points to a short hidden period. The 40 ms callback limit reported in Mozilla bug 1935256 did not appear; Firefox ran 28 callbacks per second.
- No stall, tab switch, or focus change happened in either session, so the new stall and page-event logging and the frame-clock fallback were not exercised here (see the tab-switch check below). The 973 ms gap did not recur.
- The browser split of pixel cost held: Firefox spent 1.28 ms in capture and 0.25 ms in the engine, Chrome 0.24 ms and 4.56 ms.
- Chrome's production build dropped 0 of 3725 frames; the earlier dev-server session dropped 95 of 5263. One session each, so this is not a conclusion about dev versus production.
- Firefox reported the camera track's `resizeMode` as `crop-and-scale` and presented 28.1 frames per second; Chrome reported `none` and 29.9.
- In both sessions `probe-high` was set to yield to higher-priority engines. That setting has no effect on the highest-priority engine (`skippedYield` stayed 0).

### Tab-switch check in Firefox

The user ran detection in Firefox for 82 s on the fixed production build and switched to another tab twice (`cv-lab-report-2026-11-10T06-53-16-517Z.json`).

- Both switches were logged with their times. The page was hidden from 23.5 s to 29.9 s and from 57.2 s to 69.3 s after detection started (18.5 s in total), and "Window lost focus" and "Window regained focus" were logged around each switch.
- 21 event-loop samples taken while the page was hidden were excluded. The other 648 samples had a largest delay of 19 ms, and no stall was recorded. Without the exclusion those samples would have been delays of roughly 900 ms each, since Firefox runs background-tab timers about once per second, and each would have counted as a stall.
- Firefox kept running the frame callback about once per second while the page was hidden, so about 15 frames reached the engines in those 18.5 s. Average FPS over the run was therefore 4.05 and 0.93, which the "Page hidden" log message warns about.
- The frame-clock watchdog counted 7 stalls during the hidden periods and switched to the backup timer each time. Firefox's next callback, about a second later, usually ended the stall before the backup timer fired (background-tab timers also run about once per second), so the backup timer produced 1 frame. The Firefox `currentTime` path ran without errors, but a long stall on a visible page, the case it exists for, has not been observed in Firefox.
- "Missed frame callbacks" rose to 499, about the number of frames Firefox presented while the page was hidden. This counter and the frame-clock stall counter still include hidden periods, unlike the event-loop statistics.
- The first Firefox session fits this pattern: its single 973 ms delay matches Firefox's once-per-second timers for background tabs, and its 50 missed callbacks are about 1.8 s of frames. That build did not log visibility, so a short hidden period is the likely explanation, not a confirmed one.

## Known limitations

See `docs/KNOWN_LIMITATIONS.md`. The most important for interpreting this report: no models yet; automated numbers come from headless synthetic-camera runs on one laptop, real-webcam data from five manual runs on the same laptop; machine load changes results heavily; a main-thread stall and the frame-clock fallback on a visible page have not been observed with a real webcam; hidden periods still count toward missed frame callbacks and frame-clock stalls; Safari is untested.

## Next step: Phase 2

Open measurement item: hidden periods still count toward "missed frame callbacks" and frame-clock stalls (see the tab-switch check). Counting them separately, as the event-loop statistics already do, is a small change in `VideoFrameSource` and the runtime health panel.

1. Add `@mediapipe/tasks-vision` 1.2.2, self-host its WASM, and add `scripts/fetch-models.mjs` with pinned SHA-256 for `face_landmarker.task`.
2. Implement `FaceLandmarkerEngine` in a `face.worker.js` (VIDEO mode, `numFaces` 3), measuring GPU and CPU delegates and transferring landmarks as `Float32Array`s.
3. Draw boxes and landmarks on a canvas overlay.
4. Build the temporal evaluation layer and violation engine with `NO_FACE` and `MULTIPLE_FACES`, configurable durations, hysteresis, cooldowns, and unit tests.
5. Run the scenario checklist on a real webcam and record results.
