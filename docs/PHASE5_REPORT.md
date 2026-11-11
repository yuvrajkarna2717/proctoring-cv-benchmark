# Phase 5 report — Image quality

Date: 2026-11-11. Deliverable: a model-free image-quality engine at 1 FPS. It measures lighting, contrast, and sharpness of the frame and of the face region, using the face landmarker's latest face box. Two new rules report lasting problems: `LIGHTING_ISSUE` and `LOW_IMAGE_QUALITY`. Other violations now record the image problems present when they started. Verified with unit tests, mutation checks, a public-domain portrait with darkened, brightened, blurred, and backlit variants, and the browser smoke test. Thresholds against real webcams and rooms are still open.

## Design

Image quality is an environment problem, not misconduct. Three things follow from that:

- **Separate, low-severity rules.** `LIGHTING_ISSUE` and `LOW_IMAGE_QUALITY` have severity low and need 5 s of a lasting problem (at 1 FPS: 5–6 samples), so movement blur or an auto-exposure change passes. In a product they would prompt the candidate ("move to a brighter place") rather than flag them.
- **Context for other rules.** A GAZE_AWAY, FACE_MISMATCH, or NO_FACE that starts while the image is dark or blurry records `imageIssues` (for example `["dark"]`), shown in the history. A reviewer can then discount face results that came from a poor image.
- **Face first.** Lighting that suits the face is what matters to the face models, so the face region is judged. A bright window behind a well-lit face is fine; a well-lit room with the face in shadow is not. Without a face, only problems of the whole frame are reported (a dark or blown-out frame, a low camera resolution). Everything else stays "undecided" with the reason.

## What was built

- **`ImageQualityEngine`** (`src/engines/quality/`, `src/workers/quality.worker.js`, kind `image-quality`, default instance at 1 FPS, priority 3, yielding to the face engines).
  - It reads the frame back once, scaled to `readWidth` (640 px by default).
  - It computes `FRAME_QUALITY` on a 320 px copy: mean luma, RMS contrast, 5th/50th/95th percentiles, shares of crushed (≤ 16) and blown (≥ 245) pixels, and sharpness.
  - It computes `FACE_QUALITY` on the face box plus a 10% margin, resampled to 112 px wide: the same statistics, the background luma outside the box, and the face width in camera pixels and as a share of the frame.
  - It finds no faces itself. The face box arrives as a hint with the frame (`meta.hints.face`, a new optional field passed by the pipeline), taken from the face landmarker's latest result. A hint older than 1.5 s is not used.
- **Sharpness normalized by contrast.** Sharpness is the Laplacian variance divided by the luma variance. The plain Laplacian variance scales with contrast squared, so a dark but sharp face scored like a blurred one. On the portrait (face read at 1280 px) the Laplacian variance was 1005 plain, 62 darkened, and 4.8 blurred; the normalized values were 0.28, 0.28, and 0.0018.
- **Assessment** (`src/quality/qualityModel.js`, main thread, limits in `imageQuality` of the lab configuration, editable in the Image quality panel):

| Part     | Reason           | Default condition                                                             |
| -------- | ---------------- | ----------------------------------------------------------------------------- |
| Lighting | `dark`           | face luma < 60, or > 30% crushed face pixels; without a face: frame luma < 35 |
| Lighting | `too-bright`     | face luma > 200, or > 15% blown face pixels; without a face: frame luma > 235 |
| Lighting | `backlit`        | face luma < 0.5 × background luma, with the background ≥ 150                  |
| Lighting | `low-contrast`   | face RMS contrast < 10                                                        |
| Image    | `blurry`         | face sharpness < 0.01                                                         |
| Image    | `face-too-small` | face < 80 camera pixels or < 8% of the frame width                            |
| Image    | `low-resolution` | camera frames < 640 px wide                                                   |

The face luma limits are those of the identity enrollment gate (60–200), so "lighting ok" means good enough to enroll.

- **Rules** (`ViolationEngine.observeQuality`): `LIGHTING_ISSUE` and `LOW_IMAGE_QUALITY`.
  - Defaults: 5 s minimum, clear after 3 s, 30 s cooldown, severity low.
  - A gap limit of 5 s per rule (new `maxGapMs` rule field), since the face rules' 2 s gap limit is too tight for a 1 FPS engine that yields.
  - Each violation records its reasons, most frequent first. Undecided samples are skipped.
  - Every other violation records `imageIssues` from the latest quality sample, if it is at most 3 s old: `[]` for a good image, `null` without a recent sample.
- **UI**:
  - An Image quality panel: lighting and image state with their reasons, the measured values next to their limits, counts per reason, and the editable limits.
  - Read and crop widths in the engine card.
  - In the Violations panel: the reasons of the quality rules, and an "image: …" note under the measure of other violations.

## Files

| Area              | New                                                                                                                                          | Changed                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engines, workers  | `src/engines/quality/ImageQualityEngine.js`, `imageQualityConfig.js`, `imageStats.js`; `src/workers/quality.worker.js`                       | `src/engines/engineKinds.js`, `EngineContract.js` (`FrameMeta.hints`), `src/workers/workerFactories.js`                                                   |
| Quality, pipeline | `src/quality/qualityModel.js`                                                                                                                | `src/pipeline/DetectionPipeline.js` (hints), `ViolationEngine.js` (quality input, reasons, `imageIssues`, per-rule gap limit)                             |
| Config            | —                                                                                                                                            | `src/config/schema.js`, `detection.config.js`                                                                                                             |
| App, UI           | `src/ui/quality/ImageQualityPanel.jsx`                                                                                                       | `src/app/LabController.js` (face hint, wiring), `routes/LiveTestingPage.jsx`, `src/ui/detections/EngineCard.jsx`, `src/ui/violations/ViolationsPanel.jsx` |
| Tests             | `tests/engines/quality/{imageStats,ImageQualityEngine}.test.js`, `tests/quality/qualityModel.test.js`, `tests/pipeline/QualityRules.test.js` | `tests/app/LabController.test.js`, `tests/engines/verification/FaceVerificationEngine.test.js` (timeout), `scripts/browser-smoke.mjs` (scenario R)        |
| Docs              | this report                                                                                                                                  | `README.md`, `docs/IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `TESTING_GUIDE.md`, `KNOWN_LIMITATIONS.md`                                                 |

## Dependencies and models

None added. The engine is plain JavaScript on an `OffscreenCanvas` in its worker.

## Tests performed

- `npm run verify`: ESLint, Prettier, 364 unit tests in 33 files (329 in 29 files after Phase 4), production build. The main chunk is 537 kB (525 kB after Phase 4), so Vite's "chunks larger than 500 kB" warning remains.
  - One existing test timed out once when the new test files ran in parallel: it builds a 10 MB synthetic model. It now has a 20 s timeout.
- **Mutation checks:** 18 small changes to the new logic, all caught on the first run. List in `docs/TESTING_GUIDE.md`.
- **Portrait run.** The same public-domain portrait as in Phase 4 was fed to the real app as the camera (headless Chrome, used locally, not in the repository). Measured on the face region:

| Variant                                      | Face luma | Background luma | Blown | Normalized sharpness | Assessment                          |
| -------------------------------------------- | --------: | --------------: | ----: | -------------------: | ----------------------------------- |
| Original                                     |       119 |              55 |    1% |                 0.28 | lighting ok, image ok               |
| Brightness × 0.25                            |        30 |              37 |    0% |                 0.29 | `dark`                              |
| Brightness × 2.4                             |       217 |              80 |   53% |                    — | `too-bright`                        |
| 5 px Gaussian blur                           |       121 |              54 |    0% |               0.0018 | `blurry`                            |
| Darkened face (× 0.45) on a white background |        53 |             204 |    0% |                    — | `dark`, `backlit`                   |
| Scaled to 30%                                |         — |               — |     — |                    — | landmarker found no face: undecided |

- These were read at 1280 px. At the default 640 px, the measured Laplacian variance and contrast give 0.084 (original), 0.086 (darkened), and 0.0017 (blurred). The limit of 0.01 lies 8 times below the sharp face and 6 times above the blurred one.
- The landmarker did not always find the brightened face (it flickered between frames).
- **Smoke test** (headless, synthetic camera without a face). The new scenario R checks:
  - results at 1.01 FPS without failures;
  - frame statistics from real pixels (mean luma 106, contrast 27);
  - one timed read per frame at 640 px;
  - the face region not measured ("no face in the face landmarker's latest result") and the assessment undecided;
  - no `LOW_IMAGE_QUALITY`;
  - the panel rendered.

  NO_FACE in the same run recorded `imageIssues: []`.

| Run                                                         | Browser       | Functional | Performance |
| ----------------------------------------------------------- | ------------- | ---------- | ----------- |
| `reports/phase5-smoke-chrome-2026-11-11T10-41-08-173Z.json` | Chrome, build | 83/83      | 12/12       |
| `reports/phase5-smoke-msedge-2026-11-11T10-45-29-268Z.json` | Edge, build   | 83/83      | 12/12       |

One earlier Edge attempt stopped in scenario A because the synthetic camera ended its track (the known Chromium device issue).

## Measured results

**Cost** (the plan's question: does CPU read-back matter?). These numbers are from the smoke runs: 1280×720 camera, read at 640 px, face landmarker running alongside, five frames each. Chrome and Edge headless on the development laptop (i5-12450H, Intel UHD).

| Browser | Read-back (drawImage + getImageData) p50 / p95 | Engine total p50 / p95 |
| ------- | ---------------------------------------------: | ---------------------: |
| Chrome  |                                  8.9 / 13.4 ms |         13.4 / 25.9 ms |
| Edge    |                                  12.5 ms (p50) |          24.9 ms (p50) |

At 1 FPS that is about 1–2.5% of one worker's time. In Node, the computation on a 1280×720 plane took about 8 ms, mostly the luma conversion (3.1 ms) and the downscale (3.9 ms).

During the portrait runs the same engine measured 50–330 ms per read. That was with the test page redrawing a filtered canvas on every animation frame as the camera source, and the face landmarker on software WebGL. Those timings describe that test setup, not the engine, but they show that the read-back cost rises sharply when the GPU is busy. Reading at 1280 px instead of 640 px roughly doubled it in those runs, which is why 640 px is the default.

**What the numbers show:**

- Image quality is cheap enough to run beside the face engines at 1 FPS on this laptop.
- The checks separate the portrait's variants by large margins. Real rooms, webcams (noise, auto exposure), and skin tones are not covered yet; see the limitations.

## Exit criteria

| Criterion (from `docs/IMPLEMENTATION_PLAN.md`)                                                                  | Status                                                                |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Brightness, under/over-exposure, contrast, Laplacian blur on face and frame; face size relative to frame; 1 FPS | Done                                                                  |
| Events `LIGHTING_ISSUE`, `LOW_IMAGE_QUALITY`                                                                    | Done, plus `imageIssues` on other violations                          |
| Measure whether CPU read-back cost matters                                                                      | Done: 9–13 ms p50 per sample in the smoke runs; higher under GPU load |
| Thresholds checked on real conditions                                                                           | **Open**: one portrait and its synthetic variants only                |

## Limitations

The main ones (full list in `docs/KNOWN_LIMITATIONS.md`):

- Limits come from one portrait and the identity gate, not from real rooms and webcams.
- Camera auto-exposure works against a "dark" check. Many webcams brighten a dark scene by raising gain, which keeps the luma near normal but adds noise, and noise raises the sharpness measure. A dim, noisy image can therefore pass both checks.
- Luma thresholds treat all faces alike. Darker skin tones give a lower face luma under the same light, so the 60 limit may report "dark" for a well-lit darker face. This needs checking with diverse faces before any product use; a per-person baseline, like Phase 4's, may be needed.
- The face box is up to 1.5 s old; fast movement can put part of the background in the crop.
- Without a face, almost nothing is decided; NO_FACE covers that case.

## Next step

1. Run the Phase 5 checklist in `docs/TESTING_GUIDE.md` with a real webcam (lamp off, lamp behind you, window behind you, move back, cover the lens with a finger, shake the laptop). Note which reports felt wrong and send an exported report.
2. After your approval: Phase 6, object detection (phone, notebook). Or, if you prefer, Phases 7–8 (recordings and the evaluation report) first, since they turn every rule's thresholds into measured rates.
