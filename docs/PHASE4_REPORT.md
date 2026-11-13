# Phase 4 report — Head pose, gaze, eye state

> **Change, 2026-11-12:** `GAZE_AWAY_REPEATED` (and its `GlanceCounter`) was removed at the user's request. This report describes Phase 4 as delivered; `GAZE_AWAY`, `HEAD_TURNED`, and `EYES_CLOSED` are unchanged, and the presets no longer carry glance settings.
>
> **Change, 2026-11-12:** `GAZE_AWAY` now reports on the second frame away (100 ms, clear after 100 ms, cooldown 1000 ms); see "Second tuning" at the end.

Date: 2026-11-11. Deliverable: head pose, gaze direction, and eye state from the MediaPipe Face Landmarker. These are judged against each person's own screen area, which is set by a guided calibration or a baseline learned at the start. The rules are `GAZE_AWAY`, `GAZE_AWAY_REPEATED`, `HEAD_TURNED`, and `EYES_CLOSED`, with lenient, balanced, and strict presets. Verified with unit tests, mutation checks, a still portrait run through the real app, and the browser smoke test. Accuracy against annotated recordings with real people is still open (see "Exit criteria").

## The problem this phase addresses

Users of the existing gaze check disagree: some find it too strict, others can still cheat. Two causes were addressed:

1. **One fixed angle limit for everyone.** The direction of "looking at the screen" depends on where the camera sits (above, beside, below the screen), how large and how far the screen is, and how the person sits. A limit of, say, 20° from the camera flags a person whose camera sits to the side of their monitor all the time. The same limit lets a person with a large screen close by look at notes next to it.
2. **One duration for everything.** A short limit flags glances, blinks, and thinking. A long limit lets a person read notes in many short looks, each under the limit.

How the lab handles them:

| Cause             | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed angle limit | Everything is measured relative to the person's own **screen area**. A 15-second calibration (a dot at the centre and the four corners) measures where this person looks when looking at this screen. Without a calibration, the median gaze of the first 10 s is the centre and a default screen size is assumed; violations then say "uncalibrated".                                                                                                                                                        |
| Head pose alone   | The rules use **gaze = head pose + eye direction**. Eyes-only glances at notes are caught; a turned head with the eyes back on the screen (common with a camera beside the monitor) is not flagged as looking away.                                                                                                                                                                                                                                                                                           |
| One duration      | Two rules with different jobs. `GAZE_AWAY` reports **a look outside the screen area** (0.5 s by default since the user's webcam tuning; first 2 s). `GAZE_AWAY_REPEATED` reports **the pattern of many looks toward the same side** (4 in 30 s by default, each at least 0.4 s). Looks shorter than 0.5 s and looking around while thinking, spread over directions, pass both.                                                                                                                               |
| Natural behaviour | Blinks and closed eyes make the gaze "undecided" (skipped, not "away"). A margin around the screen (5°) and an extra margin below it (5°, keyboard) are tolerated. Spatial hysteresis (2°) keeps jitter at the edge from splitting one look into many. Lowered lids while looking down do not count as closed eyes. Eyes count as closed only if MediaPipe's blink score is high and the eye aspect ratio is low against the person's own open-eye value, so naturally narrow eyes are not treated as closed. |
| Severity          | A violation starts at the rule's severity and is **raised after it lasts longer** (GAZE_AWAY: medium, high after 8 s). Every record has the angle beyond the area, the direction, and the baseline, so a reviewer can tell a 2-second glance down from a 20-second look to the side.                                                                                                                                                                                                                          |
| Different exams   | **Presets** set the tolerances and timings together: lenient (open-book, typing), balanced (default), strict (closed-book). Each value stays editable; an edit makes the preset "custom".                                                                                                                                                                                                                                                                                                                     |

None of these values has been checked against real recordings yet. They are starting points for Phases 7–8, where annotated recordings measure the false-alarm and miss rates per preset.

## What was built

- **Measurements in the face worker** (`src/engines/face/faceGeometry.js`, `FaceLandmarkerEngine.js`). Blendshapes and transformation matrices are now on by default. For the largest face, the worker adds three observations:
  - `HEAD_POSE`: yaw, pitch, and roll from the 4×4 matrix. The layout (column- or row-major) is detected from where the translation is.
  - `EYE_GAZE`: gaze direction from the iris rings relative to the eye corners, corrected for the head pose with a simple eye model, plus the eyes' part of it. An eye with a blink score above 0.5 is left out.
  - `EYE_STATE`: blink scores and the eye aspect ratio of each eye.

  Signs are from the person's point of view: yaw > 0 means to their right, pitch > 0 means up.

- **Attention layer** (`src/attention/`, main thread). The engine only measures; this layer decides, against the person's baseline.
  - `attentionModel.js`: the classifier, with gaze on/away/undecided, head ok/turned/undecided, and eyes open/closed/undecided, each with its measured angles and the reason when undecided. It also learns the baseline when there is no calibration.
  - `attentionCalibration.js`: the guided calibration. Six targets; each repeats when too few usable frames arrived or the gaze moved more than 4°. The run fails with a clear reason when the gaze did not move toward every edge.
  - `presets.js`: the three presets.
  - `AttentionManager.js`: ties these together; also keeps blink counts and the recent gaze trail.
- **Rules** (`src/pipeline/ViolationEngine.js`, `GlanceCounter.js`):
  - `GAZE_AWAY`, `HEAD_TURNED`, and `EYES_CLOSED` use the existing temporal conditions.
  - `GAZE_AWAY_REPEATED` counts glances in a sliding window.
  - Undecided samples are skipped, so a blink neither ends nor extends a look away.
  - New violation fields: `maxExcessDeg`, `direction`, `glanceCount`, `maxClosure`, `baseline`, `initialSeverity`, `escalatedAt`.
  - New end reason: `baseline-changed`, used when a calibration or reset replaces the baseline.
- **UI**:
  - Attention panel under the camera preview: strictness, "Calibrate gaze", "Reset baseline", a live gaze chart showing the screen area, the tolerated area, and recent frames, the state and angles of gaze, head, and eyes, and the tolerances.
  - Full-window calibration overlay. It requests full screen, warns when calibrating in a window, and cancels with Esc.
  - The Violations panel shows the new rules, their glance count and escalation settings, and each violation's measure with its direction.

## Files

| Area      | New                                                                                                                                                                                           | Changed                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Engines   | `src/engines/face/faceGeometry.js`                                                                                                                                                            | `src/engines/face/FaceLandmarkerEngine.js` (attention observations, largest face), `faceLandmarkerConfig.js` (outputs on by default) |
| Attention | `src/attention/attentionModel.js`, `attentionCalibration.js`, `AttentionManager.js`, `presets.js`                                                                                             | —                                                                                                                                    |
| Pipeline  | `src/pipeline/GlanceCounter.js`                                                                                                                                                               | `src/pipeline/ViolationEngine.js` (attention input, readings, escalation, direction), `TemporalCondition.js` (end reason)            |
| Config    | —                                                                                                                                                                                             | `src/config/schema.js` (four rules, attention configuration), `detection.config.js` (balanced defaults)                              |
| App, UI   | `src/ui/attention/AttentionPanel.jsx`, `GazePlot.jsx`, `CalibrationOverlay.jsx`                                                                                                               | `src/app/LabController.js`, `routes/LiveTestingPage.jsx`, `app.css`, `src/ui/violations/ViolationsPanel.jsx`                         |
| Tests     | `tests/engines/faceGeometry.test.js`, `tests/attention/{attentionModel,attentionCalibration,AttentionManager}.test.js`, `tests/pipeline/AttentionRules.test.js`, `tests/helpers/attention.js` | `tests/engines/FaceLandmarkerEngine.test.js`, `tests/app/LabController.test.js`, `scripts/browser-smoke.mjs` (scenario Q)            |
| Docs      | this report                                                                                                                                                                                   | `README.md`, `docs/IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `TESTING_GUIDE.md`, `KNOWN_LIMITATIONS.md`, `MODEL_LICENSES.md`       |

## Dependencies and models

No dependency and no model was added. Phase 4 uses outputs of the Face Landmarker bundle that Phase 2 already pinned (`mp-face-landmarker`, Apache-2.0): the Blendshape V2 model and the face geometry pipeline. Their model cards place surveillance and identity uses out of scope; the review-before-production note in `docs/MODEL_LICENSES.md` applies unchanged.

## Tests performed

- `npm run verify`: ESLint, Prettier, 328 unit tests in 29 files (265 in 24 files after the Phase 3 follow-up), production build. The main chunk grew from 490 kB to 525 kB (attention layer and panel), so Vite now prints its "chunks larger than 500 kB" warning. Splitting the bundle is not part of this phase.
- Mutation checks: 28 small changes to the new logic, each run against its test file. 27 were caught on the first run. The surviving one, a calibration dropped at the start of a new detection session, led to a new assertion, and then all 28 were caught. List in `docs/TESTING_GUIDE.md`.
- **Real-face check of the conventions.** I ran a public-domain portrait through the real app in headless Chrome, as a canvas stream in place of the camera: Vermeer's "Girl with a Pearl Earring", in which the head is turned to her right and the eyes look at the viewer. The image was used locally and is not in the repository.
  - MediaPipe's matrix is column-major (translation −46 cm in data[12..14]).
  - Head yaw +38.7°, i.e. to her right, as painted. On the mirrored image: −32.3°.
  - Rotating the image 15° clockwise changed roll by −13.9°, and 15° counter-clockwise by +14.8°: the expected signs.
  - Gaze (head + eyes): +5.3° / +2.3° on the original and +6.5° / +10.2° on the mirror image, against 38.7° and 32.3° for the head alone. The eyes look at the viewer, so the gaze points near the camera. The eye-model constant was chosen on this image (see `EYE_MODEL` in `faceGeometry.js`).

  The matrix and the iris offsets of this run are unit-test fixtures (numbers only). The same run learned a baseline after 10 s (50 frames). A calibration on the still image failed as it should: "The gaze did not move toward every edge".

- **Cost of the new outputs** (same portrait, slight horizontal sway, GPU delegate, Chrome headless, 10 s windows, about 46 frames each, outputs alternated in the same worker over three rounds):
  - Face landmarker inference p50 was 38.5, 39.5, and 37.0 ms with blendshapes and matrices on, and 37.8, 40.3, and 35.4 ms with them off.
  - p95 was 49.0, 44.0, and 42.4 ms on, against 42.4, 47.8, and 43.0 ms off.
  - The attention computation in the worker (postprocess stage) took 0.1 ms p50.

  No difference beyond the run-to-run spread. Machine CPU load was 28–60% during these windows.

- **Smoke test** (headless, Chromium synthetic camera, which shows no face). The new scenario Q checks that:
  - every frame is undecided ("no face");
  - no baseline is learned and no attention violation fires;
  - the calibration overlay appears, then the calibration fails with "only 0 usable frames" and the overlay disappears;
  - the strict preset chosen in the UI reaches the tolerances and the rules.

| Run                                                         | Browser       | Functional | Performance                                                                        |
| ----------------------------------------------------------- | ------------- | ---------- | ---------------------------------------------------------------------------------- |
| `reports/phase4-smoke-chrome-2026-11-11T07-45-30-770Z.json` | Chrome, build | 78/78      | 11/12 (B: preview callbacks 17.0 fps under load against a 19.7 fps baseline; WARN) |
| `reports/phase4-smoke-msedge-2026-11-11T07-51-01-489Z.json` | Edge, build   | 78/78      | 12/12                                                                              |

- Not verified:
  - a real person: calibration, looking away, repeated glances, closed eyes, and the presets with a live face;
  - other cameras, positions, glasses, and lighting;
  - Firefox.

## Measured results

The only face measured so far is one still portrait. So the numbers above (the pose conventions, the gaze correction within 7° yaw and 10° pitch on that image, and no added latency) are about correctness and cost, not about accuracy on people. The classification itself (on, away, repeated, closed) was checked with synthetic samples in unit tests, not with recordings.

## Problems found and fixed

| Problem                                                                                                                                                     | Found by                     | Fix                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The first eye model (iris offset corrected with tan of the head yaw) put the gaze of the portrait 52° from the camera, although her eyes look at the viewer | Portrait run                 | Model rewritten for the foreshortened eye width and the depth of the eye corners; gaze within 7° of the camera on that image |
| The new violation log text no longer matched the format the smoke test (and docs) expect for NO_FACE                                                        | Reading the smoke scenario K | Original format kept; attention details go inside it, "uncalibrated" after the severity                                      |
| A calibration could have been dropped at a new detection session without any test noticing                                                                  | Mutation check               | Assertion added                                                                                                              |

## Exit criteria

| Criterion (from `docs/IMPLEMENTATION_PLAN.md`)                                              | Status                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Head pose (yaw, pitch, roll) from MediaPipe's transformation matrix                         | Done; signs and layout checked on a real portrait. `solvePnP` comparison not done (optional, needs OpenCV.js)                                   |
| Gaze from iris position relative to eye corners, normalized by a per-user calibration       | Done (head pose + eyes; guided calibration; learned baseline as fallback)                                                                       |
| Eye openness from blendshapes and eye aspect ratio; blink and prolonged closure separately  | Done (blink count as a lower bound at 5 FPS; `EYES_CLOSED` for prolonged closure)                                                               |
| `GAZE_AWAY`, `HEAD_TURNED`, `EYES_CLOSED`, configurable                                     | Done, plus `GAZE_AWAY_REPEATED`, escalation, and presets                                                                                        |
| Each observation measurable on its own against annotated recordings; calibration flow works | **Open**: recordings and annotation are Phase 7. Calibration flow works in the browser (overlay, retries, failure); success needs a real person |

## Limitations

The main ones (full list in `docs/KNOWN_LIMITATIONS.md`):

- No real person has used it yet; every threshold is a starting value.
- Gaze from iris landmarks is coarse (a few degrees at best, worse with glasses, small faces, or strong head turns); the calibration absorbs a constant error, not noise.
- A learned baseline assumes the person mostly looks at the screen during the first 10 s and uses a default screen size.
- At 5 FPS most blinks fall between frames; looks shorter than about 0.4 s are not counted.
- Looking down at the keyboard and down at notes look the same to the camera; the extra margin below and the lenient preset trade misses for fewer false alarms. Typing activity from the exam page could tell them apart (not in the lab).

## Next step

1. Run the Phase 4 checklist in `docs/TESTING_GUIDE.md` with a real webcam: calibrate, look at the corners, glance at a sheet beside the laptop, read from it, close your eyes, and try each preset. Note which reports felt wrong (too strict or missed) and send an exported report.
2. From that feedback, adjust the balanced preset; measured false-alarm and miss rates need the Phase 7 recordings.
3. After your approval: Phase 5, image quality (lighting, blur, face size).

## Tuning after the user's webcam test (2026-11-11)

The user tested the lab on a real webcam and set GAZE_AWAY to a minimum duration of 500 ms, clear after 300 ms, and cooldown 2000 ms (from 2000 / 600 / 3000). These are now the defaults and the balanced preset.

- At 5 FPS, a look away is confirmed on its 4th frame (600 ms after it began). It ends on the 3rd frame back on screen; the end time recorded is the first frame back.
- The strict preset was 1.5 s, looser than the new balanced value. It is now 300 ms, clear after 300 ms, cooldown 1500 ms, so strict stays at least as strict as balanced. Lenient is unchanged at 3.5 s.
- With a 0.5 s GAZE_AWAY, most looks that GAZE_AWAY_REPEATED counts (at least 0.4 s) are now also reported as GAZE_AWAY. GAZE_AWAY_REPEATED still adds the pattern: four looks toward the same side within 30 s.
- The 2 s cooldown delays a new GAZE_AWAY that starts within 2 s of the previous one's end; such looks are counted as delayed in the rule statistics.

Checks: 329 unit tests pass, including a new test for the 300 ms end.

## Second tuning: faster GAZE_AWAY (2026-11-12)

At the user's request, GAZE_AWAY reports faster: minimum duration 100 ms, clear after 100 ms, cooldown 1000 ms (from 500 / 300 / 2000). These are now the defaults and the balanced preset.

- At 5 FPS a look away is confirmed on its 2nd frame, about 200 ms after it began, so a single misread frame is still not reported. It ends on the 2nd frame back on screen.
- The limit is 100 ms, not 200 ms, because frames reach the face engine 167–233 ms apart (the scheduler keeps its phase on the 30 fps camera grid). With 200 ms, about half of all looks would wait for a 3rd frame. A simulation of 2000 runs with such gaps confirmed every two-frame look on its 2nd frame, never reported a one-frame look, and ended every look on the 2nd frame back.
- Strict now matches balanced (it was 300 / 300 / 1500): a shorter limit would report single frames. Strict keeps its narrower tolerance (3° margin, 5° below, against 5° and 10°). Lenient is unchanged at 3.5 s.
- After a look away ends, a new one is reported once 1 s has passed, if it is still going on.
- Expect more GAZE_AWAY reports from short glances, for example at notes, a phone, or a second screen.

Checks: 412 unit tests pass. The tests of the rule's mechanics in `tests/pipeline/AttentionRules.test.js` now set their own timings (500 / 300 / 2000) instead of reading the defaults; the strict-preset checks in `tests/app/LabController.test.js` and `scripts/browser-smoke.mjs` expect 100 ms.
