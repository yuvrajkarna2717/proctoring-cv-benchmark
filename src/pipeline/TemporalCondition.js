/**
 * Turns a stream of timestamped boolean samples ("is the condition true in this frame?") into
 * episodes with a start and an end, using:
 *
 * - `minDurationMs`: the condition must hold on every sample for this long before an episode
 *   starts (measured from the first true sample). Shorter runs are counted as `suppressedShort`.
 * - `clearAfterMs` (hysteresis): an active episode ends only after the condition has been false
 *   on every sample for this long. A true sample in between keeps the episode going.
 * - `cooldownMs`: after an episode ended normally, the next one is not confirmed until this much
 *   time has passed. Its start time is still the onset, so durations stay accurate.
 * - `maxGapMs`: if two samples are further apart than this, nothing is known about the time in
 *   between. A pending run is dropped and an active episode ends at the last sample, with reason
 *   "data-gap". Such ends do not start a cooldown.
 *
 * Times are the samples' own timestamps (camera capture times), so evaluation is independent of
 * processing delays. Resolution is one sampling interval (200 ms at 5 FPS).
 *
 * @typedef {Object} TemporalConditionOptions
 * @property {number} minDurationMs
 * @property {number} clearAfterMs
 * @property {number} cooldownMs
 * @property {number} maxGapMs
 *
 * @typedef {'cleared' | 'data-gap' | 'stopped' | 'disabled' | 'reference-changed' | 'baseline-changed'} EndReason
 *   `reference-changed`: the enrolled reference a FACE_MISMATCH compared against was deleted
 *   or replaced. `baseline-changed`: the attention baseline (calibration) an attention rule
 *   measured against was replaced or reset
 *
 * `samples` counts the samples on which the condition held, from the onset; `peak` is the
 * highest `value` passed with those samples (for example the face count).
 *
 * @typedef {{ type: 'start', startedAt: number, confirmedAt: number, samples: number, peak: number }
 *   | { type: 'end', startedAt: number, endedAt: number, reason: EndReason, samples: number, peak: number }
 * } ConditionTransition
 *
 * @typedef {'inactive' | 'pending' | 'active' | 'clearing'} ConditionState
 */
export class TemporalCondition {
  /** @type {TemporalConditionOptions} */
  #options;
  /** @type {ConditionState} */
  #state = "inactive";
  /** @type {number | null} first sample of the current run or episode */
  #onsetAt = null;
  /** @type {number | null} first false sample while active */
  #clearingSince = null;
  /** @type {number | null} */
  #lastSampleAt = null;
  /** @type {number | null} last sample on which the condition was true */
  #lastTrueAt = null;
  /** Samples on which the condition was true in the current run or episode. */
  #samples = 0;
  /** Highest value passed with those samples. */
  #peak = 0;
  #cooldownUntil = -Infinity;
  /**
   * suppressedShort: runs that ended before minDurationMs.
   * cooldownDelayed: runs whose confirmation had to wait for the cooldown.
   * suppressedByCooldown: runs long enough to confirm that ended while waiting for the cooldown.
   */
  #stats = { suppressedShort: 0, cooldownDelayed: 0, suppressedByCooldown: 0 };
  #waitingForCooldown = false;

  /** @param {TemporalConditionOptions} options */
  constructor(options) {
    this.#options = { ...options };
  }

  /** @returns {ConditionState} */
  get state() {
    return this.#state;
  }

  get options() {
    return { ...this.#options };
  }

  /** @param {Partial<TemporalConditionOptions>} patch applied from the next sample on */
  updateOptions(patch) {
    this.#options = { ...this.#options, ...patch };
  }

  /**
   * @param {number} at sample time, epoch ms; samples must arrive in time order
   * @param {boolean} value whether the condition holds on this sample
   * @param {number} [measure] value tracked as `peak` while the condition holds
   * @returns {ConditionTransition[]} transitions caused by this sample, in order
   */
  update(at, value, measure = 0) {
    /** @type {ConditionTransition[]} */
    const transitions = [];
    if (this.#lastSampleAt !== null && at < this.#lastSampleAt) return transitions;
    if (this.#lastSampleAt !== null && at - this.#lastSampleAt > this.#options.maxGapMs) {
      const end = this.interrupt("data-gap");
      if (end) transitions.push(end);
    }
    this.#lastSampleAt = at;
    if (value) this.#lastTrueAt = at;

    switch (this.#state) {
      case "inactive":
        if (value) {
          this.#state = "pending";
          this.#onsetAt = at;
          this.#samples = 1;
          this.#peak = measure;
          this.#waitingForCooldown = false;
          this.#tryConfirm(at, transitions);
        }
        break;
      case "pending":
        if (value) {
          this.#samples += 1;
          this.#peak = Math.max(this.#peak, measure);
          this.#tryConfirm(at, transitions);
        } else {
          if (this.#waitingForCooldown) this.#stats.suppressedByCooldown += 1;
          else this.#stats.suppressedShort += 1;
          this.#resetRun();
        }
        break;
      case "active":
        if (value) {
          this.#samples += 1;
          this.#peak = Math.max(this.#peak, measure);
        } else {
          this.#state = "clearing";
          this.#clearingSince = at;
          this.#tryClear(at, transitions);
        }
        break;
      case "clearing":
        if (value) {
          this.#state = "active";
          this.#clearingSince = null;
          this.#samples += 1;
          this.#peak = Math.max(this.#peak, measure);
        } else {
          this.#tryClear(at, transitions);
        }
        break;
    }
    return transitions;
  }

  /**
   * Ends evaluation without waiting for more samples (data gap, detection stopped, rule
   * disabled). A pending run is dropped. An active episode ends at the last sample on which the
   * condition was still known: the start of clearing if it was clearing, else the last sample.
   *
   * @param {EndReason} reason
   * @returns {ConditionTransition | null} the end transition, if an episode was active
   */
  interrupt(reason) {
    /** @type {ConditionTransition | null} */
    let end = null;
    if (this.#state === "active" || this.#state === "clearing") {
      end = {
        type: "end",
        startedAt: /** @type {number} */ (this.#onsetAt),
        endedAt: /** @type {number} */ (
          this.#state === "clearing" ? this.#clearingSince : this.#lastTrueAt
        ),
        reason,
        samples: this.#samples,
        peak: this.#peak,
      };
    }
    this.#resetRun();
    this.#lastSampleAt = null;
    return end;
  }

  /**
   * @param {number} [now] epoch ms; when given, reports whether the last sample is older than
   *   maxGapMs (the caller then interrupts with "data-gap")
   */
  isStale(now) {
    return (
      now !== undefined &&
      this.#lastSampleAt !== null &&
      now - this.#lastSampleAt > this.#options.maxGapMs
    );
  }

  /** Read-only view for snapshots. */
  getState() {
    return {
      state: this.#state,
      onsetAt: this.#onsetAt,
      clearingSince: this.#clearingSince,
      lastSampleAt: this.#lastSampleAt,
      samples: this.#samples,
      peak: this.#peak,
      cooldownUntil: Number.isFinite(this.#cooldownUntil) ? this.#cooldownUntil : null,
      waitingForCooldown: this.#waitingForCooldown,
      ...this.#stats,
    };
  }

  /**
   * @param {number} at
   * @param {ConditionTransition[]} transitions
   */
  #tryConfirm(at, transitions) {
    const onsetAt = /** @type {number} */ (this.#onsetAt);
    if (at - onsetAt < this.#options.minDurationMs) return;
    if (at < this.#cooldownUntil) {
      if (!this.#waitingForCooldown) this.#stats.cooldownDelayed += 1;
      this.#waitingForCooldown = true;
      return;
    }
    this.#state = "active";
    this.#waitingForCooldown = false;
    transitions.push({
      type: "start",
      startedAt: onsetAt,
      confirmedAt: at,
      samples: this.#samples,
      peak: this.#peak,
    });
  }

  /**
   * @param {number} at
   * @param {ConditionTransition[]} transitions
   */
  #tryClear(at, transitions) {
    const clearingSince = /** @type {number} */ (this.#clearingSince);
    if (at - clearingSince < this.#options.clearAfterMs) return;
    transitions.push({
      type: "end",
      startedAt: /** @type {number} */ (this.#onsetAt),
      endedAt: clearingSince,
      reason: "cleared",
      samples: this.#samples,
      peak: this.#peak,
    });
    this.#cooldownUntil = clearingSince + this.#options.cooldownMs;
    this.#resetRun();
  }

  #resetRun() {
    this.#state = "inactive";
    this.#onsetAt = null;
    this.#clearingSince = null;
    this.#samples = 0;
    this.#peak = 0;
    this.#waitingForCooldown = false;
  }
}
