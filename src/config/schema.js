import { ENGINE_CONFIG_SCHEMAS, ENGINE_KINDS } from "../engines/engineKinds.js";
import { parseConfig } from "../utils/validation.js";
import { z } from "../utils/zod.js";

/**
 * Per-engine frame scheduling. Each engine instance has its own scheduler; see
 * docs/ARCHITECTURE.md ("Frame scheduling") for the exact semantics.
 */
export const SchedulerConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Target sampling rate. The camera frame rate is the upper bound in practice. */
    targetFps: z.number().positive().max(60),
    /** Higher value = more important. Used for dispatch order and optional yielding. */
    priority: z.number().int().min(0).max(100),
    /** Frames older than this when the worker starts processing are dropped as stale. */
    maxFrameAgeMs: z.number().positive().max(60_000),
    /** Skip a due slot while any higher-priority engine is still processing a frame. */
    yieldToHigherPriority: z.boolean(),
    /**
     * Starvation guard for yielding: once a slot is overdue by this much, the engine dispatches
     * even if a higher-priority engine is busy. Without it, a high-priority engine that is due
     * on most camera frames could block a yielding engine indefinitely.
     */
    maxYieldMs: z.number().min(0).max(60_000),
  })
  .strict();

/** @typedef {z.infer<typeof SchedulerConfigSchema>} SchedulerConfig */

export const CaptureConfigSchema = z
  .object({
    /**
     * Downscale frames to at most this width during capture (createImageBitmap resize), keeping
     * the aspect ratio. null sends the native camera resolution.
     */
    maxInputWidth: z.number().int().min(16).max(8192).nullable(),
  })
  .strict();

/** @typedef {z.infer<typeof CaptureConfigSchema>} CaptureConfig */

export const EngineInstanceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
    kind: z.enum(/** @type {[string, ...string[]]} */ ([...ENGINE_KINDS])),
    label: z.string().min(1),
    description: z.string().optional(),
    scheduler: SchedulerConfigSchema,
    capture: CaptureConfigSchema,
    /** Engine-specific options, validated by the schema registered for `kind`. */
    engineConfig: z.record(z.string(), z.unknown()),
    initTimeoutMs: z.number().int().positive().max(600_000),
    requestTimeoutMs: z.number().int().positive().max(600_000),
  })
  .strict()
  .superRefine((engine, context) => {
    const schema =
      ENGINE_CONFIG_SCHEMAS[/** @type {keyof typeof ENGINE_CONFIG_SCHEMAS} */ (engine.kind)];
    if (!schema) return; // unknown kind is already reported by the enum check
    const result = schema.safeParse(engine.engineConfig);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["engineConfig", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

/** @typedef {z.infer<typeof EngineInstanceSchema>} EngineInstanceConfig */

export const CameraConfigSchema = z
  .object({
    /** Requested as `ideal` constraints; the browser may deliver a different mode. */
    width: z.number().int().positive().max(7680),
    height: z.number().int().positive().max(4320),
    frameRate: z.number().positive().max(120),
  })
  .strict();

/** @typedef {z.infer<typeof CameraConfigSchema>} CameraConfig */

export const MonitorConfigSchema = z
  .object({
    /** Latency samples kept per series for live percentiles. */
    latencyWindowSize: z.number().int().min(10).max(1_000_000),
    /** Window for effective FPS. */
    fpsWindowMs: z.number().int().min(500).max(600_000),
    /** Interval of the main-thread event-loop lag probe. */
    eventLoopProbeIntervalMs: z.number().int().min(10).max(5000),
    /** A probe this late is recorded and logged as a main-thread stall, with a timestamp. */
    stallThresholdMs: z.number().int().min(50).max(60_000),
    /** UI snapshot refresh interval while the camera or detection is running. */
    uiRefreshIntervalMs: z.number().int().min(100).max(10_000),
  })
  .strict();

/** @typedef {z.infer<typeof MonitorConfigSchema>} MonitorConfig */

/**
 * Violation types. NO_FACE and MULTIPLE_FACES are evaluated from FACE_COUNT observations of the
 * violations source engine; FACE_MISMATCH from identity comparisons (see IdentityConfigSchema);
 * GAZE_AWAY, HEAD_TURNED, and EYES_CLOSED from attention samples (see AttentionConfigSchema);
 * LIGHTING_ISSUE from image-quality samples (see ImageQualityLabConfigSchema); PHONE_DETECTED from
 * object samples (see ObjectRuleSchema and ObjectsLabConfigSchema).
 */
export const VIOLATION_TYPES = /** @type {const} */ ([
  "NO_FACE",
  "MULTIPLE_FACES",
  "FACE_MISMATCH",
  "GAZE_AWAY",
  "HEAD_TURNED",
  "EYES_CLOSED",
  "LIGHTING_ISSUE",
  "PHONE_DETECTED",
]);

/** @typedef {typeof VIOLATION_TYPES[number]} ViolationType */

const violationRuleFields = {
  enabled: z.boolean(),
  /** The condition must hold on every frame for this long before a violation starts. */
  minDurationMs: z.number().int().min(0).max(60_000),
  /** Hysteresis: the condition must be absent on every frame for this long before it ends. */
  clearAfterMs: z.number().int().min(0).max(60_000),
  /** After a violation ends, the next one of the same type is not confirmed for this long. */
  cooldownMs: z.number().int().min(0).max(600_000),
  severity: z.enum(["low", "medium", "high"]),
};

export const NoFaceRuleSchema = z.object(violationRuleFields).strict();

export const MultipleFacesRuleSchema = z
  .object({
    ...violationRuleFields,
    /** Face count at which the condition holds. */
    minFaces: z.number().int().min(2).max(10),
  })
  .strict();

export const FaceMismatchRuleSchema = z
  .object({
    ...violationRuleFields,
    /**
     * A compared frame meets the condition when the cosine similarity between its embedding
     * and the enrolled reference is below this value. OpenCV Zoo's default for SFace is 0.363;
     * calibrate it with the calibration tool. A similarity is not a probability.
     */
    similarityThreshold: z.number().min(-1).max(1),
  })
  .strict();

const escalationFields = {
  /**
   * An active violation that lasts this long is raised to `escalatedSeverity` (null: never).
   * A short episode stays at the rule's severity, so a reviewer can tell a long one apart.
   */
  escalateAfterMs: z.number().int().min(0).max(600_000).nullable(),
  escalatedSeverity: z.enum(["low", "medium", "high"]),
};

/** GAZE_AWAY, HEAD_TURNED, EYES_CLOSED: evaluated from the attention samples (see attention). */
export const AttentionRuleSchema = z
  .object({ ...violationRuleFields, ...escalationFields })
  .strict();

/**
 * LIGHTING_ISSUE: evaluated from image-quality samples (1 FPS by default).
 * Their own gap limit, because the image-quality engine samples less often than the face
 * engine and yields to it.
 */
export const QualityRuleSchema = z
  .object({
    ...violationRuleFields,
    /** Samples further apart than this end an active violation with "data-gap". */
    maxGapMs: z.number().int().min(100).max(600_000),
  })
  .strict();

/**
 * PHONE_DETECTED: evaluated from the object samples of `objects.sourceEngineId`
 * (1 FPS by default). A sample is a hit when the frame's best score for `label` reaches
 * `minScore`; the condition holds while at least `votes` of the last `window` samples are hits,
 * so a single false detection does not start a violation and a single miss does not end one.
 */
export const ObjectRuleSchema = z
  .object({
    ...violationRuleFields,
    /** COCO class name, e.g. "cell phone". */
    label: z.string().min(1),
    /**
     * Score at which a frame counts as a hit. Scores are model outputs, not probabilities, and
     * differ between model families; check this value after changing the source engine.
     */
    minScore: z.number().min(0).max(1),
    /** Hits needed among the last `window` samples. */
    votes: z.number().int().min(1).max(20),
    window: z.number().int().min(1).max(20),
    /**
     * Samples further apart than this end an active violation with "data-gap" and empty the
     * vote window.
     */
    maxGapMs: z.number().int().min(100).max(600_000),
  })
  .strict()
  .refine((rule) => rule.votes <= rule.window, {
    message: "votes must not exceed window",
    path: ["votes"],
  });

export const VIOLATION_RULE_SCHEMAS = Object.freeze({
  NO_FACE: NoFaceRuleSchema,
  MULTIPLE_FACES: MultipleFacesRuleSchema,
  FACE_MISMATCH: FaceMismatchRuleSchema,
  GAZE_AWAY: AttentionRuleSchema,
  HEAD_TURNED: AttentionRuleSchema,
  EYES_CLOSED: AttentionRuleSchema,
  LIGHTING_ISSUE: QualityRuleSchema,
  PHONE_DETECTED: ObjectRuleSchema,
});

export const ViolationsConfigSchema = z
  .object({
    /** Engine instance whose FACE_COUNT observations feed the rules. */
    sourceEngineId: z.string().min(1),
    /**
     * Frames further apart than this break continuity (engine stalled or restarted, page hidden,
     * detection stopped): pending conditions are dropped and active violations end. Must be
     * larger than the source engine's frame interval.
     */
    maxGapMs: z.number().int().min(100).max(60_000),
    /** Violations kept in the history; the oldest are dropped first. */
    historySize: z.number().int().min(1).max(10_000),
    rules: z
      .object({
        NO_FACE: NoFaceRuleSchema,
        MULTIPLE_FACES: MultipleFacesRuleSchema,
        FACE_MISMATCH: FaceMismatchRuleSchema,
        GAZE_AWAY: AttentionRuleSchema,
        HEAD_TURNED: AttentionRuleSchema,
        EYES_CLOSED: AttentionRuleSchema,
        LIGHTING_ISSUE: QualityRuleSchema,
        PHONE_DETECTED: ObjectRuleSchema,
      })
      .strict(),
  })
  .strict();

/** @typedef {z.infer<typeof ViolationsConfigSchema>} ViolationsConfig */
/**
 * @typedef {z.infer<typeof NoFaceRuleSchema> & { minFaces?: number, similarityThreshold?: number,
 *   escalateAfterMs?: number | null, escalatedSeverity?: 'low' | 'medium' | 'high',
 *   maxGapMs?: number, label?: string, minScore?: number, votes?: number,
 *   window?: number }} ViolationRuleConfig
 */

/** Strictness presets of the attention rules; "custom" after any manual change. */
export const ATTENTION_PRESETS = /** @type {const} */ (["lenient", "balanced", "strict", "custom"]);

/**
 * How attention samples are classified. All angles are degrees, from the person's point of
 * view (see src/engines/face/faceGeometry.js), and relative to their own baseline: the
 * calibration, or until then a baseline learned from the first seconds of detection.
 */
export const AttentionConfigSchema = z
  .object({
    /** Engine instance whose HEAD_POSE, EYE_GAZE, and EYE_STATE observations are used. */
    sourceEngineId: z.string().min(1),
    preset: z.enum(ATTENTION_PRESETS),
    /**
     * Screen extent around the baseline gaze direction when there is no calibration, as seen
     * from the person: a 14–15" laptop at 50–60 cm spans about ±17° horizontally and 20°
     * vertically. The calibration replaces these with the measured corners.
     */
    defaultScreen: z
      .object({
        leftDeg: z.number().min(1).max(90),
        rightDeg: z.number().min(1).max(90),
        upDeg: z.number().min(1).max(90),
        downDeg: z.number().min(1).max(90),
      })
      .strict(),
    /** Tolerance added around the screen on every side. */
    marginDeg: z.number().min(0).max(45),
    /** Extra tolerance below the screen (keyboard, glancing down while thinking). */
    extraDownMarginDeg: z.number().min(0).max(45),
    /**
     * Spatial hysteresis: after leaving the screen area, the gaze counts as back only once it
     * is this far inside again, so jitter on the edge does not split one look into many.
     */
    returnMarginDeg: z.number().min(0).max(20),
    /** Head rotation from the baseline head pose at which HEAD_TURNED's condition holds. */
    head: z
      .object({
        maxYawDeg: z.number().min(1).max(90),
        maxPitchUpDeg: z.number().min(1).max(90),
        maxPitchDownDeg: z.number().min(1).max(90),
      })
      .strict(),
    eyes: z
      .object({
        /** Mean MediaPipe blink score of both eyes at which the eyes count as closed. */
        closedBlinkScore: z.number().min(0).max(1),
        /**
         * The eye aspect ratio must also be at most this fraction of the person's open-eye
         * value (from the baseline), so naturally narrow eyes do not count as closed.
         */
        closedEarRatio: z.number().min(0).max(1),
        /**
         * Lids drop when looking down, which looks like closing. With the head this far below
         * its baseline, the eye state is left undecided (GAZE_AWAY covers looking down).
         */
        undecidedHeadDownDeg: z.number().min(0).max(90),
        /** Gaze is undecided when the narrower eye is smaller than this (face too far). */
        minEyeWidthPx: z.number().min(0).max(500),
        /** Closures shorter than this are counted as blinks. */
        blinkMaxMs: z.number().int().min(0).max(5000),
      })
      .strict(),
    baseline: z
      .object({
        /** Without a calibration, the baseline is learned over this long after start. */
        learnMs: z.number().int().min(1000).max(600_000),
        /** Usable frames needed before the learned baseline is used. */
        minSamples: z.number().int().min(1).max(10_000),
      })
      .strict(),
    calibration: z
      .object({
        /** Time after a target appears before samples are taken (eyes and head move there). */
        settleMs: z.number().int().min(0).max(10_000),
        /** Sampling time per target. */
        sampleMs: z.number().int().min(100).max(10_000),
        /** Usable frames needed per target. */
        minSamples: z.number().int().min(1).max(100),
        /** Standard deviation of the gaze per target above which the target is repeated. */
        maxSpreadDeg: z.number().min(0.1).max(30),
        /** Attempts per target before the calibration fails. */
        maxAttempts: z.number().int().min(1).max(10),
        /** Targets are placed this fraction of the viewport in from its edges. */
        insetRatio: z.number().min(0).max(0.4),
      })
      .strict(),
    /** Recent samples kept for the live gaze chart. */
    trailSize: z.number().int().min(10).max(5000),
  })
  .strict();

/** @typedef {z.infer<typeof AttentionConfigSchema>} AttentionConfig */

/**
 * Limits for the image-quality assessment (src/quality/qualityModel.js). Luma is Rec. 709 of
 * gamma-encoded pixels, 0–255; sharpness is the contrast-normalized Laplacian variance of the
 * face crop at the engine's `faceCropWidth` (112 px). Every value is a starting point.
 */
export const ImageQualityLabConfigSchema = z
  .object({
    /** Engine instance whose FRAME_QUALITY and FACE_QUALITY observations are assessed. */
    sourceEngineId: z.string().min(1),
    /** Engine instance whose latest face box is passed to the image-quality engine. */
    faceSourceEngineId: z.string().min(1),
    lighting: z
      .object({
        /** Mean face luma below this is dark (the identity enrollment gate uses 60). */
        minFaceLuma: z.number().min(0).max(255),
        /** Mean face luma above this is too bright (the enrollment gate uses 200). */
        maxFaceLuma: z.number().min(0).max(255),
        /** Share of crushed face pixels above which the face is dark. */
        maxFaceDarkFraction: z.number().min(0).max(1),
        /** Share of blown-out face pixels above which the face is too bright. */
        maxFaceBrightFraction: z.number().min(0).max(1),
        /** RMS contrast of the face below this is flat (fog, strong diffuse glare). */
        minFaceContrast: z.number().min(0).max(128),
        /** Backlit: face mean below this fraction of the background mean ... */
        backlitRatio: z.number().min(0).max(1),
        /** ... and the background at least this bright (a window or lamp behind the person). */
        minBacklitBackgroundLuma: z.number().min(0).max(255),
        /** Without a face: frame mean below this is dark (camera covered, unlit room). */
        minFrameLuma: z.number().min(0).max(255),
        /** Without a face: frame mean above this is blown out. */
        maxFrameLuma: z.number().min(0).max(255),
      })
      .strict(),
    image: z
      .object({
        /**
         * Contrast-normalized sharpness of the 112 px face crop (Laplacian variance / luma
         * variance) below this is blurry. On a portrait: 0.08 (frame read at 640 px) to 0.28
         * (1280 px) sharp, 0.0017–0.0018 blurred (5 px Gaussian).
         */
        minFaceSharpness: z.number().min(0).max(100),
        /** Face narrower than this in camera pixels is too small for the face models. */
        minFaceWidthPx: z.number().min(0).max(8192),
        /** Face narrower than this fraction of the frame width is too far away. */
        minFaceWidthRatio: z.number().min(0).max(1),
        /** Camera frames narrower than this are low resolution. */
        minSourceWidth: z.number().int().min(0).max(8192),
      })
      .strict(),
    /** Recent samples kept for the live chart. */
    historySize: z.number().int().min(10).max(5000),
  })
  .strict()
  .refine((c) => c.lighting.minFaceLuma <= c.lighting.maxFaceLuma, {
    message: "minFaceLuma must not exceed maxFaceLuma",
    path: ["lighting", "maxFaceLuma"],
  })
  .refine((c) => c.lighting.minFrameLuma <= c.lighting.maxFrameLuma, {
    message: "minFrameLuma must not exceed maxFrameLuma",
    path: ["lighting", "maxFrameLuma"],
  });

/** @typedef {z.infer<typeof ImageQualityLabConfigSchema>} ImageQualityLabConfig */

export const ObjectsLabConfigSchema = z
  .object({
    /**
     * Object engine instance whose detections feed PHONE_DETECTED. The other
     * object engines run for comparison only.
     */
    sourceEngineId: z.string().min(1),
    /** Recent samples per engine kept for the comparison panel. */
    historySize: z.number().int().min(10).max(5000),
  })
  .strict();

/** @typedef {z.infer<typeof ObjectsLabConfigSchema>} ObjectsLabConfig */

/**
 * Requirements a face embedding must meet before it is used. Every value is a starting point;
 * the Identity panel shows the measured value of each check next to its limit.
 */
export const QualityGateSchema = z
  .object({
    /** Exactly one face in the frame (otherwise the largest face is used). */
    requireSingleFace: z.boolean(),
    /** Minimum YuNet score of the embedded face. */
    minScore: z.number().min(0).max(1),
    /** Minimum distance between the eyes in frame pixels (face size and distance proxy). */
    minInterEyePx: z.number().min(0).max(4000),
    /** Maximum head roll (tilt of the eye line), degrees. */
    maxAbsRollDeg: z.number().min(0).max(180),
    /**
     * Maximum |yaw proxy|: nose offset from the eye midpoint along the eye line, in eye
     * distances. 0 when frontal and growing as the head turns; uncalibrated (the value at a
     * given angle depends on face shape).
     */
    maxAbsYawRatio: z.number().min(0).max(10),
    /** Mean luma of the aligned 112×112 crop, 0–255. */
    minBrightness: z.number().min(0).max(255),
    maxBrightness: z.number().min(0).max(255),
    /** Laplacian variance of the aligned crop; lower is blurrier. */
    minSharpness: z.number().min(0).max(1_000_000),
    /** The whole face box lies inside the frame. */
    requireInFrame: z.boolean(),
  })
  .strict()
  .refine((gate) => gate.minBrightness <= gate.maxBrightness, {
    message: "minBrightness must not exceed maxBrightness",
    path: ["maxBrightness"],
  });

/** @typedef {z.infer<typeof QualityGateSchema>} QualityGate */

export const IdentityConfigSchema = z
  .object({
    /** Engine instance whose FACE_EMBEDDING results feed enrollment, verification, calibration. */
    sourceEngineId: z.string().min(1),
    enrollment: z
      .object({
        /** Embeddings averaged into the reference template. */
        samples: z.number().int().min(1).max(50),
        /** Minimum time between two accepted samples, so they are not near-identical frames. */
        minIntervalMs: z.number().int().min(0).max(10_000),
        timeoutMs: z.number().int().min(1000).max(600_000),
        /**
         * Every sample must reach this cosine similarity to the resulting template; otherwise
         * the enrollment is refused (for example when another person entered the frame).
         */
        minSampleSimilarity: z.number().min(-1).max(1),
        gate: QualityGateSchema,
      })
      .strict(),
    verification: z
      .object({
        /** Frames failing this gate are not compared (they do not count for FACE_MISMATCH). */
        gate: QualityGateSchema,
        /** Recent comparisons kept for the live chart. */
        historySize: z.number().int().min(10).max(5000),
      })
      .strict(),
    calibration: z
      .object({
        /** Embeddings per capture; frames must pass the verification gate. */
        samplesPerCapture: z.number().int().min(1).max(50),
        minIntervalMs: z.number().int().min(0).max(10_000),
        timeoutMs: z.number().int().min(1000).max(600_000),
      })
      .strict(),
  })
  .strict();

/** @typedef {z.infer<typeof IdentityConfigSchema>} IdentityConfig */

export const LabConfigSchema = z
  .object({
    camera: CameraConfigSchema,
    monitor: MonitorConfigSchema,
    engines: z.array(EngineInstanceSchema).min(1),
    violations: ViolationsConfigSchema,
    identity: IdentityConfigSchema,
    attention: AttentionConfigSchema,
    imageQuality: ImageQualityLabConfigSchema,
    objects: ObjectsLabConfigSchema,
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set();
    config.engines.forEach((engine, index) => {
      if (seen.has(engine.id)) {
        context.addIssue({
          code: "custom",
          path: ["engines", index, "id"],
          message: `duplicate engine id "${engine.id}"`,
        });
      }
      seen.add(engine.id);
    });
    for (const path of [
      ["violations", "sourceEngineId"],
      ["identity", "sourceEngineId"],
      ["attention", "sourceEngineId"],
      ["imageQuality", "sourceEngineId"],
      ["imageQuality", "faceSourceEngineId"],
      ["objects", "sourceEngineId"],
    ]) {
      const id = /** @type {string} */ (
        /** @type {Record<string, any>} */ (config)[path[0]][path[1]]
      );
      if (!seen.has(id)) {
        context.addIssue({ code: "custom", path, message: `no engine with id "${id}"` });
      }
    }
  });

/** @typedef {z.infer<typeof LabConfigSchema>} LabConfig */

/**
 * @param {unknown} input
 * @returns {LabConfig}
 */
export function validateLabConfig(input) {
  return parseConfig(LabConfigSchema, input, "lab configuration");
}

/**
 * @param {unknown} input
 * @returns {SchedulerConfig}
 */
export function validateSchedulerConfig(input) {
  return parseConfig(SchedulerConfigSchema, input, "scheduler configuration");
}

/**
 * @param {ViolationType} type
 * @param {unknown} input
 * @returns {ViolationRuleConfig}
 */
export function validateViolationRule(type, input) {
  const schema = VIOLATION_RULE_SCHEMAS[type];
  if (!schema) throw new TypeError(`Unknown violation type "${type}"`);
  return parseConfig(schema, input, `${type} rule`);
}

/**
 * @param {unknown} input
 * @param {string} [label]
 * @returns {QualityGate}
 */
export function validateQualityGate(input, label = "quality gate") {
  return parseConfig(QualityGateSchema, input, label);
}

/**
 * @param {unknown} input
 * @returns {AttentionConfig}
 */
export function validateAttentionConfig(input) {
  return parseConfig(AttentionConfigSchema, input, "attention configuration");
}

/**
 * @param {unknown} input
 * @returns {ImageQualityLabConfig}
 */
export function validateImageQualityConfig(input) {
  return parseConfig(ImageQualityLabConfigSchema, input, "image quality configuration");
}
