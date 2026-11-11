/**
 * Descriptive statistics used by the performance monitor and benchmark reports.
 *
 * Percentiles use linear interpolation between closest ranks (Hyndman & Fan type 7), which is
 * the default of NumPy `percentile` and Excel `PERCENTILE.INC`. With small samples the high
 * percentiles are interpolated between the largest observations, so every summary carries its
 * sample count and readers should not over-interpret p99 when `count < 100`.
 */

/**
 * @param {ArrayLike<number>} sorted values in ascending order
 * @param {number} p percentile in [0, 100]
 * @returns {number | null} null when `sorted` is empty
 */
export function percentileOfSorted(sorted, p) {
  if (!(p >= 0 && p <= 100)) throw new RangeError(`Percentile must be within [0, 100], got ${p}`);
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

/**
 * @typedef {Object} Summary
 * @property {number} count number of finite samples
 * @property {number | null} mean
 * @property {number | null} median
 * @property {number | null} p95
 * @property {number | null} p99
 * @property {number | null} min
 * @property {number | null} max
 * @property {number | null} stdDev sample standard deviation (n - 1); 0 for a single sample
 */

/** @type {Readonly<Summary>} */
const EMPTY_SUMMARY = Object.freeze({
  count: 0,
  mean: null,
  median: null,
  p95: null,
  p99: null,
  min: null,
  max: null,
  stdDev: null,
});

/**
 * Summarizes a sample. Non-finite values (NaN, Infinity) are ignored.
 *
 * @param {Iterable<number> | ArrayLike<number>} values
 * @returns {Summary}
 */
export function summarize(values) {
  const finite = Array.from(/** @type {ArrayLike<number>} */ (values)).filter(Number.isFinite);
  const count = finite.length;
  if (count === 0) return { ...EMPTY_SUMMARY };

  // Typed array sort is numeric (Array.prototype.sort would compare strings).
  const sorted = Float64Array.from(finite).sort();
  let sum = 0;
  for (const value of sorted) sum += value;
  const mean = sum / count;
  let squaredDeviations = 0;
  for (const value of sorted) squaredDeviations += (value - mean) ** 2;

  return {
    count,
    mean,
    median: percentileOfSorted(sorted, 50),
    p95: percentileOfSorted(sorted, 95),
    p99: percentileOfSorted(sorted, 99),
    min: sorted[0],
    max: sorted[count - 1],
    stdDev: count > 1 ? Math.sqrt(squaredDeviations / (count - 1)) : 0,
  };
}

/**
 * Fixed-capacity numeric buffer that keeps the most recent `capacity` samples.
 * Used for live latency windows so memory stays bounded during long sessions.
 */
export class RingBuffer {
  /** @type {Float64Array} */
  #data;
  #start = 0;
  #size = 0;
  #totalPushed = 0;

  /** @param {number} capacity */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.#data = new Float64Array(capacity);
  }

  /** @param {number} value */
  push(value) {
    const capacity = this.#data.length;
    if (this.#size < capacity) {
      this.#data[(this.#start + this.#size) % capacity] = value;
      this.#size += 1;
    } else {
      this.#data[this.#start] = value;
      this.#start = (this.#start + 1) % capacity;
    }
    this.#totalPushed += 1;
  }

  /** @returns {number} samples currently held */
  get size() {
    return this.#size;
  }

  /** @returns {number} */
  get capacity() {
    return this.#data.length;
  }

  /** @returns {number} samples pushed since construction or the last clear(), including evicted ones */
  get totalPushed() {
    return this.#totalPushed;
  }

  /** @returns {Float64Array} copy of the held samples, oldest first */
  toArray() {
    const capacity = this.#data.length;
    const out = new Float64Array(this.#size);
    for (let i = 0; i < this.#size; i += 1) out[i] = this.#data[(this.#start + i) % capacity];
    return out;
  }

  clear() {
    this.#start = 0;
    this.#size = 0;
    this.#totalPushed = 0;
  }
}

/**
 * Event rate over a sliding time window, in events per second.
 *
 * Until a full window has elapsed since `reset(startTime)`, the rate is computed over the elapsed
 * time instead of the full window, so the first seconds of a run are not under-reported.
 */
export class SlidingWindowRate {
  /** @type {number[]} */
  #timestamps = [];
  #windowMs;
  /** @type {number | null} */
  #startedAt = null;

  /** @param {number} windowMs */
  constructor(windowMs) {
    if (!(windowMs > 0)) throw new RangeError(`windowMs must be positive, got ${windowMs}`);
    this.#windowMs = windowMs;
  }

  /** @param {number} startTime epoch ms at which counting starts */
  reset(startTime) {
    this.#timestamps = [];
    this.#startedAt = startTime;
  }

  /** @param {number} timestamp epoch ms of the event */
  record(timestamp) {
    if (this.#startedAt === null) this.#startedAt = timestamp;
    this.#timestamps.push(timestamp);
  }

  /**
   * @param {number} now epoch ms
   * @param {number} [minSpanMs] below this elapsed time the rate is not reported
   * @returns {number | null} events per second, or null when there is not enough elapsed time
   */
  rate(now, minSpanMs = 500) {
    if (this.#startedAt === null) return null;
    const windowStart = now - this.#windowMs;
    while (this.#timestamps.length > 0 && this.#timestamps[0] <= windowStart) {
      this.#timestamps.shift();
    }
    const span = Math.min(this.#windowMs, now - this.#startedAt);
    if (span < minSpanMs) return null;
    return (this.#timestamps.length * 1000) / span;
  }
}

/**
 * Exponentially weighted moving average of the interval between successive timestamps.
 * Used to estimate the camera frame interval from requestVideoFrameCallback ticks.
 */
export class IntervalEstimator {
  #alpha;
  /** @type {number | null} */
  #last = null;
  /** @type {number | null} */
  #value = null;

  /** @param {number} [alpha] smoothing factor in (0, 1] */
  constructor(alpha = 0.1) {
    if (!(alpha > 0 && alpha <= 1)) throw new RangeError(`alpha must be in (0, 1], got ${alpha}`);
    this.#alpha = alpha;
  }

  /** @param {number} timestamp */
  push(timestamp) {
    if (this.#last !== null) {
      const delta = timestamp - this.#last;
      if (delta > 0) {
        this.#value =
          this.#value === null ? delta : this.#value + this.#alpha * (delta - this.#value);
      }
    }
    this.#last = timestamp;
  }

  /** @returns {number | null} smoothed interval in ms */
  get value() {
    return this.#value;
  }

  reset() {
    this.#last = null;
    this.#value = null;
  }
}
