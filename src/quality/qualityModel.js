/**
 * Turns the image-quality engine's measurements into a per-frame assessment: is the lighting
 * usable, is the image sharp and large enough? Pure logic, no browser APIs.
 *
 * Image quality is an environment problem, not misconduct. The assessment is reported as its
 * own rule (LIGHTING_ISSUE, severity low by default) and stamped on other
 * violations (`imageIssues`), so a reviewer can see that a GAZE_AWAY or FACE_MISMATCH happened
 * in a dark or blurry image, where those measurements are less reliable.
 *
 * Each part is "ok", "issue" with its reasons, or "undecided". Without a face the face-based
 * checks cannot run; only problems visible in the whole frame (a dark or blown-out frame, a
 * low camera resolution) are reported then.
 *
 * @typedef {'dark' | 'too-bright' | 'backlit' | 'low-contrast'} LightingReason
 * @typedef {'blurry' | 'face-too-small' | 'low-resolution'} ImageReason
 *
 * @typedef {Object} QualityMeasures
 * @property {number} at frame capture time
 * @property {Record<string, any>} frame FRAME_QUALITY metadata
 * @property {Record<string, any> | null} face FACE_QUALITY metadata, null when not measured
 * @property {string | null} faceReason why the face was not measured
 *
 * @typedef {Object} QualitySample
 * @property {number} at
 * @property {{ state: 'ok' | 'issue' | 'undecided', reasons: LightingReason[], reason: string | null }} lighting
 * @property {{ state: 'ok' | 'issue' | 'undecided', reasons: ImageReason[], reason: string | null }} image
 * @property {{ frameMeanLuma: number, faceMeanLuma: number | null, backgroundMeanLuma: number | null,
 *   faceContrast: number | null, faceBrightFraction: number | null, faceSharpness: number | null,
 *   faceWidthPx: number | null, faceWidthRatio: number | null, sourceWidth: number }} values
 */

/**
 * @param {Pick<import('../engines/EngineContract.js').DetectionResult, 'frameCaptureTime' | 'observations'>} result
 * @returns {QualityMeasures | null} null without a FRAME_QUALITY observation
 */
export function readQualityMeasures(result) {
  const frame = result.observations.find((o) => o.type === "FRAME_QUALITY");
  if (!frame?.metadata) return null;
  const face = result.observations.find((o) => o.type === "FACE_QUALITY");
  return {
    at: result.frameCaptureTime,
    frame: frame.metadata,
    face: face?.detected && face.metadata ? face.metadata : null,
    faceReason: face?.detected
      ? null
      : /** @type {any} */ (face?.metadata?.reason ?? "no face measurement"),
  };
}

/**
 * @param {QualityMeasures} measures
 * @param {import('../config/schema.js').ImageQualityLabConfig} config
 * @returns {QualitySample}
 */
export function assessQuality(measures, config) {
  const { frame, face } = measures;
  const { lighting: L, image: I } = config;

  /** @type {LightingReason[]} */
  const lightingReasons = [];
  /** @type {ImageReason[]} */
  const imageReasons = [];

  if (face) {
    if (face.meanLuma < L.minFaceLuma || face.darkFraction > L.maxFaceDarkFraction) {
      lightingReasons.push("dark");
    }
    if (face.meanLuma > L.maxFaceLuma || face.brightFraction > L.maxFaceBrightFraction) {
      lightingReasons.push("too-bright");
    }
    if (
      face.backgroundMeanLuma !== null &&
      face.backgroundMeanLuma >= L.minBacklitBackgroundLuma &&
      face.meanLuma < face.backgroundMeanLuma * L.backlitRatio
    ) {
      lightingReasons.push("backlit");
    }
    if (face.stdLuma < L.minFaceContrast) lightingReasons.push("low-contrast");
    if (face.sharpness < I.minFaceSharpness) imageReasons.push("blurry");
    if (face.faceWidthPx < I.minFaceWidthPx || face.faceWidthRatio < I.minFaceWidthRatio) {
      imageReasons.push("face-too-small");
    }
  } else {
    // Without a face only whole-frame problems can be seen.
    if (frame.meanLuma < L.minFrameLuma) lightingReasons.push("dark");
    if (frame.meanLuma > L.maxFrameLuma) lightingReasons.push("too-bright");
  }
  if (frame.sourceWidth < I.minSourceWidth) imageReasons.push("low-resolution");

  const undecidedReason = face ? null : measures.faceReason;
  return {
    at: measures.at,
    lighting: {
      state: lightingReasons.length > 0 ? "issue" : face ? "ok" : "undecided",
      reasons: lightingReasons,
      reason: lightingReasons.length > 0 ? null : undecidedReason,
    },
    image: {
      state: imageReasons.length > 0 ? "issue" : face ? "ok" : "undecided",
      reasons: imageReasons,
      reason: imageReasons.length > 0 ? null : undecidedReason,
    },
    values: {
      frameMeanLuma: frame.meanLuma,
      faceMeanLuma: face?.meanLuma ?? null,
      backgroundMeanLuma: face?.backgroundMeanLuma ?? null,
      faceContrast: face?.stdLuma ?? null,
      faceBrightFraction: face?.brightFraction ?? null,
      faceSharpness: face?.sharpness ?? null,
      faceWidthPx: face?.faceWidthPx ?? null,
      faceWidthRatio: face?.faceWidthRatio ?? null,
      sourceWidth: frame.sourceWidth,
    },
  };
}

/**
 * Keeps the latest assessment and short histories for the UI.
 */
export class QualityMonitor {
  /** @type {import('../config/schema.js').ImageQualityLabConfig} */
  #config;
  /** @type {QualitySample | null} */
  #last = null;
  /** @type {Array<{ at: number, faceMeanLuma: number | null, frameMeanLuma: number, faceSharpness: number | null }>} */
  #recent = [];
  #stats = emptyStats();

  /** @param {import('../config/schema.js').ImageQualityLabConfig} config validated */
  constructor(config) {
    this.#config = structuredClone(config);
  }

  get sourceEngineId() {
    return this.#config.sourceEngineId;
  }

  get faceSourceEngineId() {
    return this.#config.faceSourceEngineId;
  }

  get config() {
    return structuredClone(this.#config);
  }

  /** @param {import('../config/schema.js').ImageQualityLabConfig} config validated */
  setConfig(config) {
    this.#config = structuredClone(config);
  }

  /**
   * @param {Pick<import('../engines/EngineContract.js').DetectionResult, 'engine' | 'frameCaptureTime' | 'observations'>} result
   * @returns {QualitySample | null}
   */
  observe(result) {
    if (result.engine !== this.#config.sourceEngineId) return null;
    const measures = readQualityMeasures(result);
    if (!measures) return null;
    const sample = assessQuality(measures, this.#config);
    this.#last = sample;
    this.#recent.push({
      at: sample.at,
      faceMeanLuma: sample.values.faceMeanLuma,
      frameMeanLuma: sample.values.frameMeanLuma,
      faceSharpness: sample.values.faceSharpness,
    });
    if (this.#recent.length > this.#config.historySize) this.#recent.shift();
    const stats = this.#stats;
    stats.frames += 1;
    stats.lighting[sample.lighting.state] += 1;
    stats.image[sample.image.state] += 1;
    for (const reason of [...sample.lighting.reasons, ...sample.image.reasons]) {
      stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
    }
    return sample;
  }

  clear() {
    this.#last = null;
    this.#recent = [];
    this.#stats = emptyStats();
  }

  getSnapshot() {
    return {
      sourceEngineId: this.#config.sourceEngineId,
      faceSourceEngineId: this.#config.faceSourceEngineId,
      config: this.config,
      last: this.#last ? structuredClone(this.#last) : null,
      recent: [...this.#recent],
      stats: structuredClone(this.#stats),
    };
  }
}

function emptyStats() {
  return {
    frames: 0,
    lighting: { ok: 0, issue: 0, undecided: 0 },
    image: { ok: 0, issue: 0, undecided: 0 },
    /** @type {Record<string, number>} frames on which each reason held */
    reasons: {},
  };
}
