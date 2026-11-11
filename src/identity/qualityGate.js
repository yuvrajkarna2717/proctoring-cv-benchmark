/**
 * Quality gates for face embeddings: which frames may be enrolled, compared, or used for
 * calibration. A gate returns every check with its measured value and limit, so the UI can show
 * why a frame was refused.
 *
 * @typedef {Object} GateCheck
 * @property {string} id
 * @property {string} label
 * @property {number | string | boolean | null} value measured value (null when not measured)
 * @property {string} limit human-readable requirement
 * @property {boolean} passed
 *
 * @typedef {{ passed: boolean, checks: GateCheck[] }} GateResult
 *
 * @typedef {Object} EmbeddedFrame what the gate looks at for one frame
 * @property {number} faceCount faces found in the frame
 * @property {'face' | 'center-crop' | null} source what was embedded; null when nothing was
 * @property {Partial<import('../engines/verification/FaceVerificationEngine.js').FaceQuality>} quality
 */

/**
 * @param {EmbeddedFrame} frame
 * @param {import('../config/schema.js').QualityGate} gate
 * @returns {GateResult}
 */
export function evaluateGate(frame, gate) {
  const q = frame.quality;
  /** @type {GateCheck[]} */
  const checks = [
    {
      id: "face",
      label: "Face embedded",
      value: frame.source,
      limit: "a detected face (not the center-crop diagnostic)",
      passed: frame.source === "face",
    },
  ];
  if (gate.requireSingleFace) {
    checks.push({
      id: "singleFace",
      label: "Faces in frame",
      value: frame.faceCount,
      limit: "exactly 1",
      passed: frame.faceCount === 1,
    });
  }
  checks.push(
    atLeast("score", "Detector score", q.score, gate.minScore),
    atLeast("interEyePx", "Eye distance (px)", q.interEyePx, gate.minInterEyePx),
    atMostAbs("rollDeg", "Head roll (°)", q.rollDeg, gate.maxAbsRollDeg),
    atMostAbs("yawRatio", "Yaw proxy", q.yawRatio, gate.maxAbsYawRatio),
    {
      id: "brightness",
      label: "Brightness",
      value: finiteOrNull(q.brightness),
      limit: `${gate.minBrightness}–${gate.maxBrightness}`,
      passed:
        Number.isFinite(q.brightness) &&
        /** @type {number} */ (q.brightness) >= gate.minBrightness &&
        /** @type {number} */ (q.brightness) <= gate.maxBrightness,
    },
    atLeast("sharpness", "Sharpness", q.sharpness, gate.minSharpness),
  );
  if (gate.requireInFrame) {
    checks.push({
      id: "inFrame",
      label: "Face fully in frame",
      value: q.inFrame ?? null,
      limit: "yes",
      passed: q.inFrame === true,
    });
  }
  return { passed: checks.every((check) => check.passed), checks };
}

/**
 * The check that failed most often across gate results, for messages such as "most frames
 * failed: Yaw proxy".
 *
 * @param {GateResult[]} results
 * @returns {{ label: string, count: number } | null}
 */
export function mostFrequentFailure(results) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const result of results) {
    for (const check of result.checks) {
      if (!check.passed) counts.set(check.label, (counts.get(check.label) ?? 0) + 1);
    }
  }
  let best = null;
  for (const [label, count] of counts) {
    if (!best || count > best.count) best = { label, count };
  }
  return best;
}

/**
 * @param {string} id
 * @param {string} label
 * @param {number | undefined} value
 * @param {number} min
 * @returns {GateCheck}
 */
function atLeast(id, label, value, min) {
  return {
    id,
    label,
    value: finiteOrNull(value),
    limit: `≥ ${min}`,
    passed: Number.isFinite(value) && /** @type {number} */ (value) >= min,
  };
}

/**
 * @param {string} id
 * @param {string} label
 * @param {number | undefined} value
 * @param {number} max
 * @returns {GateCheck}
 */
function atMostAbs(id, label, value, max) {
  return {
    id,
    label,
    value: finiteOrNull(value),
    limit: `|x| ≤ ${max}`,
    passed: Number.isFinite(value) && Math.abs(/** @type {number} */ (value)) <= max,
  };
}

/** @param {unknown} value */
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
