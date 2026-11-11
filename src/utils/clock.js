/**
 * Epoch-aligned high-resolution clock shared by the main thread and workers.
 *
 * `performance.now()` is relative to each realm's time origin, and a worker's time origin is the
 * moment the worker started. Raw `performance.now()` values from different threads are therefore
 * not comparable. Adding `performance.timeOrigin` converts them to milliseconds since the Unix
 * epoch while keeping sub-millisecond resolution, so a frame captured on the main thread and
 * processed in a worker can be placed on one timeline.
 *
 * Cross-thread alignment is approximate: each realm samples its time origin independently.
 * Differences are normally well below one millisecond.
 */

/** @returns {number} milliseconds since the Unix epoch, high resolution */
export function epochNow() {
  return performance.timeOrigin + performance.now();
}

/**
 * Converts a DOMHighResTimeStamp of the current realm (for example the `now` argument of a
 * requestVideoFrameCallback callback) to epoch milliseconds.
 *
 * @param {number} highResTimestamp
 * @returns {number}
 */
export function toEpoch(highResTimestamp) {
  return performance.timeOrigin + highResTimestamp;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
