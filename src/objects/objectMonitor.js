/**
 * Object-detection results on the main thread: one sample per frame from each object engine,
 * the samples of the rules' source engine passed on to the violation engine, and per-engine
 * summaries for comparing models side by side. Pure logic.
 *
 * @typedef {Object} ObjectSample
 * @property {string} engine
 * @property {number} at frame capture time
 * @property {Record<string, number>} best highest score per label in the frame
 * @property {Array<{ label: string, score: number }>} detections reported detections
 */

/** Engine kinds whose results are object samples. */
export const OBJECT_ENGINE_KINDS = Object.freeze(["mp-object-detector", "ort-object-detector"]);

/**
 * @param {Pick<import('../engines/EngineContract.js').DetectionResult, 'engine' | 'frameCaptureTime' | 'observations'>} result
 * @returns {ObjectSample | null} null without an OBJECTS observation
 */
export function readObjectSample(result) {
  const summary = result.observations.find((o) => o.type === "OBJECTS");
  if (!summary) return null;
  const best = /** @type {Record<string, number>} */ (summary.metadata?.best ?? {});
  return {
    engine: result.engine,
    at: result.frameCaptureTime,
    best: { ...best },
    detections: result.observations
      .filter((o) => o.type === "OBJECT")
      .map((o) => ({ label: String(o.value), score: o.confidence ?? 0 })),
  };
}

export class ObjectMonitor {
  /** @type {import('../config/schema.js').ObjectsLabConfig} */
  #config;
  /** @type {Map<string, { frames: number, last: ObjectSample | null, framesWith: Record<string, number>, maxScore: Record<string, number>, recent: Array<{ at: number, best: Record<string, number> }> }>} */
  #engines = new Map();

  /** @param {import('../config/schema.js').ObjectsLabConfig} config */
  constructor(config) {
    this.#config = structuredClone(config);
  }

  get sourceEngineId() {
    return this.#config.sourceEngineId;
  }

  /** @param {string} engineId */
  setSourceEngine(engineId) {
    this.#config = { ...this.#config, sourceEngineId: engineId };
  }

  /**
   * Records an object engine's result.
   *
   * @param {Parameters<typeof readObjectSample>[0]} result
   * @param {Record<string, number>} labelScores label → score at which a frame counts as
   *   containing it (the rules' limits), for the per-engine counts
   * @returns {ObjectSample | null} the sample when it comes from the rules' source engine
   */
  observe(result, labelScores) {
    const sample = readObjectSample(result);
    if (!sample) return null;
    const entry = this.#engines.get(sample.engine) ?? {
      frames: 0,
      last: null,
      framesWith: {},
      maxScore: {},
      recent: [],
    };
    entry.frames += 1;
    entry.last = sample;
    for (const [label, limit] of Object.entries(labelScores)) {
      const score = sample.best[label] ?? 0;
      if (score >= limit) entry.framesWith[label] = (entry.framesWith[label] ?? 0) + 1;
      entry.maxScore[label] = Math.max(entry.maxScore[label] ?? 0, score);
    }
    entry.recent.push({ at: sample.at, best: sample.best });
    if (entry.recent.length > this.#config.historySize) entry.recent.shift();
    this.#engines.set(sample.engine, entry);
    return sample.engine === this.#config.sourceEngineId ? sample : null;
  }

  clear() {
    this.#engines.clear();
  }

  getSnapshot() {
    return {
      sourceEngineId: this.#config.sourceEngineId,
      config: structuredClone(this.#config),
      engines: Object.fromEntries(
        [...this.#engines.entries()].map(([id, entry]) => [id, structuredClone(entry)]),
      ),
    };
  }
}
