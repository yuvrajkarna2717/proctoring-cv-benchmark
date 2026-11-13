import { describe, expect, it } from "vitest";
import { ObjectMonitor, readObjectSample } from "../../src/objects/objectMonitor.js";

/** @param {string} engine @param {number} at @param {Record<string, number>} best */
function result(engine, at, best) {
  return {
    engine,
    frameCaptureTime: at,
    observations: [
      { type: "OBJECTS", detected: true, value: Object.keys(best).length, metadata: { best } },
      ...Object.entries(best).map(([label, score]) => ({
        type: "OBJECT",
        detected: true,
        value: label,
        confidence: score,
      })),
    ],
  };
}

const LIMITS = { "cell phone": 0.5, book: 0.6 };

describe("readObjectSample", () => {
  it("reads the per-label best scores and the detections", () => {
    expect(readObjectSample(result("a", 10, { "cell phone": 0.7 }))).toEqual({
      engine: "a",
      at: 10,
      best: { "cell phone": 0.7 },
      detections: [{ label: "cell phone", score: 0.7 }],
    });
    expect(readObjectSample({ engine: "a", frameCaptureTime: 0, observations: [] })).toBeNull();
  });
});

describe("ObjectMonitor", () => {
  it("passes on only the source engine's samples and counts every engine", () => {
    const monitor = new ObjectMonitor({ sourceEngineId: "a", historySize: 2 });
    expect(monitor.observe(result("a", 0, { "cell phone": 0.5 }), LIMITS)).toMatchObject({
      engine: "a",
    });
    expect(monitor.observe(result("b", 0, { "cell phone": 0.9, book: 0.59 }), LIMITS)).toBeNull();
    monitor.observe(result("a", 1000, { "cell phone": 0.49 }), LIMITS);
    monitor.observe(result("a", 2000, {}), LIMITS);
    const { engines, sourceEngineId } = monitor.getSnapshot();
    expect(sourceEngineId).toBe("a");
    expect(engines.a).toMatchObject({
      frames: 3,
      framesWith: { "cell phone": 1 },
      maxScore: { "cell phone": 0.5, book: 0 },
    });
    expect(engines.a.recent.map((r) => r.at)).toEqual([1000, 2000]); // historySize 2
    expect(engines.b).toMatchObject({ frames: 1, framesWith: { "cell phone": 1 } });
    expect(engines.b.framesWith.book).toBeUndefined(); // 0.59 < 0.6
  });

  it("switches the source engine and clears its counts", () => {
    const monitor = new ObjectMonitor({ sourceEngineId: "a", historySize: 10 });
    monitor.setSourceEngine("b");
    expect(monitor.sourceEngineId).toBe("b");
    expect(monitor.observe(result("b", 0, {}), LIMITS)).not.toBeNull();
    expect(monitor.observe(result("a", 0, {}), LIMITS)).toBeNull();
    monitor.clear();
    expect(monitor.getSnapshot().engines).toEqual({});
  });
});
