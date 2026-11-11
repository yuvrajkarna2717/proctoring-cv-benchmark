import { describe, expect, it } from "vitest";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import { evaluateGate, mostFrequentFailure } from "../../src/identity/qualityGate.js";

const GATE = DEFAULT_LAB_CONFIG.identity.enrollment.gate;
const GOOD = {
  faceCount: 1,
  source: "face",
  quality: {
    score: 0.95,
    interEyePx: 80,
    rollDeg: 2,
    yawRatio: 0.03,
    brightness: 120,
    sharpness: 60,
    inFrame: true,
  },
};

describe("quality gate", () => {
  it("passes a good frontal face and reports every check with value and limit", () => {
    const result = evaluateGate(GOOD, GATE);
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      "face",
      "singleFace",
      "score",
      "interEyePx",
      "rollDeg",
      "yawRatio",
      "brightness",
      "sharpness",
      "inFrame",
    ]);
    expect(result.checks.find((check) => check.id === "interEyePx")).toEqual({
      id: "interEyePx",
      label: "Eye distance (px)",
      value: 80,
      limit: "≥ 40",
      passed: true,
    });
  });

  it.each([
    ["two faces", { faceCount: 2 }, "singleFace"],
    ["the center-crop diagnostic", { source: "center-crop" }, "face"],
    ["a small face", { quality: { ...GOOD.quality, interEyePx: 39.9 } }, "interEyePx"],
    ["a tilted head", { quality: { ...GOOD.quality, rollDeg: -16 } }, "rollDeg"],
    ["a turned head", { quality: { ...GOOD.quality, yawRatio: -0.2 } }, "yawRatio"],
    ["a dark frame", { quality: { ...GOOD.quality, brightness: 59 } }, "brightness"],
    ["an overexposed frame", { quality: { ...GOOD.quality, brightness: 201 } }, "brightness"],
    ["a blurred frame", { quality: { ...GOOD.quality, sharpness: 19 } }, "sharpness"],
    ["a face cut by the frame edge", { quality: { ...GOOD.quality, inFrame: false } }, "inFrame"],
    ["a missing measurement", { quality: { ...GOOD.quality, score: undefined } }, "score"],
  ])("refuses %s", (_name, change, failedId) => {
    const result = evaluateGate({ ...GOOD, ...change }, GATE);
    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual([
      failedId,
    ]);
  });

  it("skips the single-face and in-frame checks when the gate does not require them", () => {
    const gate = { ...GATE, requireSingleFace: false, requireInFrame: false };
    const result = evaluateGate(
      { ...GOOD, faceCount: 3, quality: { ...GOOD.quality, inFrame: false } },
      gate,
    );
    expect(result.passed).toBe(true);
  });

  it("names the most frequent failure", () => {
    const dark = evaluateGate({ ...GOOD, quality: { ...GOOD.quality, brightness: 10 } }, GATE);
    const turned = evaluateGate({ ...GOOD, quality: { ...GOOD.quality, yawRatio: 1 } }, GATE);
    expect(mostFrequentFailure([dark, turned, turned])).toEqual({ label: "Yaw proxy", count: 2 });
    expect(mostFrequentFailure([evaluateGate(GOOD, GATE)])).toBeNull();
  });
});
