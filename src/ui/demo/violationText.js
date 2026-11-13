import { formatDuration, formatNumber } from "../common/format.js";

/**
 * Wording of the demo page's violation toasts and log. Types without an entry here (rules added
 * later) fall back to the rule's label and no detail.
 *
 * @typedef {import('../../pipeline/ViolationEngine.js').Violation} Violation
 */

/** @type {Record<string, string>} */
const TITLES = {
  NO_FACE: "No face detected",
  MULTIPLE_FACES: "Multiple faces",
  FACE_MISMATCH: "Face mismatch",
  GAZE_AWAY: "Looking away",
  HEAD_TURNED: "Head turned",
  EYES_CLOSED: "Eyes closed",
  LIGHTING_ISSUE: "Lighting issue",
  PHONE_DETECTED: "Phone detected",
};

/** Directions are from the person's point of view. @type {Record<string, string>} */
const GAZE_DIRECTIONS = {
  left: "Looking left",
  right: "Looking right",
  up: "Looking up",
  down: "Looking down",
};

/** @type {Record<string, string>} */
const HEAD_DIRECTIONS = {
  left: "Turned left",
  right: "Turned right",
  up: "Tilted up",
  down: "Tilted down",
};

/** @type {Record<string, string>} */
const LIGHTING_REASONS = {
  dark: "too dark",
  "too-bright": "too bright",
  backlit: "backlit",
  "low-contrast": "low contrast",
};

/**
 * Title and one-line detail of a violation. The detail uses the violation's measures, so it
 * describes the worst moment so far (or of the whole violation once it ended).
 *
 * @param {Violation} violation
 * @param {string} [ruleLabel] label of the violation's rule, the title for unknown types
 * @returns {{ title: string, detail: string }} detail is "" for unknown types
 */
export function describeViolation(violation, ruleLabel) {
  return {
    title: TITLES[violation.type] ?? ruleLabel ?? violation.type,
    detail: detailOf(violation),
  };
}

/** Clock time of an epoch timestamp, e.g. "16:01:22". @param {number} epochMs */
export function formatTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false });
}

/** Length of a violation, e.g. "3.1 s" or "2:05 min". @param {number} ms */
export function formatLength(ms) {
  return ms < 60_000 ? `${formatNumber(ms / 1000, 1)} s` : `${formatDuration(ms)} min`;
}

/** @param {Violation} violation */
function detailOf(violation) {
  const degrees = `${formatNumber(violation.maxExcessDeg, 0)}°`;
  const direction = violation.direction ?? "";
  switch (violation.type) {
    case "NO_FACE":
      return "No one in view of the camera";
    case "MULTIPLE_FACES":
      return `${violation.maxFaceCount} faces in view`;
    case "FACE_MISMATCH":
      return `Doesn't match the enrolled face · similarity ${formatNumber(violation.minSimilarity, 2)}`;
    case "GAZE_AWAY":
      return joinParts(GAZE_DIRECTIONS[direction], `${degrees} outside the screen`);
    case "HEAD_TURNED":
      return joinParts(HEAD_DIRECTIONS[direction], `${degrees} past the limit`);
    case "EYES_CLOSED":
      return "Closed for longer than a blink";
    case "LIGHTING_ISSUE": {
      const reasons = (violation.reasons ?? []).map((reason) => LIGHTING_REASONS[reason] ?? reason);
      return reasons.length > 0 ? capitalize(reasons.join(", ")) : "Lighting unsuitable";
    }
    case "PHONE_DETECTED":
      return `${capitalize(violation.label ?? "phone")} in view · score ${formatNumber(violation.maxScore, 2)}`;
    default:
      return "";
  }
}

/** @param {Array<string | undefined>} parts */
function joinParts(...parts) {
  return parts.filter(Boolean).join(" · ");
}

/** @param {string} text */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
