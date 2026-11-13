import { describe, expect, it } from "vitest";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import { validateViolationRule } from "../../src/config/schema.js";
import { ViolationEngine } from "../../src/pipeline/ViolationEngine.js";

/** @param {number} at @param {Record<string, number>} best */
const sample = (at, best = {}) => ({ engine: "objects-nanodet", at, best, detections: [] });
const phone = (at, score = 0.8) => sample(at, { "cell phone": score });

function createEngine(mutate = (config) => config) {
  const config = mutate(structuredClone(DEFAULT_LAB_CONFIG.violations));
  const engine = new ViolationEngine(config, { objectSourceEngineId: "objects-nanodet" });
  const events = [];
  engine.onEvent((event) => events.push(event));
  return { engine, events };
}

const ofType = (events, kind, type = "PHONE_DETECTED") =>
  events.filter((e) => e.type === kind && e.violation.type === type);

describe("PHONE_DETECTED", () => {
  it("starts when 2 of the last 3 samples reach the score and ends when fewer do", () => {
    const { engine, events } = createEngine();
    engine.observeObjects(phone(0));
    engine.observeObjects(sample(1000));
    expect(events).toEqual([]);
    engine.observeObjects(phone(2000, 0.6));
    const [start] = ofType(events, "violation-start");
    expect(start.violation).toMatchObject({
      startedAt: 2000,
      confirmedAt: 2000,
      severity: "high",
      label: "cell phone",
      maxScore: 0.6,
      sourceEngineId: "objects-nanodet",
    });
    engine.observeObjects(sample(3000)); // window: miss, hit, miss
    expect(ofType(events, "violation-end")[0].violation).toMatchObject({
      endReason: "cleared",
      endedAt: 3000,
    });
    expect(engine.getSnapshot().objectFramesEvaluated).toBe(4);
  });

  it("counts a score equal to the limit as a hit", () => {
    const { engine, events } = createEngine();
    engine.observeObjects(phone(0, 0.5));
    engine.observeObjects(phone(1000, 0.5));
    expect(ofType(events, "violation-start")).toHaveLength(1);
  });

  it("does not start on isolated hits or on scores below the limit", () => {
    const { engine, events } = createEngine();
    const scores = [0.9, 0, 0, 0.9, 0, 0, 0.49, 0.49, 0.49];
    scores.forEach((score, i) => engine.observeObjects(phone(i * 1000, score)));
    expect(events).toEqual([]);
  });

  it("is not ended by one missed frame, and keeps the highest score", () => {
    const { engine, events } = createEngine();
    [0.7, 0.9, 0, 0.6, 0.65].forEach((score, i) => engine.observeObjects(phone(i * 1000, score)));
    expect(ofType(events, "violation-start")).toHaveLength(1);
    expect(ofType(events, "violation-end")).toEqual([]);
    expect(engine.getSnapshot().active[0]).toMatchObject({ maxScore: 0.9, durationMs: 3000 });
  });

  it("forgets earlier hits after a gap longer than maxGapMs and ends an active violation", () => {
    const { engine, events } = createEngine();
    engine.observeObjects(phone(0));
    engine.observeObjects(phone(6000)); // 6 s gap > 5 s: the window starts afresh
    expect(events).toEqual([]);
    engine.observeObjects(phone(7000));
    expect(ofType(events, "violation-start")).toHaveLength(1);
    engine.observeObjects(phone(13_000));
    expect(ofType(events, "violation-end")[0].violation).toMatchObject({
      endReason: "data-gap",
      endedAt: 7000,
    });
  });

  it("ends with source-changed when the rules switch to another engine, which starts afresh", () => {
    const { engine, events } = createEngine();
    engine.observeObjects(phone(0));
    engine.observeObjects(phone(1000));
    engine.setObjectSource("objects-yolox");
    expect(ofType(events, "violation-end")[0].violation.endReason).toBe("source-changed");
    expect(engine.objectSourceEngineId).toBe("objects-yolox");
    engine.observeObjects({ ...phone(2000), engine: "objects-yolox" });
    expect(ofType(events, "violation-start")).toHaveLength(1); // one hit in a fresh window
    engine.setObjectSource("objects-yolox"); // same engine: nothing happens
    expect(events).toHaveLength(2);
  });

  it("applies live rule changes: a higher limit and a 1-of-1 vote", () => {
    const { engine, events } = createEngine();
    engine.updateRule("PHONE_DETECTED", { minScore: 0.85, votes: 1, window: 1 });
    engine.observeObjects(phone(0, 0.8));
    expect(events).toEqual([]);
    engine.observeObjects(phone(1000, 0.9));
    expect(ofType(events, "violation-start")).toHaveLength(1);
  });
});

describe("object rule configuration", () => {
  it("reports each label's limit and rejects more votes than samples", () => {
    const { engine } = createEngine();
    expect(engine.objectRuleLimits()).toEqual({ "cell phone": 0.5 });
    const rule = DEFAULT_LAB_CONFIG.violations.rules.PHONE_DETECTED;
    expect(() => validateViolationRule("PHONE_DETECTED", { ...rule, votes: 4, window: 3 })).toThrow(
      /votes must not exceed window/,
    );
  });

  it("ends object violations on interruptObjectRules but leaves other rules alone", () => {
    const { engine, events } = createEngine();
    engine.observeObjects(phone(0));
    engine.observeObjects(phone(1000));
    engine.interruptObjectRules("data-gap");
    expect(ofType(events, "violation-end")[0].violation.endReason).toBe("data-gap");
  });
});
