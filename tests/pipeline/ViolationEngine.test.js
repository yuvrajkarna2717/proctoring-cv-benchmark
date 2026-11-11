import { describe, expect, it } from "vitest";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import { ViolationEngine } from "../../src/pipeline/ViolationEngine.js";

const CONFIG = { ...structuredClone(DEFAULT_LAB_CONFIG.violations), sourceEngineId: "face" };

function createEngine(overrides = {}) {
  const engine = new ViolationEngine({ ...CONFIG, ...overrides });
  const events = [];
  engine.onEvent((event) => events.push(event));
  return { engine, events };
}

/** A face-engine result whose frame was captured at `at` with `count` faces. */
const result = (at, count, engine = "face") => ({
  engine,
  frameCaptureTime: at,
  observations: [{ type: "FACE_COUNT", detected: count > 0, value: count }],
});

/** Feeds face counts every 200 ms from `from`; returns the time after the last frame. */
function feed(engine, from, counts) {
  counts.forEach((count, index) => engine.observe(result(from + index * 200, count)));
  return from + counts.length * 200;
}

const repeat = (value, count) => Array.from({ length: count }, () => value);

describe("ViolationEngine", () => {
  it("raises NO_FACE after 1 s without a face and ends it when the face is back", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, [1, 1, ...repeat(0, 10), ...repeat(1, 4)]); // no face from 400 to 2200
    expect(events.map((event) => event.type)).toEqual(["violation-start", "violation-end"]);
    expect(events[0].violation).toMatchObject({
      type: "NO_FACE",
      severity: "medium",
      status: "active",
      startedAt: 400,
      confirmedAt: 1400,
      frames: 6,
    });
    const [violation] = engine.getSnapshot().history;
    expect(violation).toMatchObject({
      id: "NO_FACE-1",
      status: "ended",
      startedAt: 400,
      endedAt: 2400,
      durationMs: 2000,
      endReason: "cleared",
      frames: 10,
      maxFaceCount: 0,
      pageHidden: false,
      sourceEngineId: "face",
    });
    expect(engine.getSnapshot().active).toEqual([]);
  });

  it("raises MULTIPLE_FACES for two or more faces and records the peak count", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, [1, 2, 2, 3, 2, 2, 1, 1, 1, 1]); // two or more from 200 to 1000
    expect(events.map((event) => [event.type, event.violation.type])).toEqual([
      ["violation-start", "MULTIPLE_FACES"],
      ["violation-end", "MULTIPLE_FACES"],
    ]);
    expect(engine.getSnapshot().history[0]).toMatchObject({
      severity: "high",
      startedAt: 200,
      confirmedAt: 1000,
      endedAt: 1200,
      maxFaceCount: 3,
      frames: 5,
    });
  });

  it("keeps the face rules independent and quiet while exactly one face is visible", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, repeat(1, 30));
    expect(events).toEqual([]);
    // No face 6000–7000 (NO_FACE confirmed at 7000), then two faces from 7200: NO_FACE clears
    // after 500 ms (7800) and MULTIPLE_FACES is confirmed after 700 ms (at the 8000 frame).
    feed(engine, 6000, [...repeat(0, 6), ...repeat(2, 5)]);
    expect(events.map((event) => [event.type, event.violation.type])).toEqual([
      ["violation-start", "NO_FACE"],
      ["violation-end", "NO_FACE"],
      ["violation-start", "MULTIPLE_FACES"],
    ]);
    expect(events[1].violation).toMatchObject({ startedAt: 6000, endedAt: 7200 });
    expect(events[2].violation).toMatchObject({ startedAt: 7200, confirmedAt: 8000 });
    engine.observe(result(8200, 2));
    expect(engine.getSnapshot().active).toEqual([
      expect.objectContaining({ type: "MULTIPLE_FACES", frames: 6, durationMs: 1000 }),
    ]);
  });

  it("ignores other engines and results without a face count", () => {
    const { engine, events } = createEngine();
    for (let at = 0; at < 3000; at += 200) engine.observe(result(at, 0, "probe-high"));
    engine.observe({ engine: "face", frameCaptureTime: 0, observations: [] });
    expect(events).toEqual([]);
    expect(engine.getSnapshot().framesEvaluated).toBe(0);
  });

  it("ends a violation at its last frame when the source goes silent", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, repeat(0, 8)); // active, last frame at 1400
    engine.tick(3000);
    expect(events).toHaveLength(1);
    engine.tick(3500);
    expect(events.at(-1)).toMatchObject({
      type: "violation-end",
      violation: { endedAt: 1400, endReason: "data-gap", durationMs: 1400 },
    });
  });

  it("ends active violations when detection stops", () => {
    const { engine, events } = createEngine();
    feed(engine, 0, repeat(0, 8));
    engine.interrupt("stopped");
    expect(events.at(-1).violation).toMatchObject({ status: "ended", endReason: "stopped" });
    expect(engine.getSnapshot().rules[0].stats.endReasons.stopped).toBe(1);
  });

  it("flags violations that overlap a hidden page", () => {
    const { engine } = createEngine();
    feed(engine, 0, repeat(0, 8));
    engine.setPageHidden(true, 1500);
    engine.setPageHidden(false, 2500);
    feed(engine, 1600, repeat(0, 2));
    expect(engine.getSnapshot().active[0].pageHidden).toBe(true);

    const second = createEngine().engine;
    second.setPageHidden(true, 0);
    second.setPageHidden(false, 100);
    feed(second, 5000, repeat(0, 8));
    expect(second.getSnapshot().active[0].pageHidden).toBe(false);
  });

  it("validates rule updates and ends the active violation when a rule is disabled", () => {
    const { engine, events } = createEngine();
    expect(() => engine.updateRule("NO_FACE", { minDurationMs: -1 })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
    );
    feed(engine, 0, repeat(0, 8));
    engine.updateRule("NO_FACE", { enabled: false });
    expect(events.at(-1).violation).toMatchObject({ endReason: "disabled" });
    feed(engine, 2000, repeat(0, 10));
    expect(events).toHaveLength(2);
    expect(engine.updateRule("NO_FACE", { enabled: true, minDurationMs: 200 })).toMatchObject({
      enabled: true,
      minDurationMs: 200,
    });
    feed(engine, 4000, repeat(0, 2));
    expect(engine.getSnapshot().active).toHaveLength(1);
  });

  it("bounds the history, keeps statistics, and starts over on clear()", () => {
    const { engine } = createEngine({ historySize: 2 });
    let at = 0;
    for (let index = 0; index < 3; index += 1) {
      at = feed(engine, at, [...repeat(0, 6), ...repeat(1, 4)]);
      at += 5000; // past the cooldown
    }
    const snapshot = engine.getSnapshot();
    expect(snapshot.history.map((violation) => violation.id)).toEqual(["NO_FACE-2", "NO_FACE-3"]);
    expect(snapshot.rules[0].stats).toMatchObject({
      violations: 3,
      ended: 3,
      totalDurationMs: 3 * 1200,
      longestMs: 1200,
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    engine.clear();
    expect(engine.getSnapshot()).toMatchObject({ history: [], active: [], framesEvaluated: 0 });
    expect(engine.getSnapshot().rules[0].stats.violations).toBe(0);
  });
});

describe("ViolationEngine FACE_MISMATCH", () => {
  function createIdentityEngine() {
    const engine = new ViolationEngine(CONFIG, { identitySourceEngineId: "verifier" });
    const events = [];
    engine.onEvent((event) => events.push(event));
    return { engine, events };
  }

  /** Similarities every 500 ms (2 FPS) from `from`. */
  const feedIdentity = (engine, from, similarities) =>
    similarities.forEach((similarity, index) =>
      engine.observeIdentity({ at: from + index * 500, similarity }),
    );

  it("raises FACE_MISMATCH after 2 s below the threshold and records the lowest similarity", () => {
    const { engine, events } = createIdentityEngine();
    feedIdentity(engine, 0, [0.7, 0.2, 0.1, 0.25, 0.3, 0.15]); // below 0.363 from 500 ms
    expect(events).toHaveLength(1);
    expect(events[0].violation).toMatchObject({
      type: "FACE_MISMATCH",
      severity: "high",
      startedAt: 500,
      confirmedAt: 2500,
      minSimilarity: expect.closeTo(0.1, 6),
      maxFaceCount: null,
      sourceEngineId: "verifier",
    });
    feedIdentity(engine, 3000, [0.05, 0.8, 0.8, 0.8]); // above from 3500, clears after 1 s
    expect(events.at(-1)).toMatchObject({
      type: "violation-end",
      violation: { endReason: "cleared", endedAt: 3500, minSimilarity: expect.closeTo(0.05, 6) },
    });
  });

  it("ignores identity samples for face rules and face counts for FACE_MISMATCH", () => {
    const { engine, events } = createIdentityEngine();
    feedIdentity(engine, 0, new Array(10).fill(0.9));
    feed(engine, 0, repeat(1, 20));
    expect(events).toEqual([]);
    expect(engine.getSnapshot()).toMatchObject({
      framesEvaluated: 20,
      identityFramesEvaluated: 10,
    });
  });

  it("does not fire at the threshold, only below it", () => {
    const { engine, events } = createIdentityEngine();
    feedIdentity(engine, 0, new Array(8).fill(0.363));
    expect(events).toEqual([]);
  });

  it("ends an active mismatch when the reference changes, and after a gap without comparisons", () => {
    const { engine, events } = createIdentityEngine();
    feedIdentity(engine, 0, new Array(6).fill(0.1));
    engine.interruptRule("FACE_MISMATCH", "reference-changed");
    expect(events.at(-1).violation).toMatchObject({
      status: "ended",
      endReason: "reference-changed",
    });
    expect(engine.getSnapshot().rules[2].stats.endReasons["reference-changed"]).toBe(1);

    feedIdentity(engine, 10_000, new Array(6).fill(0.1)); // active again, last sample 12 500
    engine.tick(15_000); // no comparison for 2.5 s (face turned away, gate failing)
    expect(events.at(-1).violation).toMatchObject({ endReason: "data-gap", endedAt: 12_500 });
  });
});
