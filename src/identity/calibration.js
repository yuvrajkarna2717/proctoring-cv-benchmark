import { dot, meanTemplate } from "./embeddings.js";

/**
 * Threshold calibration for 1:1 verification on a local test set of captures.
 *
 * A capture is a burst of embeddings of one labelled person under one set of conditions. Each
 * capture in turn serves as the reference: its samples are averaged into a template, as in
 * enrollment, and compared with every single sample of every other capture. Same person gives a
 * genuine score, different persons an impostor score. Samples are never compared with their own
 * capture, because frames of one burst are nearly identical. This mirrors live verification,
 * where single frames are compared with an enrolled template.
 *
 * Scores from one capture are correlated, so the pair counts overstate how much data there is;
 * report the number of persons and captures with every rate.
 */
export const CALIBRATION_PROTOCOL =
  "Template of each capture (normalized mean of its samples) vs every sample of every other capture; same person = genuine, different person = impostor; no comparisons within a capture.";

/** FAR levels for which the lowest threshold is reported. */
export const FAR_TARGETS = Object.freeze([0.01, 0.001]);

const HISTOGRAM = Object.freeze({ start: -1, binWidth: 0.05, bins: 40 });
const MAX_ROC_POINTS = 400;

/**
 * @typedef {Object} CalibrationSample
 * @property {string} id
 * @property {string} captureId
 * @property {string} person label entered by the user
 * @property {Record<string, string>} conditions e.g. lighting, pose, distance
 * @property {{ label: string, width: number, height: number } | null} camera
 * @property {number} capturedAt epoch ms of the frame
 * @property {{ id: string, sha256: string | null }} recognizer
 * @property {Float32Array} embedding
 * @property {Record<string, unknown>} quality
 * @property {{ framesOffered: number, framesRejected: number }} captureStats
 *
 * @typedef {Object} Capture
 * @property {string} id
 * @property {string} person
 * @property {Record<string, string>} conditions
 * @property {{ label: string, width: number, height: number } | null} camera
 * @property {number} capturedAt first sample
 * @property {{ framesOffered: number, framesRejected: number }} captureStats
 * @property {CalibrationSample[]} samples
 *
 * @typedef {{ score: number, genuine: boolean, referenceCapture: string, probeCapture: string,
 *   probeSample: string }} ScoredPair
 */

/**
 * @param {CalibrationSample[]} samples
 * @returns {Capture[]} in order of first appearance
 */
export function groupCaptures(samples) {
  /** @type {Map<string, Capture>} */
  const captures = new Map();
  for (const sample of samples) {
    let capture = captures.get(sample.captureId);
    if (!capture) {
      capture = {
        id: sample.captureId,
        person: sample.person,
        conditions: sample.conditions,
        camera: sample.camera,
        capturedAt: sample.capturedAt,
        captureStats: sample.captureStats,
        samples: [],
      };
      captures.set(sample.captureId, capture);
    }
    capture.samples.push(sample);
    capture.capturedAt = Math.min(capture.capturedAt, sample.capturedAt);
  }
  return [...captures.values()];
}

/**
 * @param {Capture[]} captures
 * @returns {{ genuine: number[], impostor: number[], pairs: ScoredPair[] }}
 */
export function scoreCaptures(captures) {
  /** @type {number[]} */
  const genuine = [];
  /** @type {number[]} */
  const impostor = [];
  /** @type {ScoredPair[]} */
  const pairs = [];
  for (const reference of captures) {
    const template = meanTemplate(reference.samples.map((sample) => sample.embedding));
    for (const probe of captures) {
      if (probe.id === reference.id) continue;
      const isGenuine = probe.person === reference.person;
      for (const sample of probe.samples) {
        const score = dot(template, sample.embedding);
        (isGenuine ? genuine : impostor).push(score);
        pairs.push({
          score,
          genuine: isGenuine,
          referenceCapture: reference.id,
          probeCapture: probe.id,
          probeSample: sample.id,
        });
      }
    }
  }
  return { genuine, impostor, pairs };
}

/**
 * FAR (impostor scores ≥ t) and FRR (genuine scores < t) over thresholds, EER, ROC, and score
 * histograms. Rates are null when the scores they need are missing.
 *
 * @param {number[]} genuineScores
 * @param {number[]} impostorScores
 * @param {number} threshold the threshold in use (FACE_MISMATCH similarityThreshold)
 */
export function verificationMetrics(genuineScores, impostorScores, threshold) {
  const genuine = [...genuineScores].sort((a, b) => a - b);
  const impostor = [...impostorScores].sort((a, b) => a - b);
  const G = genuine.length;
  const I = impostor.length;
  /** @param {number} t */
  const frr = (t) => (G > 0 ? lowerBound(genuine, t) / G : null);
  /** @param {number} t */
  const far = (t) => (I > 0 ? (I - lowerBound(impostor, t)) / I : null);

  const candidates = [
    -Infinity,
    ...[...new Set([...genuine, ...impostor])].sort((a, b) => a - b),
    Infinity,
  ];
  const curve = candidates.map((t) => ({ threshold: t, far: far(t), frr: frr(t) }));

  return {
    genuineCount: G,
    impostorCount: I,
    atThreshold: {
      threshold,
      far: far(threshold),
      frr: frr(threshold),
      falseAccepts: I > 0 ? I - lowerBound(impostor, threshold) : null,
      falseRejects: G > 0 ? lowerBound(genuine, threshold) : null,
    },
    eer: G > 0 && I > 0 ? equalErrorRate(/** @type {any} */ (curve)) : null,
    farTargets: FAR_TARGETS.map((target) => thresholdForFar(/** @type {any} */ (curve), target, I)),
    minMeasurableFar: I > 0 ? 1 / I : null,
    roc:
      G > 0 && I > 0
        ? downsample(
            curve.map((point) => ({
              threshold: point.threshold,
              far: /** @type {number} */ (point.far),
              tar: 1 - /** @type {number} */ (point.frr),
            })),
            MAX_ROC_POINTS,
          ).map(finiteThreshold)
        : [],
    histogram: {
      start: HISTOGRAM.start,
      binWidth: HISTOGRAM.binWidth,
      genuine: histogram(genuine),
      impostor: histogram(impostor),
    },
    genuineStats: summary(genuine),
    impostorStats: summary(impostor),
  };
}

/**
 * Where FAR and FRR cross, linearly interpolated between the two neighbouring thresholds.
 *
 * @param {Array<{ threshold: number, far: number, frr: number }>} curve thresholds ascending
 * @returns {{ rate: number, threshold: number }}
 */
export function equalErrorRate(curve) {
  for (let i = 1; i < curve.length; i += 1) {
    const before = curve[i - 1];
    const after = curve[i];
    const d0 = before.far - before.frr;
    const d1 = after.far - after.frr;
    if (d1 > 0) continue;
    const w = d0 === d1 ? 0 : d0 / (d0 - d1);
    const rate = before.far + w * (after.far - before.far);
    let threshold;
    if (Number.isFinite(before.threshold) && Number.isFinite(after.threshold)) {
      threshold = before.threshold + w * (after.threshold - before.threshold);
    } else {
      threshold = Number.isFinite(after.threshold) ? after.threshold : before.threshold;
    }
    return { rate, threshold };
  }
  const last = curve[curve.length - 1];
  return { rate: last.far, threshold: last.threshold };
}

/**
 * The lowest threshold whose FAR is at most `target`, and the FRR there. `measurable` is false
 * when there are fewer than 1/target impostor scores, so FAR cannot be resolved that finely.
 *
 * @param {Array<{ threshold: number, far: number | null, frr: number | null }>} curve
 * @param {number} target
 * @param {number} impostorCount
 */
function thresholdForFar(curve, target, impostorCount) {
  if (impostorCount === 0) return { far: target, threshold: null, frr: null, measurable: false };
  const point = curve.find((p) => /** @type {number} */ (p.far) <= target);
  return {
    far: target,
    threshold: point && Number.isFinite(point.threshold) ? point.threshold : null,
    frr: point ? point.frr : null,
    measurable: impostorCount >= Math.ceil(1 / target),
  };
}

/**
 * Index of the first element ≥ value in an ascending array.
 *
 * @param {number[]} sorted
 * @param {number} value
 */
function lowerBound(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** @param {number[]} scores */
function histogram(scores) {
  const counts = new Array(HISTOGRAM.bins).fill(0);
  for (const score of scores) {
    const bin = Math.floor((score - HISTOGRAM.start) / HISTOGRAM.binWidth);
    counts[Math.min(HISTOGRAM.bins - 1, Math.max(0, bin))] += 1;
  }
  return counts;
}

/** @param {number[]} sorted ascending */
function summary(sorted) {
  if (sorted.length === 0) return null;
  return {
    min: sorted[0],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    max: sorted[sorted.length - 1],
  };
}

/**
 * Keeps the first and last point and evenly spaced points in between.
 *
 * @template T
 * @param {T[]} points
 * @param {number} limit
 * @returns {T[]}
 */
function downsample(points, limit) {
  if (points.length <= limit) return points;
  const step = (points.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => points[Math.round(index * step)]);
}

/**
 * ±Infinity thresholds become null so results survive JSON.
 *
 * @template {{ threshold: number }} T
 * @param {T} point
 */
function finiteThreshold(point) {
  return { ...point, threshold: Number.isFinite(point.threshold) ? point.threshold : null };
}

/**
 * Who and what the test set contains, for documenting a calibration run.
 *
 * @param {Capture[]} captures
 */
export function describeComposition(captures) {
  /** @type {Map<string, { person: string, captures: number, samples: number, conditions: string[] }>} */
  const persons = new Map();
  /** @type {Record<string, Record<string, number>>} */
  const conditions = {};
  const cameras = new Set();
  for (const capture of captures) {
    const entry = persons.get(capture.person) ?? {
      person: capture.person,
      captures: 0,
      samples: 0,
      conditions: [],
    };
    entry.captures += 1;
    entry.samples += capture.samples.length;
    entry.conditions.push(
      Object.values(capture.conditions)
        .filter((value) => value)
        .join(", "),
    );
    persons.set(capture.person, entry);
    for (const [key, value] of Object.entries(capture.conditions)) {
      if (!value) continue;
      conditions[key] ??= {};
      conditions[key][value] = (conditions[key][value] ?? 0) + 1;
    }
    if (capture.camera?.label) cameras.add(capture.camera.label);
  }
  return {
    persons: [...persons.values()],
    personCount: persons.size,
    captureCount: captures.length,
    sampleCount: captures.reduce((sum, capture) => sum + capture.samples.length, 0),
    conditionsByCapture: conditions,
    cameras: [...cameras],
  };
}
