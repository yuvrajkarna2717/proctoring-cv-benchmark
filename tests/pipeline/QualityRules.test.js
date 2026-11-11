import { describe, expect, it } from "vitest";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import { ViolationEngine } from "../../src/pipeline/ViolationEngine.js";

/**
 * @param {number} at
 * @param {{ lighting?: string[] | null, image?: string[] | null }} [reasons] null = undecided
 */
function qualitySample(at, { lighting = [], image = [] } = {}) {
  const part = (list) =>
    list === null
      ? { state: "undecided", reasons: [], reason: "no face hint" }
      : { state: list.length > 0 ? "issue" : "ok", reasons: list, reason: null };
  return { at, lighting: part(lighting), image: part(image), values: {} };
}

function createEngine() {
  const config = structuredClone(DEFAULT_LAB_CONFIG.violations);
  const engine = new ViolationEngine(config, {
    attentionSourceEngineId: "face-landmarker",
    qualitySourceEngineId: "image-quality",
  });
  const events = [];
  engine.onEvent((event) => events.push(event));
  return { engine, events };
}

const starts = (events, type) =>
  events.filter((e) => e.type === "violation-start" && e.violation.type === type);

describe("LIGHTING_ISSUE and LOW_IMAGE_QUALITY", () => {
  it("start after 5 s of issues at 1 FPS, with the reasons seen, most frequent first", () => {
    const { engine, events } = createEngine();
    for (let at = 0; at <= 5000; at += 1000) {
      engine.observeQuality(
        qualitySample(at, { lighting: at === 2000 ? ["dark", "backlit"] : ["backlit"] }),
      );
    }
    const [start] = starts(events, "LIGHTING_ISSUE");
    expect(start.violation).toMatchObject({
      startedAt: 0,
      confirmedAt: 5000,
      severity: "low",
      reasons: ["backlit", "dark"],
      sourceEngineId: "image-quality",
      imageIssues: null,
    });
    expect(starts(events, "LOW_IMAGE_QUALITY")).toEqual([]);
  });

  it("ignore shorter problems (motion blur, an exposure change)", () => {
    const { engine, events } = createEngine();
    for (let at = 0; at <= 3000; at += 1000)
      engine.observeQuality(qualitySample(at, { image: ["blurry"] }));
    engine.observeQuality(qualitySample(4000));
    expect(events).toEqual([]);
  });

  it("skip undecided samples and use their own gap limit (5 s) instead of the face rules' 2 s", () => {
    const { engine, events } = createEngine();
    engine.observeQuality(qualitySample(0, { image: ["blurry"] }));
    engine.observeQuality(qualitySample(1000, { image: null })); // no face: skipped
    engine.observeQuality(qualitySample(4000, { image: ["blurry"] })); // 3 s gap: still one run
    engine.observeQuality(qualitySample(5000, { image: ["blurry"] }));
    expect(starts(events, "LOW_IMAGE_QUALITY")[0].violation).toMatchObject({
      startedAt: 0,
      reasons: ["blurry"],
    });
    engine.observeQuality(qualitySample(11_500, { image: ["blurry"] })); // 6.5 s gap
    expect(events.find((e) => e.type === "violation-end").violation).toMatchObject({
      type: "LOW_IMAGE_QUALITY",
      endReason: "data-gap",
      endedAt: 5000,
    });
  });
});

describe("image issues on other violations", () => {
  const away = (at) => ({
    at,
    baseline: "calibration",
    gaze: {
      state: "away",
      reason: null,
      yawDeg: 30,
      pitchDeg: 0,
      excessDeg: 5,
      direction: "right",
    },
    head: { state: "ok", reason: null, yawDeg: 0, pitchDeg: 0, excessDeg: -10, direction: null },
    eyes: { state: "open", reason: null, closure: 0.05, earRatio: 1 },
  });
  const lookAway = (engine, from) => {
    for (let at = from; at <= from + 600; at += 200) engine.observeAttention(away(at));
  };

  it("records the latest quality reasons when another violation starts", () => {
    const { engine, events } = createEngine();
    engine.observeQuality(qualitySample(0, { lighting: ["dark"], image: ["blurry"] }));
    lookAway(engine, 500);
    expect(starts(events, "GAZE_AWAY")[0].violation.imageIssues).toEqual(["dark", "blurry"]);
  });

  it("records [] for a good image and null without a recent quality sample", () => {
    const { engine, events } = createEngine();
    engine.observeQuality(qualitySample(0));
    lookAway(engine, 500);
    expect(starts(events, "GAZE_AWAY")[0].violation.imageIssues).toEqual([]);
    const other = createEngine();
    other.engine.observeQuality(qualitySample(0, { lighting: ["dark"] }));
    lookAway(other.engine, 10_000);
    expect(starts(other.events, "GAZE_AWAY")[0].violation.imageIssues).toBeNull();
  });
});
