import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";

/** The default ("balanced") attention configuration, with overrides. */
export function attentionConfig(overrides = {}) {
  return { ...structuredClone(DEFAULT_LAB_CONFIG.attention), ...overrides };
}

/**
 * An attention frame of one face. Angles are camera-relative (what the engine reports).
 *
 * @param {Partial<{ at: number, faceCount: number, gazeYaw: number, gazePitch: number,
 *   headYaw: number, headPitch: number, blink: number, ear: number, eyeWidthPx: number,
 *   noGaze: boolean }>} [options]
 */
export function frame({
  at = 0,
  faceCount = 1,
  gazeYaw = 0,
  gazePitch = -10,
  headYaw = 0,
  headPitch = -5,
  blink = 0.02,
  ear = 0.3,
  eyeWidthPx = 30,
  noGaze = false,
} = {}) {
  return {
    at,
    faceCount,
    head: faceCount ? { yawDeg: headYaw, pitchDeg: headPitch, rollDeg: 0 } : null,
    gaze: faceCount && !noGaze ? { yawDeg: gazeYaw, pitchDeg: gazePitch, eyeWidthPx } : null,
    eyes: faceCount ? { blinkLeft: blink, blinkRight: blink, earLeft: ear, earRight: ear } : null,
  };
}

/** A calibrated profile: centre at gaze (0, −10), head (0, −5); screen ±17° / ±10°. */
export function profile(overrides = {}) {
  return {
    source: "calibration",
    createdAt: 0,
    gazeCenter: { yawDeg: 0, pitchDeg: -10 },
    screen: { leftDeg: 17, rightDeg: 17, upDeg: 10, downDeg: 10 },
    headCenter: { yawDeg: 0, pitchDeg: -5 },
    openEar: 0.3,
    samples: 30,
    ...overrides,
  };
}

/**
 * A face-landmarker detection result carrying the attention observations of `frame()`.
 * @param {ReturnType<typeof frame>} f
 */
export function attentionResult(f, engine = "face-landmarker") {
  return {
    engine,
    frameCaptureTime: f.at,
    observations: [
      { type: "FACE_COUNT", detected: f.faceCount > 0, value: f.faceCount },
      ...(f.faceCount
        ? [
            {
              type: "HEAD_POSE",
              detected: f.head !== null,
              value: 0,
              metadata: f.head ?? {},
            },
            {
              type: "EYE_GAZE",
              detected: f.gaze !== null,
              value: 0,
              metadata: f.gaze ?? { reason: "no iris" },
            },
            { type: "EYE_STATE", detected: true, value: 0, metadata: f.eyes },
          ]
        : []),
    ],
  };
}
