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
 * violations source engine; FACE_MISMATCH from identity comparisons (see IdentityConfigSchema).
 */
export const VIOLATION_TYPES = /** @type {const} */ ([
  "NO_FACE",
  "MULTIPLE_FACES",
  "FACE_MISMATCH",
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

export const VIOLATION_RULE_SCHEMAS = Object.freeze({
  NO_FACE: NoFaceRuleSchema,
  MULTIPLE_FACES: MultipleFacesRuleSchema,
  FACE_MISMATCH: FaceMismatchRuleSchema,
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
      })
      .strict(),
  })
  .strict();

/** @typedef {z.infer<typeof ViolationsConfigSchema>} ViolationsConfig */
/**
 * @typedef {z.infer<typeof NoFaceRuleSchema> & { minFaces?: number, similarityThreshold?: number }} ViolationRuleConfig
 */

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
