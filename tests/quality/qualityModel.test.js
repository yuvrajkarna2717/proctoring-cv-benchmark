import { describe, expect, it } from "vitest";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import {
  QualityMonitor,
  assessQuality,
  readQualityMeasures,
} from "../../src/quality/qualityModel.js";

const CONFIG = DEFAULT_LAB_CONFIG.imageQuality;

/** FRAME_QUALITY / FACE_QUALITY metadata of a good image, with overrides. */
const frameMeta = (overrides = {}) => ({
  meanLuma: 110,
  stdLuma: 50,
  sourceWidth: 1280,
  ...overrides,
});
const faceMeta = (overrides = {}) => ({
  meanLuma: 120,
  stdLuma: 45,
  darkFraction: 0.01,
  brightFraction: 0.02,
  backgroundMeanLuma: 100,
  sharpness: 0.2,
  faceWidthPx: 200,
  faceWidthRatio: 0.16,
  ...overrides,
});
const measures = (face = faceMeta(), frame = frameMeta()) => ({
  at: 1000,
  frame,
  face,
  faceReason: face ? null : "no face hint",
});

describe("assessQuality", () => {
  it("is ok for a well-lit, sharp, large face", () => {
    const sample = assessQuality(measures(), CONFIG);
    expect(sample.lighting).toEqual({ state: "ok", reasons: [], reason: null });
    expect(sample.image).toEqual({ state: "ok", reasons: [], reason: null });
    expect(sample.values).toMatchObject({
      faceMeanLuma: 120,
      faceSharpness: 0.2,
      sourceWidth: 1280,
    });
  });

  it.each([
    ["a dark face", { meanLuma: 40 }, ["dark"]],
    ["crushed shadows on the face", { darkFraction: 0.4 }, ["dark"]],
    ["a bright face", { meanLuma: 220 }, ["too-bright"]],
    ["blown highlights on the face", { brightFraction: 0.2 }, ["too-bright"]],
    ["a flat face", { stdLuma: 6 }, ["low-contrast"]],
    ["a window behind the person", { meanLuma: 70, backgroundMeanLuma: 190 }, ["backlit"]],
  ])("reports lighting: %s", (_name, overrides, reasons) => {
    expect(assessQuality(measures(faceMeta(overrides)), CONFIG).lighting).toEqual({
      state: "issue",
      reasons,
      reason: null,
    });
  });

  it("does not call a dark face backlit when the background is not bright", () => {
    // Face at 30% of the background, but the background (120) is below 150.
    const sample = assessQuality(
      measures(faceMeta({ meanLuma: 36, backgroundMeanLuma: 120 })),
      CONFIG,
    );
    expect(sample.lighting.reasons).toEqual(["dark"]);
  });

  it.each([
    ["a blurred face", { sharpness: 0.002 }, {}, ["blurry"]],
    ["a face narrower than 80 px", { faceWidthPx: 60 }, {}, ["face-too-small"]],
    ["a face under 8% of the frame width", { faceWidthRatio: 0.05 }, {}, ["face-too-small"]],
    ["a 320 px camera", {}, { sourceWidth: 320 }, ["low-resolution"]],
  ])("reports the image: %s", (_name, face, frame, reasons) => {
    expect(assessQuality(measures(faceMeta(face), frameMeta(frame)), CONFIG).image).toEqual({
      state: "issue",
      reasons,
      reason: null,
    });
  });

  it("without a face, reports only whole-frame problems and is otherwise undecided", () => {
    const undecided = assessQuality(measures(null), CONFIG);
    expect(undecided.lighting).toEqual({ state: "undecided", reasons: [], reason: "no face hint" });
    expect(undecided.image.state).toBe("undecided");
    expect(
      assessQuality(measures(null, frameMeta({ meanLuma: 20 })), CONFIG).lighting,
    ).toMatchObject({
      state: "issue",
      reasons: ["dark"],
    });
    expect(
      assessQuality(measures(null, frameMeta({ meanLuma: 245 })), CONFIG).lighting.reasons,
    ).toEqual(["too-bright"]);
    expect(
      assessQuality(measures(null, frameMeta({ sourceWidth: 320 })), CONFIG).image,
    ).toMatchObject({ state: "issue", reasons: ["low-resolution"] });
  });
});

describe("readQualityMeasures and QualityMonitor", () => {
  const result = (face) => ({
    engine: "image-quality",
    frameCaptureTime: 5000,
    observations: [
      { type: "FRAME_QUALITY", detected: true, metadata: frameMeta() },
      face
        ? { type: "FACE_QUALITY", detected: true, metadata: faceMeta(face) }
        : { type: "FACE_QUALITY", detected: false, metadata: { reason: "face hint 2000 ms old" } },
    ],
  });

  it("reads both observations and the reason when the face was not measured", () => {
    expect(readQualityMeasures(result({}))).toMatchObject({
      at: 5000,
      face: { meanLuma: 120 },
      faceReason: null,
    });
    expect(readQualityMeasures(result(null))).toMatchObject({
      face: null,
      faceReason: "face hint 2000 ms old",
    });
    expect(readQualityMeasures({ frameCaptureTime: 0, observations: [] })).toBeNull();
  });

  it("assesses results of its source engine, counts states and reasons, and clears", () => {
    const monitor = new QualityMonitor(CONFIG);
    expect(monitor.observe({ ...result({}), engine: "face-landmarker" })).toBeNull();
    monitor.observe(result({ meanLuma: 30 }));
    monitor.observe(result({ meanLuma: 30, sharpness: 0.001 }));
    monitor.observe(result(null));
    const snapshot = monitor.getSnapshot();
    expect(snapshot.stats).toMatchObject({
      frames: 3,
      lighting: { issue: 2, undecided: 1 },
      image: { ok: 1, issue: 1, undecided: 1 },
      reasons: { dark: 2, blurry: 1 },
    });
    expect(snapshot.recent).toHaveLength(3);
    expect(snapshot.last.lighting.reason).toBe("face hint 2000 ms old");
    monitor.clear();
    expect(monitor.getSnapshot()).toMatchObject({ last: null, recent: [], stats: { frames: 0 } });
  });
});
