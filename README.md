# Proctoring CV Lab

Browser-only research lab for measuring whether open-source computer vision models can replace or reduce cloud vision APIs (AWS Rekognition) in online interview and exam proctoring. It is a benchmarking tool, not a production proctoring SDK. All inference runs locally in the browser; nothing is uploaded.

Status: **Phase 3 (1:1 face verification) implemented; calibration on real faces pending.**

- Phase 2: MediaPipe Face Landmarker in a worker (GPU or CPU delegate), face overlay, and `NO_FACE` and `MULTIPLE_FACES` rules with configurable durations, hysteresis, cooldowns, and severity.
- Phase 3: YuNet face detection and SFace embeddings on ONNX Runtime Web (WASM by default, WebGPU selectable) in a second worker; enrollment of a reference face with a quality gate; live similarity to the reference and a `FACE_MISMATCH` rule; a calibration tool for FAR, FRR, EER, and ROC on your own captures.

See `docs/PHASE3_REPORT.md`, `docs/PHASE2_REPORT.md`, and `docs/PHASE1_REPORT.md`.

## Quick start

Requires Node.js 20.19+ (developed on 24.20) and Chrome or Edge. Firefox 157 ran the Phase 1 lab (tested by hand in three runs; see `docs/KNOWN_LIMITATIONS.md`); the face engines have not been tried in Firefox yet.

```powershell
npm install
npm run fetch-models   # once: downloads the models (63.2 MB) and verifies their SHA-256
npm run dev
```

Open http://localhost:5173, give consent, start the camera, wait until the face engines are ready (about 4 s), and start detection. Enrollment and calibration are in the Identity and Calibration panels under the camera preview.

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
                verification/ (YuNet + SFace on ONNX Runtime Web)
  identity/     quality gates, enrollment and comparison, calibration math, IndexedDB store
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
- `docs/PHASE1_REPORT.md`, `docs/PHASE2_REPORT.md`, `docs/PHASE3_REPORT.md` — phase results

## Privacy

Video is processed in the browser only. Production builds enforce this with a Content Security Policy that blocks requests to other origins, sent as a header so it also applies to the workers. Each worker additionally refuses requests to other origins itself; this matters because MediaPipe Tasks Vision 1.2.2 tries to send usage statistics to Google (see `docs/MODEL_LICENSES.md`).

No images are stored. If you enroll a reference face or record calibration samples, the lab stores face templates (128 numbers per face) in this browser's IndexedDB until you click "Delete all identity data". Exported reports contain timings, configuration, device information, observations of the latest frame, the violation history, reference metadata, and calibration rates; never images, landmarks, or face templates.
