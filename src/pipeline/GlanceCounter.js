/**
 * Counts glances away from the screen in a sliding window, for GAZE_AWAY_REPEATED.
 *
 * A glance is a run of consecutive "away" samples that lasts at least `minGlanceMs` (from its
 * first to its latest away sample). It is counted once, when it reaches that length, with the
 * direction it went most often until then. "Undecided" samples (blink, eyes too small) neither
 * extend nor end a run; an "on" sample or a gap longer than `maxGapMs` ends it.
 *
 * The condition holds while the glances in the window reach `minGlances`, counting either all
 * glances or, with `sameDirection`, only those toward the most frequent direction.
 *
 * @typedef {import('../attention/attentionModel.js').Direction} Direction
 * @typedef {{ windowMs: number, minGlances: number, minGlanceMs: number, sameDirection: boolean }} GlanceRule
 */
export class GlanceCounter {
  /** @type {Array<{ at: number, direction: Direction }>} counted glances, oldest first */
  #glances = [];
  /** @type {{ startedAt: number, lastAt: number, counted: boolean, directions: Map<Direction, number> } | null} */
  #run = null;
  /** @type {number | null} */
  #lastAt = null;
  #maxGapMs;

  /** @param {{ maxGapMs: number }} options */
  constructor({ maxGapMs }) {
    this.#maxGapMs = maxGapMs;
  }

  reset() {
    this.#glances = [];
    this.#run = null;
    this.#lastAt = null;
  }

  /**
   * @param {number} at sample time
   * @param {'on' | 'away'} state
   * @param {Direction | null} direction
   * @param {GlanceRule} rule
   * @returns {{ holds: boolean, count: number, direction: Direction | null }}
   */
  update(at, state, direction, rule) {
    if (this.#lastAt !== null && at - this.#lastAt > this.#maxGapMs) this.#run = null;
    this.#lastAt = at;
    if (state === "away") {
      if (!this.#run) {
        this.#run = { startedAt: at, lastAt: at, counted: false, directions: new Map() };
      }
      const run = this.#run;
      run.lastAt = at;
      if (direction) run.directions.set(direction, (run.directions.get(direction) ?? 0) + 1);
      if (!run.counted && run.lastAt - run.startedAt >= rule.minGlanceMs) {
        run.counted = true;
        this.#glances.push({
          at: run.startedAt,
          direction: mostFrequent(run.directions) ?? "down",
        });
      }
    } else {
      this.#run = null;
    }
    while (this.#glances.length > 0 && this.#glances[0].at < at - rule.windowMs) {
      this.#glances.shift();
    }
    return this.evaluate(rule);
  }

  /**
   * @param {GlanceRule} rule
   * @returns {{ holds: boolean, count: number, direction: Direction | null }}
   */
  evaluate(rule) {
    /** @type {Map<Direction, number>} */
    const perDirection = new Map();
    for (const glance of this.#glances) {
      perDirection.set(glance.direction, (perDirection.get(glance.direction) ?? 0) + 1);
    }
    const direction = mostFrequent(perDirection);
    const count = rule.sameDirection
      ? direction
        ? /** @type {number} */ (perDirection.get(direction))
        : 0
      : this.#glances.length;
    return { holds: count >= rule.minGlances, count, direction };
  }

  /** Glances currently in the window (for snapshots). */
  get glances() {
    return this.#glances.map((glance) => ({ ...glance }));
  }
}

/**
 * @param {Map<Direction, number>} counts
 * @returns {Direction | null}
 */
function mostFrequent(counts) {
  /** @type {Direction | null} */
  let best = null;
  let bestCount = 0;
  for (const [direction, count] of counts) {
    if (count > bestCount) {
      best = direction;
      bestCount = count;
    }
  }
  return best;
}
