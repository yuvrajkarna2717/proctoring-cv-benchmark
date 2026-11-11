import { describe, expect, it } from "vitest";
import {
  describeComposition,
  equalErrorRate,
  groupCaptures,
  scoreCaptures,
  verificationMetrics,
} from "../../src/identity/calibration.js";
import {
  cosineSimilarity,
  dot,
  meanTemplate,
  sampleAgreement,
} from "../../src/identity/embeddings.js";

/** Unit vector at `degrees` in the first two dimensions. */
const at = (degrees) => {
  const rad = (degrees * Math.PI) / 180;
  return Float32Array.from([Math.cos(rad), Math.sin(rad), 0, 0]);
};

const sample = (captureId, person, degrees, index = 0) => ({
  id: `${captureId}-${index}`,
  captureId,
  person,
  conditions: { lighting: "office" },
  camera: { label: "Cam", width: 1280, height: 720 },
  capturedAt: 1000 + index,
  recognizer: { id: "ocv-sface", sha256: "x" },
  embedding: at(degrees),
  quality: {},
  captureStats: { framesOffered: 10, framesRejected: 2 },
});

describe("embedding arithmetic", () => {
  it("computes dot products, cosine similarity, and normalized mean templates", () => {
    expect(dot([1, 2], [3, 4])).toBe(11);
    expect(cosineSimilarity([2, 0], [5, 5])).toBeCloseTo(Math.SQRT1_2, 10);
    const template = meanTemplate([at(0), at(90)]);
    expect(template[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(template[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.hypot(...template)).toBeCloseTo(1, 6);
    const agreement = sampleAgreement([at(0), at(90)], template);
    expect(agreement.min).toBeCloseTo(Math.SQRT1_2, 6);
    expect(() => dot([1], [1, 2])).toThrow(RangeError);
    expect(() => meanTemplate([at(0), at(180)])).toThrow(/cancel out/);
  });
});

describe("calibration scoring", () => {
  it("compares each capture's template with samples of other captures only", () => {
    const captures = groupCaptures([
      sample("a1", "P1", 0, 0),
      sample("a1", "P1", 10, 1),
      sample("a2", "P1", 5, 0),
      sample("b1", "P2", 90, 0),
    ]);
    expect(captures.map((c) => [c.id, c.samples.length])).toEqual([
      ["a1", 2],
      ["a2", 1],
      ["b1", 1],
    ]);
    const { genuine, impostor, pairs } = scoreCaptures(captures);
    // a1→a2, a2→a1 (2 samples) genuine; a1→b1, a2→b1, b1→a1 (2), b1→a2 impostor
    expect(genuine).toHaveLength(3);
    expect(impostor).toHaveLength(5);
    expect(pairs.every((pair) => pair.referenceCapture !== pair.probeCapture)).toBe(true);
    // template of a1 points at 5°, so a2 (5°) scores 1
    expect(
      pairs.find((p) => p.referenceCapture === "a1" && p.probeCapture === "a2").score,
    ).toBeCloseTo(1, 6);
  });

  it("computes FAR and FRR at the threshold, EER, ROC, and FAR targets", () => {
    const genuine = [0.5, 0.6, 0.7, 0.8];
    const impostor = [0.1, 0.2, 0.3, 0.55];
    const metrics = verificationMetrics(genuine, impostor, 0.4);
    expect(metrics.atThreshold).toEqual({
      threshold: 0.4,
      far: 0.25, // 0.55
      frr: 0,
      falseAccepts: 1,
      falseRejects: 0,
    });
    expect(verificationMetrics(genuine, impostor, 0.6).atThreshold).toMatchObject({
      far: 0,
      frr: 0.25,
    });
    // FAR = FRR = 0.25 between thresholds 0.55 and 0.6
    expect(metrics.eer.rate).toBeCloseTo(0.25, 10);
    expect(metrics.eer.threshold).toBeGreaterThanOrEqual(0.5);
    expect(metrics.eer.threshold).toBeLessThanOrEqual(0.6);
    expect(metrics.roc[0]).toMatchObject({ threshold: null, far: 1, tar: 1 });
    expect(metrics.roc.at(-1)).toMatchObject({ threshold: null, far: 0, tar: 0 });
    expect(metrics.farTargets[0]).toEqual({
      far: 0.01,
      threshold: 0.6,
      frr: 0.25,
      measurable: false,
    });
    expect(metrics.minMeasurableFar).toBe(0.25);
    expect(metrics.histogram.genuine.reduce((a, b) => a + b, 0)).toBe(4);
    expect(JSON.parse(JSON.stringify(metrics))).toEqual(metrics);
  });

  it("finds an EER of 0 for separable scores and interpolates where the curves cross", () => {
    expect(verificationMetrics([0.8, 0.9], [0.1, 0.2], 0.5).eer.rate).toBe(0);
    const curve = [
      { threshold: 0, far: 1, frr: 0 },
      { threshold: 1, far: 0.2, frr: 0.6 },
    ];
    // FAR − FRR goes from 1 to −0.4, so it crosses zero at w = 1/1.4 of the interval.
    const eer = equalErrorRate(curve);
    expect(eer.rate).toBeCloseTo(0.6 / 1.4, 6);
    expect(eer.threshold).toBeCloseTo(1 / 1.4, 6);
  });

  it("reports missing rates as null instead of guessing", () => {
    const metrics = verificationMetrics([0.7], [], 0.4);
    expect(metrics.atThreshold).toMatchObject({ far: null, frr: 0 });
    expect(metrics.eer).toBeNull();
    expect(metrics.roc).toEqual([]);
  });

  it("describes who and what the test set contains", () => {
    const captures = groupCaptures([
      sample("a1", "P1", 0),
      sample("a2", "P1", 5),
      sample("b1", "P2", 90),
    ]);
    expect(describeComposition(captures)).toMatchObject({
      personCount: 2,
      captureCount: 3,
      sampleCount: 3,
      conditionsByCapture: { lighting: { office: 3 } },
      cameras: ["Cam"],
    });
  });
});
