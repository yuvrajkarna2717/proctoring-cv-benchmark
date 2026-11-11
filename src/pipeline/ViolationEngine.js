import { VIOLATION_TYPES, validateViolationRule } from "../config/schema.js";
import { TemporalCondition } from "./TemporalCondition.js";

/**
 * Conditions per violation type. Engines never decide violations: face rules read the
 * FACE_COUNT observation of each frame, and the identity rule reads the similarity the main
 * thread computed between a frame's embedding and the enrolled reference.
 *
 * `measure` is what the TemporalCondition tracks as `peak` while the condition holds: the face
 * count, or the negated similarity (so the peak is the lowest similarity).
 */
const RULE_DEFINITIONS = Object.freeze({
  NO_FACE: {
    label: "No face in view",
    input: "face-count",
    /** @param {number} faceCount */
    test: (faceCount) => faceCount === 0,
    /** @param {number} faceCount */
    measure: (faceCount) => faceCount,
  },
  MULTIPLE_FACES: {
    label: "More than one face in view",
    input: "face-count",
    /**
     * @param {number} faceCount
     * @param {{ minFaces?: number }} rule
     */
    test: (faceCount, rule) => faceCount >= /** @type {number} */ (rule.minFaces),
    /** @param {number} faceCount */
    measure: (faceCount) => faceCount,
  },
  FACE_MISMATCH: {
    label: "Face does not match the enrolled reference",
    input: "identity",
    /**
     * @param {number} similarity
     * @param {{ similarityThreshold?: number }} rule
     */
    test: (similarity, rule) => similarity < /** @type {number} */ (rule.similarityThreshold),
    /** @param {number} similarity */
    measure: (similarity) => -similarity,
  },
});

/** @typedef {'face-count' | 'identity'} RuleInput */

/**
 * @typedef {import('../config/schema.js').ViolationType} ViolationType
 *
 * @typedef {Object} Violation
 * @property {string} id
 * @property {ViolationType} type
 * @property {'low' | 'medium' | 'high'} severity
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
 * @property {boolean} pageHidden the page was hidden at some point during the violation
 * @property {string} sourceEngineId
 *
 * @typedef {{ type: 'violation-start' | 'violation-end', violation: Violation }} ViolationEvent
 */

function emptyStats() {
  return {
    violations: 0,
    ended: 0,
    totalDurationMs: 0,
    longestMs: 0,
    endReasons: { cleared: 0, "data-gap": 0, stopped: 0, disabled: 0, "reference-changed": 0 },
  };
}

/**
 * The rule-specific measure fields of a violation, from the condition's peak.
 *
 * @param {import('../config/schema.js').ViolationType} type
 * @param {number} peak
 */
function measureFields(type, peak) {
  return RULE_DEFINITIONS[type].input === "identity"
    ? { maxFaceCount: null, minSimilarity: -peak }
    : { maxFaceCount: peak, minSimilarity: null };
}

/**
 * Temporal evaluation and violation engine. Face rules consume detection results of one source
 * engine; the identity rule consumes similarity samples passed in by the caller. Each enabled
 * rule is evaluated with a {@link TemporalCondition}; the engine keeps active violations, a
 * bounded history, and per-rule statistics.
 */
export class ViolationEngine {
  /** @type {import('../config/schema.js').ViolationsConfig} */
  #config;
  /** @type {string | null} engine whose embeddings the identity samples come from */
  #identitySourceEngineId;
  #identityFramesEvaluated = 0;
  /** @type {number | null} */
  #lastIdentityAt = null;
  /** @type {Map<ViolationType, TemporalCondition>} */
  #conditions = new Map();
  /** @type {Map<ViolationType, Violation>} */
  #active = new Map();
  /** @type {Violation[]} */
  #history = [];
  /** @type {Map<ViolationType, ReturnType<typeof emptyStats>>} */
  #stats = new Map();
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
   * @param {{ identitySourceEngineId?: string | null }} [options]
   */
  constructor(config, { identitySourceEngineId = null } = {}) {
    this.#config = structuredClone(config);
    this.#identitySourceEngineId = identitySourceEngineId;
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
   * @param {RuleInput} input
   * @param {number} at
   * @param {number} value face count or similarity
   */
  #evaluate(input, at, value) {
    for (const type of VIOLATION_TYPES) {
      const definition = RULE_DEFINITIONS[type];
      const rule = this.#config.rules[type];
      if (definition.input !== input || !rule.enabled) continue;
      const condition = /** @type {TemporalCondition} */ (this.#conditions.get(type));
      const holds = definition.test(value, rule);
      for (const transition of condition.update(at, holds, definition.measure(value))) {
        this.#apply(type, transition);
      }
      const active = this.#active.get(type);
      if (active && active.confirmedAt !== at) {
        // pageHidden needs no update here: setPageHidden() flags active violations and #apply()
        // flags new ones.
        const { samples, peak } = condition.getState();
        this.#replace({
          ...active,
          frames: samples,
          ...measureFields(type, peak),
          durationMs: at - active.startedAt,
        });
      }
    }
  }

  /**
   * Ends the active violation of one rule now, for example FACE_MISMATCH when the reference it
   * compares against is deleted or replaced.
   *
   * @param {import('../config/schema.js').ViolationType} type
   * @param {import('./TemporalCondition.js').EndReason} reason
   */
  interruptRule(type, reason) {
    const end = /** @type {TemporalCondition} */ (this.#conditions.get(type)).interrupt(reason);
    if (end) this.#apply(type, end);
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
        if (end) this.#apply(type, end);
      }
    }
  }

  /**
   * Stops evaluation now (detection stopped, source engine unloaded or restarted).
   * @param {'stopped' | 'data-gap'} reason
   */
  interrupt(reason) {
    for (const type of VIOLATION_TYPES) {
      const end = /** @type {TemporalCondition} */ (this.#conditions.get(type)).interrupt(reason);
      if (end) this.#apply(type, end);
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
    });
    if (!next.enabled) {
      const end = condition.interrupt("disabled");
      if (end) this.#apply(type, end);
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
          maxGapMs: this.#config.maxGapMs,
        }),
      );
      this.#stats.set(type, emptyStats());
    }
    this.#active.clear();
    this.#history = [];
    this.#framesEvaluated = 0;
    this.#lastFrameAt = null;
    this.#identityFramesEvaluated = 0;
    this.#lastIdentityAt = null;
  }

  /** JSON-serializable view. */
  getSnapshot() {
    return {
      sourceEngineId: this.#config.sourceEngineId,
      identitySourceEngineId: this.#identitySourceEngineId,
      maxGapMs: this.#config.maxGapMs,
      framesEvaluated: this.#framesEvaluated,
      lastFrameAt: this.#lastFrameAt,
      identityFramesEvaluated: this.#identityFramesEvaluated,
      lastIdentityAt: this.#lastIdentityAt,
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
   */
  #apply(type, transition) {
    const rule = this.#config.rules[type];
    if (transition.type === "start") {
      /** @type {Violation} */
      const violation = {
        id: `${type}-${this.#nextId++}`,
        type,
        severity: rule.severity,
        status: "active",
        startedAt: transition.startedAt,
        confirmedAt: transition.confirmedAt,
        endedAt: null,
        durationMs: transition.confirmedAt - transition.startedAt,
        endReason: null,
        frames: transition.samples,
        ...measureFields(type, transition.peak),
        pageHidden: this.#wasHiddenSince(transition.startedAt),
        sourceEngineId:
          RULE_DEFINITIONS[type].input === "identity"
            ? (this.#identitySourceEngineId ?? "unknown")
            : this.#config.sourceEngineId,
      };
      this.#active.set(type, violation);
      this.#history.push(violation);
      if (this.#history.length > this.#config.historySize) this.#history.shift();
      const stats = /** @type {ReturnType<typeof emptyStats>} */ (this.#stats.get(type));
      stats.violations += 1;
      this.#emit({ type: "violation-start", violation: { ...violation } });
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
