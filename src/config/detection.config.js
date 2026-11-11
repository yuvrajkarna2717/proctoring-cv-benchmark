import { DEFAULT_FACE_LANDMARKER_CONFIG } from "../engines/face/faceLandmarkerConfig.js";
import { DEFAULT_FACE_VERIFIER_CONFIG } from "../engines/verification/faceVerifierConfig.js";
import { validateLabConfig } from "./schema.js";

/**
 * Default lab configuration. Every threshold and rate is a starting point for benchmarking, not
 * a validated value. The object is validated at import time so a bad default fails fast.
 *
 * Engines:
 * - `face-landmarker`: MediaPipe Face Landmarker at 5 FPS, highest priority. It feeds the
 *   NO_FACE and MULTIPLE_FACES rules.
 * - `face-verifier`: YuNet + SFace on ONNX Runtime Web at 2 FPS, lower priority, yielding to
 *   the face landmarker. Its embeddings feed enrollment, calibration, and identity checks.
 * - `probe-high`, `probe-low`: model-free diagnostic probes from Phase 1, disabled by default.
 *   `probe-high` measures pipeline overhead (5 FPS, no work); `probe-low` emulates a slow
 *   object detector (1 FPS, low priority, 250 ms of blocking work per frame, 640 px input).
 */
export const DEFAULT_LAB_CONFIG = Object.freeze(
  validateLabConfig({
    camera: { width: 1280, height: 720, frameRate: 30 },
    monitor: {
      latencyWindowSize: 2000,
      fpsWindowMs: 5000,
      eventLoopProbeIntervalMs: 100,
      stallThresholdMs: 250,
      uiRefreshIntervalMs: 500,
    },
    engines: [
      {
        id: "face-landmarker",
        kind: "face-landmarker",
        label: "MediaPipe Face Landmarker",
        description:
          "BlazeFace detector + Face Mesh V2 (478 landmarks), VIDEO mode, up to 3 faces. Feeds NO_FACE and MULTIPLE_FACES.",
        scheduler: {
          enabled: true,
          targetFps: 5,
          priority: 10,
          maxFrameAgeMs: 500,
          yieldToHigherPriority: false,
          maxYieldMs: 0,
        },
        capture: { maxInputWidth: null },
        engineConfig: { ...DEFAULT_FACE_LANDMARKER_CONFIG },
        // The first load compiles a 14.6 MB WASM binary and, for GPU, WebGL shaders.
        initTimeoutMs: 60_000,
        requestTimeoutMs: 10_000,
      },
      {
        id: "face-verifier",
        kind: "face-verifier",
        label: "Face verification (YuNet + SFace)",
        description:
          "YuNet face detector, five-point alignment, SFace 128-value embedding on ONNX Runtime Web. Feeds enrollment, calibration, and FACE_MISMATCH.",
        scheduler: {
          enabled: true,
          targetFps: 2,
          priority: 5,
          maxFrameAgeMs: 1000,
          yieldToHigherPriority: true,
          maxYieldMs: 300,
        },
        // Full resolution: the face is aligned from the original frame; YuNet gets a copy scaled
        // to detectorInputWidth inside the worker.
        capture: { maxInputWidth: null },
        engineConfig: { ...DEFAULT_FACE_VERIFIER_CONFIG },
        // Loads a 28.7 MB WASM binary and 10.9 MB of models (38.9 MB with fp32 SFace); WebGPU
        // compiles shaders on top.
        initTimeoutMs: 60_000,
        requestTimeoutMs: 10_000,
      },
      {
        id: "probe-high",
        kind: "diagnostic",
        label: "Diagnostic probe A",
        description: "Pipeline-overhead probe: 5 FPS, priority 10, no simulated work.",
        scheduler: {
          enabled: false,
          targetFps: 5,
          priority: 10,
          maxFrameAgeMs: 500,
          yieldToHigherPriority: false,
          maxYieldMs: 0,
        },
        capture: { maxInputWidth: null },
        engineConfig: { sampleWidth: 64, simulatedWorkMs: 0, simulatedInitMs: 0, failEveryN: 0 },
        initTimeoutMs: 30_000,
        requestTimeoutMs: 10_000,
      },
      {
        id: "probe-low",
        kind: "diagnostic",
        label: "Diagnostic probe B",
        description:
          "Object-detector stand-in: 1 FPS, priority 1, 250 ms blocking work, 640 px input.",
        scheduler: {
          enabled: false,
          targetFps: 1,
          priority: 1,
          maxFrameAgeMs: 1500,
          yieldToHigherPriority: true,
          maxYieldMs: 500,
        },
        capture: { maxInputWidth: 640 },
        engineConfig: { sampleWidth: 64, simulatedWorkMs: 250, simulatedInitMs: 0, failEveryN: 0 },
        initTimeoutMs: 30_000,
        requestTimeoutMs: 10_000,
      },
    ],
    // Starting values from docs/IMPLEMENTATION_PLAN.md (NO_FACE 800–1000 ms, MULTIPLE_FACES
    // 500–800 ms); to be tuned against annotated recordings in Phases 7–8.
    violations: {
      sourceEngineId: "face-landmarker",
      maxGapMs: 2000,
      historySize: 200,
      rules: {
        NO_FACE: {
          enabled: true,
          minDurationMs: 1000,
          clearAfterMs: 500,
          cooldownMs: 3000,
          severity: "medium",
        },
        MULTIPLE_FACES: {
          enabled: true,
          minDurationMs: 700,
          clearAfterMs: 500,
          cooldownMs: 3000,
          severity: "high",
          minFaces: 2,
        },
        // Evaluated only with an enrolled reference, on frames that pass the verification
        // gate. At 2 FPS, 2 s is about four compared frames in a row below the threshold.
        FACE_MISMATCH: {
          enabled: true,
          minDurationMs: 2000,
          clearAfterMs: 1000,
          cooldownMs: 5000,
          severity: "high",
          // OpenCV Zoo's default cosine threshold for SFace; calibrate before relying on it.
          similarityThreshold: 0.363,
        },
      },
    },
    // Starting values. The Identity panel shows each measured value next to its limit.
    identity: {
      sourceEngineId: "face-verifier",
      enrollment: {
        samples: 5,
        minIntervalMs: 400,
        timeoutMs: 30_000,
        minSampleSimilarity: 0.6,
        gate: {
          requireSingleFace: true,
          minScore: 0.9,
          minInterEyePx: 40,
          maxAbsRollDeg: 15,
          maxAbsYawRatio: 0.15,
          minBrightness: 60,
          maxBrightness: 200,
          minSharpness: 20,
          requireInFrame: true,
        },
      },
      verification: {
        gate: {
          requireSingleFace: false,
          minScore: 0.9,
          minInterEyePx: 30,
          maxAbsRollDeg: 30,
          maxAbsYawRatio: 0.3,
          minBrightness: 40,
          maxBrightness: 220,
          minSharpness: 10,
          requireInFrame: false,
        },
        historySize: 240,
      },
      calibration: { samplesPerCapture: 5, minIntervalMs: 400, timeoutMs: 30_000 },
    },
  }),
);
