import { validateSchedulerConfig } from "../config/schema.js";

/**
 * Decision returned by {@link FrameScheduler#evaluate} for one source frame.
 * @typedef {'dispatch'|'not-due'|'busy'|'yield'|'not-ready'|'disabled'} ScheduleDecision
 *
 * @typedef {Object} SchedulerCounters
 * @property {number} dispatched frames handed to the engine
 * @property {number} completed dispatches that settled (result, drop, or failure)
 * @property {number} skippedBusy sampling slots lost because the engine was still busy
 * @property {number} skippedYield sampling slots lost while yielding to a higher-priority engine
 */

/**
 * Per-engine frame scheduler: decides, for each camera frame, whether its engine should receive
 * that frame. It holds no frames and never queues; capture happens only after a "dispatch"
 * decision, so an engine always gets the newest frame and slow engines cannot build a backlog.
 *
 * Timing uses a due-time accumulator instead of "now - lastDispatch >= interval". Camera frames
 * arrive on a fixed grid (e.g. every 33.3 ms), so the naive rule overshoots every interval and
 * undershoots the target rate. A frame counts as due when it is within half a source-frame
 * interval of the due time. A yielding engine waits for higher-priority engines for at most
 * `maxYieldMs` past its due time, so it cannot be starved. When the engine falls behind by more
 * than one interval (busy or
 * yielding), the phase is reset instead of bursting to catch up, and the whole slots that were
 * missed are counted. Missed slots are attributed to the last reason seen for the overdue slot.
 */
export class FrameScheduler {
  /** @type {import('../config/schema.js').SchedulerConfig} */
  #config;
  /** @type {number | null} due time of the next slot; null = unphased (due on the next frame) */
  #nextDueAt = null;
  #inFlight = false;
  #inFlightBeforeReset = false;
  /** @type {'busy'|'yield'|'not-ready'|null} why the current overdue slot was not dispatched */
  #pendingReason = null;
  /** @type {SchedulerCounters} */
  #counters = { dispatched: 0, completed: 0, skippedBusy: 0, skippedYield: 0 };

  /** @param {import('../config/schema.js').SchedulerConfig} config */
  constructor(config) {
    this.#config = validateSchedulerConfig(config);
  }

  /** @returns {import('../config/schema.js').SchedulerConfig} */
  get config() {
    return { ...this.#config };
  }

  /** @returns {number} target interval between dispatches in ms */
  get intervalMs() {
    return 1000 / this.#config.targetFps;
  }

  /** @returns {boolean} */
  get inFlight() {
    return this.#inFlight;
  }

  /**
   * Validates and applies a partial configuration. Changing the rate or enabling the scheduler
   * resets the phase so the next frame is due immediately.
   *
   * @param {Partial<import('../config/schema.js').SchedulerConfig>} patch
   */
  updateConfig(patch) {
    const next = validateSchedulerConfig({ ...this.#config, ...patch });
    const rephase =
      next.targetFps !== this.#config.targetFps || (next.enabled && !this.#config.enabled);
    this.#config = next;
    if (rephase) {
      this.#nextDueAt = null;
      this.#pendingReason = null;
    }
  }

  /**
   * @param {number} now epoch ms of the source frame
   * @param {{ sourceFrameIntervalMs: number, engineReady: boolean, higherPriorityInFlight: boolean }} context
   * @returns {ScheduleDecision}
   */
  evaluate(now, { sourceFrameIntervalMs, engineReady, higherPriorityInFlight }) {
    if (!this.#config.enabled) return "disabled";
    // An unphased scheduler becomes due at the first frame it sees, so slots skipped before the
    // first dispatch are accounted for like any other overdue slot.
    if (this.#nextDueAt === null) this.#nextDueAt = now;
    const toleranceMs = Math.min(sourceFrameIntervalMs, this.intervalMs) / 2;
    if (now < this.#nextDueAt - toleranceMs) return "not-due";
    if (!engineReady) {
      this.#pendingReason = "not-ready";
      return "not-ready";
    }
    if (this.#inFlight) {
      this.#pendingReason = "busy";
      return "busy";
    }
    if (
      this.#config.yieldToHigherPriority &&
      higherPriorityInFlight &&
      now - this.#nextDueAt < this.#config.maxYieldMs
    ) {
      this.#pendingReason = "yield";
      return "yield";
    }
    return "dispatch";
  }

  /**
   * Records a dispatch. Must follow a "dispatch" decision for the same `now`.
   * @param {number} now epoch ms
   */
  markDispatched(now) {
    if (this.#inFlight)
      throw new Error("FrameScheduler: markDispatched() while a frame is in flight");
    const interval = this.intervalMs;
    const dueAt = this.#nextDueAt ?? now;
    const lateByMs = now - dueAt;
    if (lateByMs > interval) {
      const missedSlots = Math.floor(lateByMs / interval);
      if (this.#pendingReason === "busy") this.#counters.skippedBusy += missedSlots;
      else if (this.#pendingReason === "yield") this.#counters.skippedYield += missedSlots;
      // "not-ready" periods (initialization, restart) are not counted as drops.
      this.#nextDueAt = now + interval;
    } else {
      // Keep the phase so the long-run rate matches the target despite the camera frame grid.
      this.#nextDueAt = dueAt + interval;
    }
    this.#pendingReason = null;
    this.#inFlight = true;
    this.#counters.dispatched += 1;
  }

  /** Records that the in-flight frame settled (result, drop, or failure). */
  markCompleted() {
    if (!this.#inFlight) return;
    this.#inFlight = false;
    if (this.#inFlightBeforeReset) {
      // Dispatched before the last reset(): not part of this window's counters.
      this.#inFlightBeforeReset = false;
      return;
    }
    this.#counters.completed += 1;
  }

  /** @returns {SchedulerCounters} */
  getCounters() {
    return { ...this.#counters };
  }

  /**
   * Clears counters and phase, e.g. at the start of a measurement run. A frame that is still in
   * flight stays in flight but is excluded from the new window's counters.
   */
  reset() {
    this.#counters = { dispatched: 0, completed: 0, skippedBusy: 0, skippedYield: 0 };
    this.#nextDueAt = null;
    this.#pendingReason = null;
    this.#inFlightBeforeReset = this.#inFlight;
  }
}
