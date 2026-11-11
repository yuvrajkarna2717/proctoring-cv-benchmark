import { VIOLATION_TYPES, validateViolationRule } from "../config/schema.js";
import { GlanceCounter } from "./GlanceCounter.js";
import { TemporalCondition } from "./TemporalCondition.js";

/**
 * Conditions per violation type. Engines never decide violations: face rules read the
 * FACE_COUNT observation of each frame, the identity rule reads the similarity the main thread
 * computed between a frame's embedding and the enrolled reference, and the attention rules read
 * the samples the attention layer classified against the person's baseline.
 *
 * `read` returns whether the condition holds on a sample and the `measure` the
 * TemporalCondition tracks as `peak` while it holds: the face count, the negated similarity
 * (so the peak is the lowest similarity), the angle beyond the tolerated area, the eye closure,
 * or the glance count. It returns null when the sample says nothing about the rule (for
 * example gaze during a blink); such samples are skipped, like missing frames.
 *
 * @typedef {'face-count' | 'identity' | 'attention' | 'quality'} RuleInput
 * @typedef {import('../attention/attentionModel.js').AttentionSample} AttentionSample
 * @typedef {import('../attention/attentionModel.js').Direction} Direction
 * @typedef {import('../quality/qualityModel.js').QualitySample} QualitySample
 * @typedef {{ holds: boolean, measure: number, direction?: Direction | null,
 *   reasons?: string[] }} RuleReading
 */
const RULE_DEFINITIONS = Object.freeze({
  NO_FACE: {
    label: "No face in view",
    input: /** @type {RuleInput} */ ("face-count"),
    measureKind: "faces",
    /** @param {number} faceCount @returns {RuleReading} */
    read: (faceCount) => ({ holds: faceCount === 0, measure: faceCount }),
  },
  MULTIPLE_FACES: {
    label: "More than one face in view",
    input: /** @type {RuleInput} */ ("face-count"),
    measureKind: "faces",
    /**
     * @param {number} faceCount
     * @param {{ minFaces?: number }} rule
     * @returns {RuleReading}
     */
    read: (faceCount, rule) => ({
      holds: faceCount >= /** @type {number} */ (rule.minFaces),
      measure: faceCount,
    }),
  },
  FACE_MISMATCH: {
    label: "Face does not match the enrolled reference",
    input: /** @type {RuleInput} */ ("identity"),
    measureKind: "similarity",
    /**
     * @param {number} similarity
     * @param {{ similarityThreshold?: number }} rule
     * @returns {RuleReading}
     */
    read: (similarity, rule) => ({
      holds: similarity < /** @type {number} */ (rule.similarityThreshold),
      measure: -similarity,
    }),
  },
  GAZE_AWAY: {
    label: "Looking away from the screen",
    input: /** @type {RuleInput} */ ("attention"),
    measureKind: "excess",
    /** @param {AttentionSample} sample @returns {RuleReading | null} */
    read: ({ gaze }) =>
      gaze.state === "undecided"
        ? null
        : { holds: gaze.state === "away", measure: gaze.excessDeg ?? 0, direction: gaze.direction },
  },
  GAZE_AWAY_REPEATED: {
    label: "Repeated looks away toward the same side",
    input: /** @type {RuleInput} */ ("attention"),
    measureKind: "glances",
    /**
     * Uses the glance counter, which the engine updates before the rules are read.
     * @param {AttentionSample} sample
     * @param {unknown} _rule
     * @param {{ glances: { holds: boolean, count: number, direction: Direction | null } | null }} context
     * @returns {RuleReading | null}
     */
    read: (sample, _rule, context) =>
      sample.gaze.state === "undecided" || !context.glances
        ? null
        : {
            holds: context.glances.holds,
            measure: context.glances.count,
            direction: context.glances.direction,
          },
  },
  HEAD_TURNED: {
    label: "Head turned away from the screen",
    input: /** @type {RuleInput} */ ("attention"),
    measureKind: "excess",
    /** @param {AttentionSample} sample @returns {RuleReading | null} */
    read: ({ head }) =>
      head.state === "undecided"
        ? null
        : {
            holds: head.state === "turned",
            measure: head.excessDeg ?? 0,
            direction: head.direction,
          },
  },
  EYES_CLOSED: {
    label: "Eyes closed",
    input: /** @type {RuleInput} */ ("attention"),
    measureKind: "closure",
    /** @param {AttentionSample} sample @returns {RuleReading | null} */
    read: ({ eyes }) =>
      eyes.state === "undecided"
        ? null
        : { holds: eyes.state === "closed", measure: eyes.closure ?? 0 },
  },
  LIGHTING_ISSUE: {
    label: "Lighting unsuitable (dark, too bright, backlit, flat)",
    input: /** @type {RuleInput} */ ("quality"),
    measureKind: "reasons",
    /** @param {QualitySample} sample @returns {RuleReading | null} */
    read: ({ lighting }) =>
      lighting.state === "undecided"
        ? null
        : {
            holds: lighting.state === "issue",
            measure: lighting.reasons.length,
            reasons: lighting.reasons,
          },
  },
  LOW_IMAGE_QUALITY: {
    label: "Image unsuitable (blurry, face too small, low resolution)",
    input: /** @type {RuleInput} */ ("quality"),
    measureKind: "reasons",
    /** @param {QualitySample} sample @returns {RuleReading | null} */
    read: ({ image }) =>
      image.state === "undecided"
        ? null
        : { holds: image.state === "issue", measure: image.reasons.length, reasons: image.reasons },
  },
});

/** A quality sample this recent is stamped on violations of other rules as `imageIssues`. */
const IMAGE_ISSUE_MAX_AGE_MS = 3000;

const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * @typedef {import('../config/schema.js').ViolationType} ViolationType
 *
 * @typedef {Object} Violation
 * @property {string} id
 * @property {ViolationType} type
 * @property {'low' | 'medium' | 'high'} severity current severity (after any escalation)
 * @property {'low' | 'medium' | 'high'} initialSeverity severity when it started
 * @property {number | null} escalatedAt capture time of the frame that raised the severity
 * @property {'active' | 'ended'} status
 * @property {number} startedAt capture time of the first frame with the condition (epoch ms)
 * @property {number} confirmedAt capture time of the frame that confirmed the violation
 * @property {number | null} endedAt first frame without the condition, or for interrupted ends
 *   the last frame on which the condition was known
 * @property {number} durationMs endedAt (or the latest frame while active) − startedAt
 * @property {import('./TemporalCondition.js').EndReason | null} endReason
 * @property {number} frames frames with the condition during the violation
 * @property {number | null} maxFaceCount highest FACE_COUNT on those frames (face rules)
 * @property {number | null} minSimilarity lowest similarity on those frames (FACE_MISMATCH)
 * @property {number | null} maxExcessDeg GAZE_AWAY, HEAD_TURNED: largest angle beyond the
 *   tolerated area
 * @property {number | null} maxClosure EYES_CLOSED: highest mean blink score
 * @property {number | null} glanceCount GAZE_AWAY_REPEATED: most glances in the window
 * @property {Direction | null} direction attention rules: direction at the largest measure
 * @property {'calibration' | 'learned' | null} baseline attention rules: what the angles were
 *   measured against
 * @property {string[] | null} reasons LIGHTING_ISSUE, LOW_IMAGE_QUALITY: reasons seen during
 *   the violation, most frequent first
 * @property {string[] | null} imageIssues other rules: lighting and image reasons of the latest
 *   image-quality sample when the violation started ([] = image fine; null = no sample in the
 *   last 3 s)
 * @property {boolean} pageHidden the page was hidden at some point during the violation
 * @property {string} sourceEngineId
 *
 * @typedef {{ type: 'violation-start' | 'violation-end' | 'violation-escalated', violation: Violation }} ViolationEvent
 */

function emptyStats() {
  return {
    violations: 0,
    ended: 0,
    escalated: 0,
    totalDurationMs: 0,
    longestMs: 0,
    endReasons: {
      cleared: 0,
      "data-gap": 0,
      stopped: 0,
      disabled: 0,
      "reference-changed": 0,
      "baseline-changed": 0,
    },
  };
}

/**
 * The rule-specific measure fields of a violation, from the condition's peak.
 *
 * @param {ViolationType} type
 * @param {number} peak
 */
function measureFields(type, peak) {
  const kind = RULE_DEFINITIONS[type].measureKind;
  return {
    maxFaceCount: kind === "faces" ? peak : null,
    minSimilarity: kind === "similarity" ? -peak : null,
    maxExcessDeg: kind === "excess" ? Math.round(peak * 10) / 10 : null,
    maxClosure: kind === "closure" ? Math.round(peak * 1000) / 1000 : null,
    glanceCount: kind === "glances" ? peak : null,
  };
}

/** @param {Map<string, number> | undefined} counts @returns {string[]} */
function byFrequency(counts) {
  return counts ? [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason]) => reason) : [];
}

/**
 * Temporal evaluation and violation engine. Face rules consume detection results of one source
 * engine; the identity and attention rules consume samples passed in by the caller. Each
 * enabled rule is evaluated with a {@link TemporalCondition}; the engine keeps active
 * violations, a bounded history, and per-rule statistics.
 */
export class ViolationEngine {
  /** @type {import('../config/schema.js').ViolationsConfig} */
  #config;
  /** @type {string | null} engine whose embeddings the identity samples come from */
  #identitySourceEngineId;
  /** @type {string | null} engine whose observations the attention samples come from */
  #attentionSourceEngineId;
  #identityFramesEvaluated = 0;
  /** @type {number | null} */
  #lastIdentityAt = null;
  #attentionFramesEvaluated = 0;
  /** @type {number | null} */
  #lastAttentionAt = null;
  /** @type {Map<ViolationType, TemporalCondition>} */
  #conditions = new Map();
  /**
   * Largest measure and its direction in the current run of each attention rule (pending or
   * active), for the violation's `direction`.
   * @type {Map<ViolationType, { measure: number, direction: Direction | null }>}
   */
  #runPeaks = new Map();
  /** @type {Map<ViolationType, Map<string, number>>} reasons in the current run of quality rules */
  #runReasons = new Map();
  /** @type {string | null} engine whose observations the quality samples come from */
  #qualitySourceEngineId;
  #qualityFramesEvaluated = 0;
  /** @type {QualitySample | null} */
  #lastQuality = null;
  /** @type {Map<ViolationType, Violation>} */
  #active = new Map();
  /** @type {Violation[]} */
  #history = [];
  /** @type {Map<ViolationType, ReturnType<typeof emptyStats>>} */
  #stats = new Map();
  /** @type {GlanceCounter} */
  #glances;
  #nextId = 1;
  #framesEvaluated = 0;
  /** @type {number | null} */
  #lastFrameAt = null;
  /** @type {number | null} time the page was last hidden, null while visible */
  #hiddenSince = null;
  /** @type {number | null} */
  #lastHiddenEndedAt = null;
  /** @type {Set<(event: ViolationEvent) => void>} */
  #listeners = new Set();

  /**
   * @param {import('../config/schema.js').ViolationsConfig} config validated configuration
   * @param {{ identitySourceEngineId?: string | null, attentionSourceEngineId?: string | null,
   *   qualitySourceEngineId?: string | null }} [options]
   */
  constructor(
    config,
    {
      identitySourceEngineId = null,
      attentionSourceEngineId = null,
      qualitySourceEngineId = null,
    } = {},
  ) {
    this.#config = structuredClone(config);
    this.#identitySourceEngineId = identitySourceEngineId;
    this.#attentionSourceEngineId = attentionSourceEngineId;
    this.#qualitySourceEngineId = qualitySourceEngineId;
    this.#glances = new GlanceCounter({ maxGapMs: this.#config.maxGapMs });
    this.#reset();
  }

  get sourceEngineId() {
    return this.#config.sourceEngineId;
  }

  /**
   * @param {(event: ViolationEvent) => void} listener
   * @returns {() => void} unsubscribe
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Evaluates one detection result. Results of other engines and results without a FACE_COUNT
   * observation are ignored.
   *
   * @param {Pick<import('../engines/EngineContract.js').DetectionResult, 'engine' | 'frameCaptureTime' | 'observations'>} result
   */
  observe(result) {
    if (result.engine !== this.#config.sourceEngineId) return;
    const countObservation = result.observations.find((o) => o.type === "FACE_COUNT");
    const faceCount = countObservation?.value;
    if (typeof faceCount !== "number" || !Number.isFinite(faceCount)) return;
    const at = result.frameCaptureTime;
    this.#framesEvaluated += 1;
    this.#lastFrameAt = at;
    this.#evaluate("face-count", at, faceCount);
  }

  /**
   * Evaluates one identity comparison: the cosine similarity between the embedding of a frame
   * captured at `at` and the enrolled reference. Frames without a usable embedding (no face,
   * failed quality gate, no reference) are not passed in; they count as missing frames.
   *
   * @param {{ at: number, similarity: number }} sample
   */
  observeIdentity({ at, similarity }) {
    if (!Number.isFinite(similarity)) return;
    this.#identityFramesEvaluated += 1;
    this.#lastIdentityAt = at;
    this.#evaluate("identity", at, similarity);
  }

  /**
   * Evaluates one attention sample (a frame classified against the person's baseline). Parts
   * of the sample that are "undecided" are skipped by the rules that read them.
   *
   * @param {AttentionSample} sample
   */
  observeAttention(sample) {
    this.#attentionFramesEvaluated += 1;
    this.#lastAttentionAt = sample.at;
    this.#evaluate("attention", sample.at, sample);
  }

  /**
   * Evaluates one image-quality sample, and keeps it to stamp on violations of other rules.
   *
   * @param {QualitySample} sample
   */
  observeQuality(sample) {
    this.#qualityFramesEvaluated += 1;
    this.#lastQuality = sample;
    this.#evaluate("quality", sample.at, sample);
  }

  /**
   * Reasons of the latest quality sample, if it is recent relative to `at`.
   * @param {number} at
   * @returns {string[] | null}
   */
  #imageIssuesAt(at) {
    const sample = this.#lastQuality;
    if (!sample || Math.abs(at - sample.at) > IMAGE_ISSUE_MAX_AGE_MS) return null;
    return [...sample.lighting.reasons, ...sample.image.reasons];
  }

  /**
   * @param {RuleInput} input
   * @param {number} at
   * @param {any} value face count, similarity, or attention sample
   */
  #evaluate(input, at, value) {
    /** @type {{ glances: ReturnType<GlanceCounter['update']> | null }} */
    const context = { glances: null };
    const repeated = this.#config.rules.GAZE_AWAY_REPEATED;
    if (input === "attention" && repeated.enabled && value.gaze.state !== "undecided") {
      context.glances = this.#glances.update(at, value.gaze.state, value.gaze.direction, repeated);
    }
    for (const type of VIOLATION_TYPES) {
      const definition = RULE_DEFINITIONS[type];
      const rule = this.#config.rules[type];
      if (definition.input !== input || !rule.enabled) continue;
      const reading = definition.read(value, /** @type {any} */ (rule), context);
      if (!reading) continue;
      const condition = /** @type {TemporalCondition} */ (this.#conditions.get(type));
      if (condition.state === "inactive") this.#clearRun(type);
      if (reading.holds && input === "attention") {
        const peak = this.#runPeaks.get(type);
        if (!peak || reading.measure > peak.measure) {
          this.#runPeaks.set(type, {
            measure: reading.measure,
            direction: reading.direction ?? null,
          });
        }
      }
      if (reading.holds && reading.reasons) {
        const counts = this.#runReasons.get(type) ?? new Map();
        for (const reason of reading.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
        this.#runReasons.set(type, counts);
      }
      for (const transition of condition.update(at, reading.holds, reading.measure)) {
        this.#apply(type, transition, input === "attention" ? value.baseline : null);
      }
      const active = this.#active.get(type);
      if (active && active.confirmedAt !== at) {
        // pageHidden needs no update here: setPageHidden() flags active violations and #apply()
        // flags new ones.
        const { samples, peak } = condition.getState();
        this.#replace(
          this.#escalate(
            {
              ...active,
              frames: samples,
              ...measureFields(type, peak),
              direction: this.#runPeaks.get(type)?.direction ?? active.direction,
              ...(active.reasons ? { reasons: byFrequency(this.#runReasons.get(type)) } : {}),
              durationMs: at - active.startedAt,
            },
            at,
          ),
        );
      }
      if (condition.state === "inactive") this.#clearRun(type);
    }
  }

  /** Forgets the per-run details (direction, reasons) of a rule. @param {ViolationType} type */
  #clearRun(type) {
    this.#runPeaks.delete(type);
    this.#runReasons.delete(type);
  }

  /**
   * Raises the severity of an active violation once it has lasted `escalateAfterMs`.
   *
   * @param {Violation} violation
   * @param {number} at
   */
  #escalate(violation, at) {
    const rule = /** @type {Record<string, any>} */ (this.#config.rules[violation.type]);
    if (
      rule.escalateAfterMs === null ||
      rule.escalateAfterMs === undefined ||
      violation.escalatedAt !== null ||
      violation.durationMs < rule.escalateAfterMs ||
      SEVERITY_RANK[/** @type {'low'} */ (rule.escalatedSeverity)] <=
        SEVERITY_RANK[violation.severity]
    ) {
      return violation;
    }
    const escalated = { ...violation, severity: rule.escalatedSeverity, escalatedAt: at };
    /** @type {ReturnType<typeof emptyStats>} */ (this.#stats.get(violation.type)).escalated += 1;
    this.#emit({ type: "violation-escalated", violation: { ...escalated } });
    return escalated;
  }

  /**
   * Ends the active violation of one rule now, for example FACE_MISMATCH when the reference it
   * compares against is deleted or replaced.
   *
   * @param {ViolationType} type
   * @param {import('./TemporalCondition.js').EndReason} reason
   */
  interruptRule(type, reason) {
    const end = /** @type {TemporalCondition} */ (this.#conditions.get(type)).interrupt(reason);
    this.#clearRun(type);
    if (type === "GAZE_AWAY_REPEATED") this.#glances.reset();
    if (end) this.#apply(type, end, null);
  }

  /**
   * Ends violations whose source has gone silent for longer than maxGapMs. Call periodically.
   * @param {number} now epoch ms
   */
  tick(now) {
    for (const type of VIOLATION_TYPES) {
      const condition = /** @type {TemporalCondition} */ (this.#conditions.get(type));
      if (condition.isStale(now)) {
        const end = condition.interrupt("data-gap");
        this.#clearRun(type);
        if (end) this.#apply(type, end, null);
      }
    }
  }

  /**
   * Stops evaluation now (detection stopped, source engine unloaded or restarted).
   * @param {'stopped' | 'data-gap'} reason
   */
  interrupt(reason) {
    this.#glances.reset();
    for (const type of VIOLATION_TYPES) {
      const end = /** @type {TemporalCondition} */ (this.#conditions.get(type)).interrupt(reason);
      this.#clearRun(type);
      if (end) this.#apply(type, end, null);
    }
  }

  /**
   * Page visibility context. Violations that overlap a hidden period are flagged, because
   * browsers deliver few or no frames for hidden pages.
   *
   * @param {boolean} hidden
   * @param {number} at epoch ms
   */
  setPageHidden(hidden, at) {
    if (hidden && this.#hiddenSince === null) {
      this.#hiddenSince = at;
      for (const violation of this.#active.values()) {
        if (!violation.pageHidden) this.#replace({ ...violation, pageHidden: true });
      }
    } else if (!hidden && this.#hiddenSince !== null) {
      this.#hiddenSince = null;
      this.#lastHiddenEndedAt = at;
    }
  }

  /**
   * Applies a partial rule configuration from the next frame on. Disabling a rule ends its
   * active violation with reason "disabled".
   *
   * @param {ViolationType} type
   * @param {Record<string, unknown>} patch
   */
  updateRule(type, patch) {
    const next = validateViolationRule(type, { ...this.#config.rules[type], ...patch });
    const condition = /** @type {TemporalCondition} */ (this.#conditions.get(type));
    this.#config.rules = { ...this.#config.rules, [type]: next };
    condition.updateOptions({
      minDurationMs: next.minDurationMs,
      clearAfterMs: next.clearAfterMs,
      cooldownMs: next.cooldownMs,
      ...(next.maxGapMs === undefined ? {} : { maxGapMs: next.maxGapMs }),
    });
    if (!next.enabled) {
      const end = condition.interrupt("disabled");
      this.#clearRun(type);
      if (type === "GAZE_AWAY_REPEATED") this.#glances.reset();
      if (end) this.#apply(type, end, null);
    }
    return { ...next };
  }

  /**
   * Starts a new session: drops active violations without emitting events and clears history,
   * statistics, cooldowns, and condition state. Rule configuration is kept.
   */
  clear() {
    this.#reset();
  }

  #reset() {
    for (const type of VIOLATION_TYPES) {
      const rule = this.#config.rules[type];
      this.#conditions.set(
        type,
        new TemporalCondition({
          minDurationMs: rule.minDurationMs,
          clearAfterMs: rule.clearAfterMs,
          cooldownMs: rule.cooldownMs,
          // Quality rules sample less often and carry their own gap limit.
          maxGapMs: /** @type {{ maxGapMs?: number }} */ (rule).maxGapMs ?? this.#config.maxGapMs,
        }),
      );
      this.#stats.set(type, emptyStats());
    }
    this.#runPeaks.clear();
    this.#runReasons.clear();
    this.#lastQuality = null;
    this.#qualityFramesEvaluated = 0;
    this.#glances.reset();
    this.#active.clear();
    this.#history = [];
    this.#framesEvaluated = 0;
    this.#lastFrameAt = null;
    this.#identityFramesEvaluated = 0;
    this.#lastIdentityAt = null;
    this.#attentionFramesEvaluated = 0;
    this.#lastAttentionAt = null;
  }

  /** JSON-serializable view. */
  getSnapshot() {
    return {
      sourceEngineId: this.#config.sourceEngineId,
      identitySourceEngineId: this.#identitySourceEngineId,
      attentionSourceEngineId: this.#attentionSourceEngineId,
      maxGapMs: this.#config.maxGapMs,
      framesEvaluated: this.#framesEvaluated,
      lastFrameAt: this.#lastFrameAt,
      identityFramesEvaluated: this.#identityFramesEvaluated,
      lastIdentityAt: this.#lastIdentityAt,
      attentionFramesEvaluated: this.#attentionFramesEvaluated,
      lastAttentionAt: this.#lastAttentionAt,
      qualitySourceEngineId: this.#qualitySourceEngineId,
      qualityFramesEvaluated: this.#qualityFramesEvaluated,
      glances: this.#glances.glances,
      pageHidden: this.#hiddenSince !== null,
      rules: VIOLATION_TYPES.map((type) => ({
        type,
        label: RULE_DEFINITIONS[type].label,
        input: RULE_DEFINITIONS[type].input,
        config: { ...this.#config.rules[type] },
        condition: /** @type {TemporalCondition} */ (this.#conditions.get(type)).getState(),
        stats: structuredClone(this.#stats.get(type)),
      })),
      active: [...this.#active.values()].map((violation) => ({ ...violation })),
      history: this.#history.map((violation) => ({ ...violation })),
    };
  }

  /**
   * @param {ViolationType} type
   * @param {import('./TemporalCondition.js').ConditionTransition} transition
   * @param {'calibration' | 'learned' | null} baseline of the attention sample, if any
   */
  #apply(type, transition, baseline) {
    const rule = this.#config.rules[type];
    const input = RULE_DEFINITIONS[type].input;
    if (transition.type === "start") {
      /** @type {Violation} */
      const violation = {
        id: `${type}-${this.#nextId++}`,
        type,
        severity: rule.severity,
        initialSeverity: rule.severity,
        escalatedAt: null,
        status: "active",
        startedAt: transition.startedAt,
        confirmedAt: transition.confirmedAt,
        endedAt: null,
        durationMs: transition.confirmedAt - transition.startedAt,
        endReason: null,
        frames: transition.samples,
        ...measureFields(type, transition.peak),
        direction: this.#runPeaks.get(type)?.direction ?? null,
        baseline: input === "attention" ? baseline : null,
        reasons: input === "quality" ? byFrequency(this.#runReasons.get(type)) : null,
        imageIssues: input === "quality" ? null : this.#imageIssuesAt(transition.startedAt),
        pageHidden: this.#wasHiddenSince(transition.startedAt),
        sourceEngineId:
          input === "identity"
            ? (this.#identitySourceEngineId ?? "unknown")
            : input === "attention"
              ? (this.#attentionSourceEngineId ?? this.#config.sourceEngineId)
              : input === "quality"
                ? (this.#qualitySourceEngineId ?? "unknown")
                : this.#config.sourceEngineId,
      };
      const escalated = this.#escalateSilently(violation);
      this.#active.set(type, escalated);
      this.#history.push(escalated);
      if (this.#history.length > this.#config.historySize) this.#history.shift();
      const stats = /** @type {ReturnType<typeof emptyStats>} */ (this.#stats.get(type));
      stats.violations += 1;
      this.#emit({ type: "violation-start", violation: { ...escalated } });
      return;
    }
    const active = this.#active.get(type);
    if (!active) return;
    /** @type {Violation} */
    const ended = {
      ...active,
      status: "ended",
      endedAt: transition.endedAt,
      endReason: transition.reason,
      durationMs: transition.endedAt - active.startedAt,
      frames: transition.samples,
      ...measureFields(type, transition.peak),
      ...(active.reasons
        ? {
            reasons: this.#runReasons.has(type)
              ? byFrequency(this.#runReasons.get(type))
              : active.reasons,
          }
        : {}),
      pageHidden: active.pageHidden || this.#wasHiddenSince(active.startedAt),
    };
    this.#active.delete(type);
    this.#replaceInHistory(ended);
    const stats = /** @type {ReturnType<typeof emptyStats>} */ (this.#stats.get(type));
    stats.ended += 1;
    stats.totalDurationMs += ended.durationMs;
    stats.longestMs = Math.max(stats.longestMs, ended.durationMs);
    stats.endReasons[transition.reason] += 1;
    this.#emit({ type: "violation-end", violation: { ...ended } });
  }

  /**
   * A violation can already be long enough to escalate when it is confirmed (a cooldown delayed
   * its confirmation). It then starts escalated, without a separate event.
   *
   * @param {Violation} violation
   */
  #escalateSilently(violation) {
    const rule = /** @type {Record<string, any>} */ (this.#config.rules[violation.type]);
    if (
      rule.escalateAfterMs === null ||
      rule.escalateAfterMs === undefined ||
      violation.durationMs < rule.escalateAfterMs ||
      SEVERITY_RANK[/** @type {'low'} */ (rule.escalatedSeverity)] <=
        SEVERITY_RANK[violation.severity]
    ) {
      return violation;
    }
    /** @type {ReturnType<typeof emptyStats>} */ (this.#stats.get(violation.type)).escalated += 1;
    return { ...violation, severity: rule.escalatedSeverity, escalatedAt: violation.confirmedAt };
  }

  /** @param {Violation} violation an updated copy of an active violation */
  #replace(violation) {
    this.#active.set(violation.type, violation);
    this.#replaceInHistory(violation);
  }

  /** @param {Violation} violation */
  #replaceInHistory(violation) {
    for (let index = this.#history.length - 1; index >= 0; index -= 1) {
      if (this.#history[index].id === violation.id) {
        this.#history[index] = violation;
        return;
      }
    }
  }

  /** @param {number} since epoch ms */
  #wasHiddenSince(since) {
    return (
      this.#hiddenSince !== null ||
      (this.#lastHiddenEndedAt !== null && this.#lastHiddenEndedAt >= since)
    );
  }

  /** @param {ViolationEvent} event */
  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Violation listener failed", error);
      }
    }
  }
}
