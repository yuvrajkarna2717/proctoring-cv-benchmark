const DASH = "—";

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {number | null | undefined} value
 * @param {number} [digits]
 */
export function formatNumber(value, digits = 1) {
  return isFiniteNumber(value) ? value.toFixed(digits) : DASH;
}

/** @param {number | null | undefined} value */
export function formatInteger(value) {
  return isFiniteNumber(value) ? String(Math.round(value)) : DASH;
}

/** @param {number | null | undefined} bytes */
export function formatBytes(bytes) {
  return isFiniteNumber(bytes) ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : DASH;
}

/** @param {number | null | undefined} epochMs */
export function formatClock(epochMs) {
  if (!isFiniteNumber(epochMs)) return DASH;
  const date = new Date(epochMs);
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${date.toLocaleTimeString(undefined, { hour12: false })}.${millis}`;
}

/** A retention period in whole hours or minutes, e.g. "1 hour", "90 minutes". @param {number} ms */
export function formatRetention(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** @param {number | null | undefined} ms */
export function formatDuration(ms) {
  if (!isFiniteNumber(ms)) return DASH;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
