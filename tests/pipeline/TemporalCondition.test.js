import { describe, expect, it } from "vitest";
import { TemporalCondition } from "../../src/pipeline/TemporalCondition.js";

const OPTIONS = { minDurationMs: 1000, clearAfterMs: 500, cooldownMs: 3000, maxGapMs: 2000 };

/**
 * Feeds `values` as samples every `stepMs` starting at `from` and returns all transitions.
 * @param {TemporalCondition} condition
 */
function feed(condition, from, values, stepMs = 200) {
  const transitions = [];
  values.forEach((value, index) => {
    transitions.push(...condition.update(from + index * stepMs, value));
  });
  return transitions;
}

const repeat = (value, count) => Array.from({ length: count }, () => value);

describe("TemporalCondition", () => {
  it("starts once the condition held for minDurationMs and reports the onset as the start", () => {
    const condition = new TemporalCondition(OPTIONS);
    const transitions = feed(condition, 0, repeat(true, 6)); // 0, 200, ..., 1000
    expect(transitions).toEqual([
      { type: "start", startedAt: 0, confirmedAt: 1000, samples: 6, peak: 0 },
    ]);
    expect(condition.state).toBe("active");
  });

  it("drops runs shorter than minDurationMs and counts them", () => {
    const condition = new TemporalCondition(OPTIONS);
    const transitions = feed(condition, 0, [...repeat(true, 5), false]); // true until 800 ms
    expect(transitions).toEqual([]);
    expect(condition.getState()).toMatchObject({ state: "inactive", suppressedShort: 1 });
  });

  it("keeps an episode through a short absence and ends it at the first absent frame", () => {
    const condition = new TemporalCondition(OPTIONS);
    feed(condition, 0, repeat(true, 10)); // active from 1000 ms, last true at 1800 ms
    // Absent at 2000 and 2200 (400 ms < clearAfterMs), present again at 2400.
    expect(feed(condition, 2000, [false, false, true])).toEqual([]);
    expect(condition.state).toBe("active");
    // Absent from 2600 on: cleared once 500 ms of absence are observed (at 3200).
    const transitions = feed(condition, 2600, repeat(false, 4));
    expect(transitions).toEqual([
      { type: "end", startedAt: 0, endedAt: 2600, reason: "cleared", samples: 11, peak: 0 },
    ]);
    expect(condition.state).toBe("inactive");
  });

  it("confirms and clears on the first frame when the durations are 0", () => {
    const condition = new TemporalCondition({ ...OPTIONS, minDurationMs: 0, clearAfterMs: 0 });
    expect(condition.update(100, true)).toEqual([
      { type: "start", startedAt: 100, confirmedAt: 100, samples: 1, peak: 0 },
    ]);
    expect(condition.update(300, false)).toEqual([
      { type: "end", startedAt: 100, endedAt: 300, reason: "cleared", samples: 1, peak: 0 },
    ]);
  });

  it("tracks the highest measure on the samples where the condition holds", () => {
    const condition = new TemporalCondition(OPTIONS);
    [2, 3, 2, 2, 2].forEach((count, index) => condition.update(index * 200, true, count));
    const [start] = condition.update(1000, true, 2);
    expect(start).toMatchObject({ type: "start", peak: 3, samples: 6 });
    condition.update(1200, true, 4);
    condition.update(1400, false, 1); // not counted: the condition does not hold
    expect(condition.getState()).toMatchObject({ peak: 4, samples: 7 });
  });

  it("waits for the cooldown before confirming the next episode, keeping its onset", () => {
    const condition = new TemporalCondition(OPTIONS);
    feed(condition, 0, [...repeat(true, 6), ...repeat(false, 4)]); // ends at 1200, cooldown to 4200
    const transitions = feed(condition, 2200, repeat(true, 11)); // 2200 ... 4200
    expect(transitions).toEqual([
      { type: "start", startedAt: 2200, confirmedAt: 4200, samples: 11, peak: 0 },
    ]);
    expect(condition.getState()).toMatchObject({ cooldownDelayed: 1, cooldownUntil: 4200 });
  });

  it("counts a run that ended while waiting for the cooldown", () => {
    const condition = new TemporalCondition(OPTIONS);
    feed(condition, 0, [...repeat(true, 6), ...repeat(false, 4)]); // cooldown until 4200
    feed(condition, 2200, [...repeat(true, 7), false]); // long enough, but ends at 3600
    expect(condition.getState()).toMatchObject({
      state: "inactive",
      suppressedByCooldown: 1,
      suppressedShort: 0,
    });
  });

  it("ends an active episode at its last frame after a gap, without a cooldown", () => {
    const condition = new TemporalCondition(OPTIONS);
    feed(condition, 0, repeat(true, 7)); // active, last true at 1200
    const afterGap = condition.update(5000, true); // 3800 ms without frames
    expect(afterGap).toEqual([
      { type: "end", startedAt: 0, endedAt: 1200, reason: "data-gap", samples: 7, peak: 0 },
    ]);
    expect(condition.getState()).toMatchObject({ state: "pending", onsetAt: 5000 });
    expect(feed(condition, 5200, repeat(true, 5))).toEqual([
      { type: "start", startedAt: 5000, confirmedAt: 6000, samples: 6, peak: 0 },
    ]);
  });

  it("drops a pending run across a gap", () => {
    const condition = new TemporalCondition(OPTIONS);
    feed(condition, 0, repeat(true, 4)); // pending since 0
    expect(condition.update(4000, true)).toEqual([]);
    expect(condition.getState()).toMatchObject({ state: "pending", onsetAt: 4000, samples: 1 });
  });

  it("interrupts an episode that is clearing at the start of the absence", () => {
    const condition = new TemporalCondition(OPTIONS);
    feed(condition, 0, [...repeat(true, 6), false, false]); // clearing since 1200, last at 1400
    expect(condition.getState()).toMatchObject({ state: "clearing", lastSampleAt: 1400 });
    expect(condition.interrupt("stopped")).toEqual({
      type: "end",
      startedAt: 0,
      endedAt: 1200,
      reason: "stopped",
      samples: 6,
      peak: 0,
    });
    expect(condition.interrupt("stopped")).toBeNull();
  });

  it("reports silence longer than maxGapMs and ignores out-of-order samples", () => {
    const condition = new TemporalCondition(OPTIONS);
    condition.update(1000, true);
    expect(condition.isStale(2900)).toBe(false);
    expect(condition.isStale(3100)).toBe(true);
    expect(condition.update(900, true)).toEqual([]);
    expect(condition.getState().lastSampleAt).toBe(1000);
  });

  it("applies updated durations from the next frame", () => {
    const condition = new TemporalCondition(OPTIONS);
    feed(condition, 0, repeat(true, 3)); // pending, 400 ms held
    condition.updateOptions({ minDurationMs: 500 });
    expect(condition.update(600, true)).toEqual([
      { type: "start", startedAt: 0, confirmedAt: 600, samples: 4, peak: 0 },
    ]);
  });
});
