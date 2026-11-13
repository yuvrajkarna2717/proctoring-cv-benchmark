import { describe, expect, it } from "vitest";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import { ViolationEngine } from "../../src/pipeline/ViolationEngine.js";

/**
 * An attention sample as the AttentionManager produces it.
 *
 * @param {number} at
 * @param {Partial<{ gaze: string, direction: string | null, excess: number, head: string,
 *   headExcess: number, headDirection: string | null, eyes: string, closure: number,
 *   baseline: string }>} [options]
 */
function sample(at, options = {}) {
  const {
    gaze = "on",
    direction = gaze === "away" ? "right" : null,
    excess = gaze === "away" ? 5 : -10,
    head = "ok",
    headExcess = head === "turned" ? 4 : -15,
    headDirection = head === "turned" ? "left" : null,
    eyes = "open",
    closure = eyes === "closed" ? 0.8 : 0.05,
    baseline = "calibration",
  } = options;
  return {
    at,
    baseline,
    gaze: {
      state: gaze,
      reason: gaze === "undecided" ? "eyes closed" : null,
      yawDeg: gaze === "undecided" ? null : 0,
      pitchDeg: gaze === "undecided" ? null : 0,
      excessDeg: gaze === "undecided" ? null : excess,
      direction: gaze === "undecided" ? null : direction,
    },
    head: {
      state: head,
      reason: null,
      yawDeg: 0,
      pitchDeg: 0,
      excessDeg: headExcess,
      direction: headDirection,
    },
    eyes: { state: eyes, reason: null, closure, earRatio: 1 },
  };
}

/**
 * GAZE_AWAY timings for the tests of the rule's mechanics, independent of the tuned defaults: at
 * 5 FPS confirmed on the 4th frame away (600 ms), ended on the 3rd frame back.
 */
const GAZE_TIMINGS = { GAZE_AWAY: { minDurationMs: 500, clearAfterMs: 300, cooldownMs: 2000 } };

function createEngine(ruleOverrides = {}) {
  const config = structuredClone(DEFAULT_LAB_CONFIG.violations);
  for (const [type, patch] of Object.entries(ruleOverrides)) {
    config.rules[type] = { ...config.rules[type], ...patch };
  }
  const engine = new ViolationEngine(config, { attentionSourceEngineId: "face-landmarker" });
  const events = [];
  engine.onEvent((event) => events.push(event));
  return { engine, events };
}

/** Feeds samples every 200 ms (5 FPS) from `start`. */
function feed(engine, start, count, options) {
  for (let index = 0; index < count; index += 1) {
    engine.observeAttention(
      sample(start + index * 200, typeof options === "function" ? options(index) : options),
    );
  }
  return start + count * 200;
}

describe("GAZE_AWAY", () => {
  it("starts after minDurationMs away, with the largest angle, its direction, and the baseline", () => {
    const { engine, events } = createEngine(GAZE_TIMINGS);
    feed(engine, 0, 3, { gaze: "on" });
    // 500 ms: away samples from 600 on confirm on the 4th, at 1200.
    feed(engine, 600, 11, (i) => ({
      gaze: "away",
      excess: i === 2 ? 9 : 3,
      direction: i === 2 ? "down" : "right",
    }));
    const start = events.find((e) => e.type === "violation-start");
    expect(start.violation).toMatchObject({
      type: "GAZE_AWAY",
      startedAt: 600,
      confirmedAt: 1200,
      severity: "medium",
      maxExcessDeg: 9,
      direction: "down",
      baseline: "calibration",
      sourceEngineId: "face-landmarker",
    });
  });

  it("ignores looks shorter than minDurationMs (glances)", () => {
    const { engine, events } = createEngine(GAZE_TIMINGS);
    // Three away frames span 400 ms, less than 500 ms.
    let at = feed(engine, 0, 3, { gaze: "away" });
    at = feed(engine, at, 2, { gaze: "on" });
    feed(engine, at, 3, { gaze: "away" });
    expect(events.filter((e) => e.violation.type === "GAZE_AWAY")).toEqual([]);
  });

  it("ends 300 ms after the gaze is back, at the first frame back on screen", () => {
    const { engine, events } = createEngine(GAZE_TIMINGS);
    let at = feed(engine, 0, 5, { gaze: "away" }); // confirmed at 600
    at = feed(engine, at, 1, { gaze: "on" }); // 1000: clearing starts
    expect(events.filter((e) => e.type === "violation-end")).toEqual([]);
    feed(engine, at, 2, { gaze: "on" }); // 1200, 1400: 400 ms ≥ 300 → ended at 1000
    expect(events.find((e) => e.type === "violation-end").violation).toMatchObject({
      type: "GAZE_AWAY",
      endedAt: 1000,
      endReason: "cleared",
    });
  });

  it("skips undecided samples instead of letting them end or extend a look away", () => {
    const { engine, events } = createEngine(GAZE_TIMINGS);
    // Away, a blink (gaze undecided) at 400 ms, away again: one continuous run that confirms
    // at 600 ms with three away frames.
    feed(engine, 0, 6, (i) => ({ gaze: i === 2 ? "undecided" : "away" }));
    const start = events.find(
      (e) => e.type === "violation-start" && e.violation.type === "GAZE_AWAY",
    );
    expect(start.violation).toMatchObject({ startedAt: 0, confirmedAt: 600, frames: 3 });
  });

  it("raises the severity once the violation lasts escalateAfterMs", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, 46, { gaze: "away" }); // 0–9000 ms
    const escalation = events.find((e) => e.type === "violation-escalated");
    expect(escalation.violation).toMatchObject({
      type: "GAZE_AWAY",
      severity: "high",
      initialSeverity: "medium",
      escalatedAt: 8000,
    });
    const [active] = engine.getSnapshot().active;
    expect(active.severity).toBe("high");
    expect(engine.getSnapshot().rules.find((r) => r.type === "GAZE_AWAY").stats.escalated).toBe(1);
  });

  it("does not escalate without escalateAfterMs", () => {
    const { engine, events } = createEngine({ GAZE_AWAY: { escalateAfterMs: null } });
    feed(engine, 0, 60, { gaze: "away" });
    expect(events.some((e) => e.type === "violation-escalated")).toBe(false);
  });

  it("ends with baseline-changed when the baseline is replaced", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, 12, { gaze: "away" });
    engine.interruptRule("GAZE_AWAY", "baseline-changed");
    const end = events.find((e) => e.type === "violation-end");
    expect(end.violation).toMatchObject({ type: "GAZE_AWAY", endReason: "baseline-changed" });
    expect(
      engine.getSnapshot().rules.find((r) => r.type === "GAZE_AWAY").stats.endReasons[
        "baseline-changed"
      ],
    ).toBe(1);
  });
});

describe("HEAD_TURNED and EYES_CLOSED", () => {
  it("HEAD_TURNED reads the head state, independent of the gaze", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, 9, { head: "turned", gaze: "undecided" });
    expect(events.map((e) => [e.type, e.violation.type])).toEqual([
      ["violation-start", "HEAD_TURNED"],
    ]);
    expect(events[0].violation).toMatchObject({ maxExcessDeg: 4, direction: "left" });
  });

  it("EYES_CLOSED needs 2 s of closed eyes and skips undecided eye states", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, 12, (i) => ({ eyes: i === 6 ? "undecided" : "closed", gaze: "undecided" }));
    const start = events.find((e) => e.violation.type === "EYES_CLOSED");
    expect(start.violation).toMatchObject({ severity: "low", maxClosure: 0.8, startedAt: 0 });
  });

  it("evaluate nothing while the rule is disabled", () => {
    const { engine, events } = createEngine({ EYES_CLOSED: { enabled: false } });
    feed(engine, 0, 20, { eyes: "closed" });
    expect(events).toEqual([]);
  });
});
