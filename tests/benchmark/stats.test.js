import { describe, expect, it } from "vitest";
import {
  IntervalEstimator,
  RingBuffer,
  SlidingWindowRate,
  percentileOfSorted,
  summarize,
} from "../../src/benchmark/stats.js";

describe("percentileOfSorted (linear interpolation, type 7)", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("matches NumPy/Excel PERCENTILE.INC on 1..100", () => {
    expect(percentileOfSorted(oneToHundred, 0)).toBe(1);
    expect(percentileOfSorted(oneToHundred, 50)).toBeCloseTo(50.5, 10);
    expect(percentileOfSorted(oneToHundred, 95)).toBeCloseTo(95.05, 10);
    expect(percentileOfSorted(oneToHundred, 99)).toBeCloseTo(99.01, 10);
    expect(percentileOfSorted(oneToHundred, 100)).toBe(100);
  });

  it("interpolates between two values", () => {
    expect(percentileOfSorted([10, 20], 25)).toBeCloseTo(12.5, 10);
  });

  it("handles empty and single-element input", () => {
    expect(percentileOfSorted([], 50)).toBeNull();
    expect(percentileOfSorted([7], 99)).toBe(7);
  });

  it("rejects percentiles outside [0, 100]", () => {
    expect(() => percentileOfSorted([1, 2], -1)).toThrow(RangeError);
    expect(() => percentileOfSorted([1, 2], 101)).toThrow(RangeError);
    expect(() => percentileOfSorted([1, 2], Number.NaN)).toThrow(RangeError);
  });
});

describe("summarize", () => {
  it("returns nulls and count 0 for an empty sample", () => {
    expect(summarize([])).toEqual({
      count: 0,
      mean: null,
      median: null,
      p95: null,
      p99: null,
      min: null,
      max: null,
      stdDev: null,
    });
  });

  it("computes mean and sample standard deviation", () => {
    const summary = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(summary.count).toBe(8);
    expect(summary.mean).toBe(5);
    expect(summary.stdDev).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(summary.min).toBe(2);
    expect(summary.max).toBe(9);
    expect(summary.median).toBe(4.5);
  });

  it("sorts numerically, not lexicographically", () => {
    // A string sort would order these as [10, 100, 9] and report 100 as the median.
    expect(summarize([10, 9, 100]).median).toBe(10);
  });

  it("ignores non-finite values", () => {
    const summary = summarize([1, Number.NaN, 3, Infinity, -Infinity]);
    expect(summary.count).toBe(2);
    expect(summary.mean).toBe(2);
  });

  it("reports zero deviation for a single sample", () => {
    expect(summarize([42]).stdDev).toBe(0);
  });

  it("accepts typed arrays", () => {
    expect(summarize(new Float64Array([1, 2, 3])).mean).toBe(2);
  });
});

describe("RingBuffer", () => {
  it("keeps the most recent samples in insertion order", () => {
    const buffer = new RingBuffer(3);
    [1, 2, 3, 4, 5].forEach((value) => buffer.push(value));
    expect(Array.from(buffer.toArray())).toEqual([3, 4, 5]);
    expect(buffer.size).toBe(3);
    expect(buffer.totalPushed).toBe(5);
  });

  it("returns partial contents before it is full", () => {
    const buffer = new RingBuffer(4);
    buffer.push(1);
    buffer.push(2);
    expect(Array.from(buffer.toArray())).toEqual([1, 2]);
  });

  it("clears", () => {
    const buffer = new RingBuffer(2);
    buffer.push(1);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.totalPushed).toBe(0);
    buffer.push(9);
    expect(Array.from(buffer.toArray())).toEqual([9]);
  });

  it("rejects invalid capacities", () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });
});

describe("SlidingWindowRate", () => {
  it("uses elapsed time until the window is full", () => {
    const rate = new SlidingWindowRate(5000);
    rate.reset(0);
    for (let t = 200; t <= 2000; t += 200) rate.record(t); // 10 events in 2 s
    expect(rate.rate(2000)).toBeCloseTo(5, 10);
  });

  it("uses the full window once it has elapsed and expires old events", () => {
    const rate = new SlidingWindowRate(1000);
    rate.reset(0);
    for (let t = 100; t <= 3000; t += 100) rate.record(t); // 10 events per second
    expect(rate.rate(3000)).toBeCloseTo(10, 10);
    expect(rate.rate(10_000)).toBe(0);
  });

  it("returns null before the minimum span or before any start", () => {
    const rate = new SlidingWindowRate(1000);
    expect(rate.rate(100)).toBeNull();
    rate.reset(0);
    rate.record(10);
    expect(rate.rate(100)).toBeNull();
  });
});

describe("IntervalEstimator", () => {
  it("converges to a constant interval", () => {
    const estimator = new IntervalEstimator(0.5);
    for (let i = 0; i < 20; i += 1) estimator.push(i * 33.3);
    expect(estimator.value).toBeCloseTo(33.3, 5);
  });

  it("is null until two timestamps arrive", () => {
    const estimator = new IntervalEstimator();
    expect(estimator.value).toBeNull();
    estimator.push(5);
    expect(estimator.value).toBeNull();
  });
});
