# Proctoring CV Lab

Browser-only research lab for measuring whether open-source computer vision models can replace or reduce cloud vision APIs (AWS Rekognition) in online interview and exam proctoring. It is a benchmarking tool, not a production proctoring SDK. All inference runs locally in the browser; nothing is uploaded.

Status: **Phase 6 (object detection) implemented; real-webcam checks of Phases 3, 5, and 6 pending.**

- Phase 2: MediaPipe Face Landmarker in a worker (GPU or CPU delegate), face overlay, and `NO_FACE` and `MULTIPLE_FACES` rules with configurable durations, hysteresis, cooldowns, and severity.
- Phase 3: YuNet face detection and SFace embeddings on ONNX Runtime Web (WASM by default, WebGPU selectable) in a second worker; enrollment of a reference face with a quality gate; live similarity to the reference and a `FACE_MISMATCH` rule; a calibration tool for FAR, FRR, EER, and ROC on your own captures.
- Phase 4: head pose, gaze (head and eyes), and eye state from the face landmarker, measured against each person's own screen area (guided calibration or a learned baseline); rules `GAZE_AWAY`, `HEAD_TURNED`, `EYES_CLOSED` with lenient, balanced, and strict presets.
- Phase 5: a model-free image-quality engine (lighting, contrast, sharpness of the frame and the face region, face size) at 1 FPS; rule `LIGHTING_ISSUE`, and image problems (blur, small face) noted on other violations.
- Phase 6: four COCO object detectors at 1 FPS, comparable side by side (EfficientDet-Lite0 and Lite2 on MediaPipe, NanoDet-Plus and YOLOX-S on ONNX Runtime Web); rule `PHONE_DETECTED` (2 of the last 3 samples, from the chosen detector: by default MediaPipe EfficientDet-Lite2 with a zoom pass over full-resolution crops, for phones at arm's length).

See `docs/PHASE6_REPORT.md`, `docs/PHASE5_REPORT.md`, `docs/PHASE4_REPORT.md`, `docs/PHASE3_REPORT.md`, `docs/PHASE2_REPORT.md`, and `docs/PHASE1_REPORT.md`.

## Quick start

Requires Node.js 20.19+ (developed on 24.20) and Chrome or Edge. Firefox 157 ran the Phase 1 lab (tested by hand in three runs; see `docs/KNOWN_LIMITATIONS.md`); the face engines have not been tried in Firefox yet.

```powershell
npm install
npm run fetch-models   # once: downloads the models (115.0 MB) and verifies their SHA-256
npm run dev
```

Open http://localhost:5173, give consent, start the camera, wait until the face engines are ready (about 4 s), and start detection. Enrollment and calibration are in the Identity and Calibration panels under the camera preview.

http://localhost:5173/demo is a page for showing the lab: the camera with its overlay switches, a toast for every violation, gaze calibration and face enrollment, and a log of the session's violations with their snapshots. "Start camera" there also starts detection.

| Script                              | Purpose                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`                       | Dev server with cross-origin isolation headers                                      |
| `npm run build` / `npm run preview` | Production build (with CSP) and local preview                                       |
| `npm test`                          | Unit tests (Vitest)                                                                 |
| `npm run lint` / `npm run format`   | ESLint / Prettier                                                                   |
| `npm run verify`                    | Lint, format check, unit tests, build                                               |
| `npm run smoke`                     | Headless browser smoke test with a synthetic camera; `-- --channel=msedge` for Edge |
| `npm run fetch-models`              | Download model files into `public/models/` (`-- --check` verifies only)             |

## Layout

```text
src/
  app/          LabController (composition root), App, pages
  capture/      CameraManager, VideoFrameSource, FrameScheduler
  pipeline/     DetectionPipeline, TemporalCondition, ViolationEngine
  engines/      engine contract, base class, diagnostic engine, face/ (MediaPipe Face Landmarker),
                verification/ (YuNet + SFace on ONNX Runtime Web), quality/ (image statistics),
                objects/ (EfficientDet-Lite on MediaPipe, NanoDet-Plus and YOLOX-S on ONNX Runtime Web)
  identity/     quality gates, enrollment and comparison, calibration math, IndexedDB store
  attention/    gaze, head, and eye classification against the person's baseline, calibration, presets
  quality/      image-quality assessment (lighting and image reasons) from the image-quality engine
  objects/      per-engine object counts and the samples the object rules read
  snapshots/    camera image and details per violation, stored in IndexedDB for 1 hour
  workers/      worker protocol, engine host, egress guard, per-kind worker entries, main-thread client
  benchmark/    PerformanceMonitor, statistics, DeviceProfiler
  config/       Zod schemas, default configuration, pinned model assets
  ui/           React components (Bootstrap)
  utils/        clock, errors, validation
tests/          unit tests (mirror src/)
scripts/        browser smoke test, model fetch script, Vite plugin serving the MediaPipe and ONNX Runtime WASM
public/models/  downloaded model files (not in git)
docs/           plan, architecture, model licenses, testing guide, limitations, phase reports
reports/        smoke test output (JSON)
```

## Documentation

- `docs/IMPLEMENTATION_PLAN.md` — phases, decisions, benchmark protocol, risks
- `docs/ARCHITECTURE.md` — data flow, engine contract, worker protocol, scheduling, face engines, identity, metrics, security, browser support
- `docs/MODEL_LICENSES.md` — model artifacts, sources, sizes, hashes, licenses, open questions
- `docs/TESTING_GUIDE.md` — unit tests, smoke test, manual webcam checklists
- `docs/KNOWN_LIMITATIONS.md` — what the current results do and do not show
- `docs/PHASE1_REPORT.md` to `docs/PHASE6_REPORT.md` — phase results

## Privacy

Video is processed in the browser only. Production builds enforce this with a Content Security Policy that blocks requests to other origins, sent as a header so it also applies to the workers. Each worker additionally refuses requests to other origins itself; this matters because MediaPipe Tasks Vision 1.2.2 tries to send usage statistics to Google (see `docs/MODEL_LICENSES.md`).

When a violation starts, the lab saves a snapshot of the camera image (JPEG, up to 960 px wide) with the violation's details in this browser's IndexedDB, for review under "Snapshots". Snapshots are deleted after 1 hour, or when the lab is next opened if the browser was closed by then, and at once with "Delete all". No other images are stored. If you enroll a reference face or record calibration samples, the lab stores face templates (128 numbers per face) in this browser's IndexedDB until you click "Delete all identity data". Exported reports contain timings, configuration, device information, observations of the latest frame, the violation history, reference metadata, calibration rates, and the number of stored snapshots; never images, landmarks, or face templates.
