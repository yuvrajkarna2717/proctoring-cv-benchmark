/**
 * Classifies each face-landmarker frame as looking at the screen or away, head turned or not,
 * and eyes open or closed, relative to the person's own baseline. Pure logic, no browser APIs.
 *
 * Why relative: where "looking at the screen" points depends on where the camera sits, how big
 * and how far the screen is, and how the person sits. A fixed angle limit is too strict for one
 * setup and too loose for another. The baseline is either a calibration (the person looks at
 * targets on the screen) or, until there is one, the median gaze over the first seconds.
 *
 * Every sample keeps the measured angles, so a reviewer can see how far outside the screen
 * area a look went, and in which direction.
 *
 * Angles are degrees from the person's point of view: yaw > 0 is to their right, pitch > 0 up.
 */

/**
 * @typedef {'left' | 'right' | 'up' | 'down'} Direction
 *
 * @typedef {Object} AttentionFrame measurements of the primary face in one frame
 * @property {number} at capture time, epoch ms
 * @property {number} faceCount
 * @property {{ yawDeg: number, pitchDeg: number, rollDeg: number } | null} head
 * @property {{ yawDeg: number, pitchDeg: number, eyeWidthPx: number | null } | null} gaze
 * @property {{ blinkLeft: number | null, blinkRight: number | null, earLeft: number | null,
 *   earRight: number | null } | null} eyes
 *
 * @typedef {Object} ScreenExtent degrees from the centre to each edge of the screen
 * @property {number} leftDeg
 * @property {number} rightDeg
 * @property {number} upDeg
 * @property {number} downDeg
 *
 * @typedef {Object} AttentionProfile the baseline every sample is measured against
 * @property {'calibration' | 'learned'} source
 * @property {number} createdAt epoch ms
 * @property {{ yawDeg: number, pitchDeg: number }} gazeCenter gaze at the screen centre
 * @property {ScreenExtent} screen measured (calibration) or the configured default
 * @property {{ yawDeg: number, pitchDeg: number }} headCenter head pose at the screen centre
 * @property {number | null} openEar eye aspect ratio with open eyes
 * @property {number} samples frames the profile was built from
 * @property {Record<string, unknown>=} details calibration targets and checks
 *
 * @typedef {Object} AttentionSample one classified frame
 * @property {number} at
 * @property {'calibration' | 'learned' | null} baseline
 * @property {{ state: 'on' | 'away' | 'undecided', reason: string | null, yawDeg: number | null,
 *   pitchDeg: number | null, excessDeg: number | null, direction: Direction | null }} gaze
 *   yaw and pitch relative to the screen centre; excess > 0 is how far outside the tolerated
 *   area the gaze is
 * @property {{ state: 'ok' | 'turned' | 'undecided', reason: string | null,
 *   yawDeg: number | null, pitchDeg: number | null, excessDeg: number | null,
 *   direction: Direction | null }} head relative to the baseline head pose
 * @property {{ state: 'open' | 'closed' | 'undecided', reason: string | null,
 *   closure: number | null, earRatio: number | null }} eyes closure is the mean blink score
 */

/**
 * Reads the attention observations of a face-landmarker result (see attentionObservations in
 * FaceLandmarkerEngine.js).
 *
 * @param {Pick<import('../engines/EngineContract.js').DetectionResult, 'frameCaptureTime' | 'observations'>} result
 * @returns {AttentionFrame | null} null when the result has no FACE_COUNT
 */
export function readAttentionFrame(result) {
  const find = (/** @type {string} */ type) => result.observations.find((o) => o.type === type);
  const count = find("FACE_COUNT")?.value;
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  const head = find("HEAD_POSE");
  const gaze = find("EYE_GAZE");
  const eyes = find("EYE_STATE");
  const meta = (/** @type {any} */ observation) => observation?.metadata ?? {};
  return {
    at: result.frameCaptureTime,
    faceCount: count,
    head:
      head?.detected && finite(meta(head).yawDeg, meta(head).pitchDeg)
        ? {
            yawDeg: meta(head).yawDeg,
            pitchDeg: meta(head).pitchDeg,
            rollDeg: meta(head).rollDeg ?? 0,
          }
        : null,
    gaze:
      gaze?.detected && finite(meta(gaze).yawDeg, meta(gaze).pitchDeg)
        ? {
            yawDeg: meta(gaze).yawDeg,
            pitchDeg: meta(gaze).pitchDeg,
            eyeWidthPx: meta(gaze).eyeWidthPx ?? null,
          }
        : null,
    eyes: eyes?.detected
      ? {
          blinkLeft: meta(eyes).blinkLeft ?? null,
          blinkRight: meta(eyes).blinkRight ?? null,
          earLeft: meta(eyes).earLeft ?? null,
          earRight: meta(eyes).earRight ?? null,
        }
      : null,
  };
}

/**
 * Tolerated gaze area around the screen centre: the screen plus the margins.
 *
 * @param {AttentionProfile} profile
 * @param {import('../config/schema.js').AttentionConfig} config
 */
export function gazeLimits(profile, config) {
  return {
    leftDeg: profile.screen.leftDeg + config.marginDeg,
    rightDeg: profile.screen.rightDeg + config.marginDeg,
    upDeg: profile.screen.upDeg + config.marginDeg,
    downDeg: profile.screen.downDeg + config.marginDeg + config.extraDownMarginDeg,
  };
}

/**
 * How far a point lies outside a box around the origin, and toward which side. Inside the box
 * the excess is negative: minus the distance to the nearest edge.
 *
 * @param {number} yaw > 0 right
 * @param {number} pitch > 0 up
 * @param {ScreenExtent} limits
 * @returns {{ excessDeg: number, direction: Direction }}
 */
export function boxExcess(yaw, pitch, limits) {
  /** @type {Array<[Direction, number]>} */
  const sides = [
    ["right", yaw - limits.rightDeg],
    ["left", -yaw - limits.leftDeg],
    ["up", pitch - limits.upDeg],
    ["down", -pitch - limits.downDeg],
  ];
  let [direction, excessDeg] = sides[0];
  for (const [side, value] of sides) {
    if (value > excessDeg) [direction, excessDeg] = [side, value];
  }
  return { excessDeg, direction };
}

/**
 * Mean blink score and eye aspect ratio relative to the open-eye value.
 *
 * @param {NonNullable<AttentionFrame['eyes']>} eyes
 * @param {number | null} openEar
 */
export function eyeClosure(eyes, openEar) {
  const blinks = [eyes.blinkLeft, eyes.blinkRight].filter(isNumber);
  const ears = [eyes.earLeft, eyes.earRight].filter(isNumber);
  const closure = blinks.length > 0 ? mean(blinks) : null;
  const ear = ears.length > 0 ? mean(ears) : null;
  return { closure, earRatio: ear !== null && openEar ? ear / openEar : null };
}

/**
 * Stateful classifier for one stream of frames. The state is the spatial hysteresis: once the
 * gaze or head has left its area, it counts as back only `returnMarginDeg` inside it.
 */
export class AttentionClassifier {
  /** @type {import('../config/schema.js').AttentionConfig} */
  #config;
  #gazeAway = false;
  #headTurned = false;

  /** @param {import('../config/schema.js').AttentionConfig} config */
  constructor(config) {
    this.#config = config;
  }

  /** @param {import('../config/schema.js').AttentionConfig} config */
  setConfig(config) {
    this.#config = config;
  }

  reset() {
    this.#gazeAway = false;
    this.#headTurned = false;
  }

  /**
   * @param {AttentionFrame} frame
   * @param {AttentionProfile | null} profile null while no baseline exists
   * @returns {AttentionSample}
   */
  classify(frame, profile) {
    const config = this.#config;
    if (frame.faceCount === 0 || !profile) {
      const reason = frame.faceCount === 0 ? "no face" : "no baseline yet";
      this.reset();
      return {
        at: frame.at,
        baseline: profile?.source ?? null,
        gaze: undecidedGaze(reason),
        head: undecidedHead(reason),
        eyes: { state: "undecided", reason, closure: null, earRatio: null },
      };
    }

    // Head
    /** @type {AttentionSample['head']} */
    let head = undecidedHead("no head pose");
    if (frame.head) {
      const yawDeg = frame.head.yawDeg - profile.headCenter.yawDeg;
      const pitchDeg = frame.head.pitchDeg - profile.headCenter.pitchDeg;
      const { excessDeg, direction } = boxExcess(yawDeg, pitchDeg, {
        leftDeg: config.head.maxYawDeg,
        rightDeg: config.head.maxYawDeg,
        upDeg: config.head.maxPitchUpDeg,
        downDeg: config.head.maxPitchDownDeg,
      });
      this.#headTurned = this.#headTurned ? excessDeg > -config.returnMarginDeg : excessDeg > 0;
      head = {
        state: this.#headTurned ? "turned" : "ok",
        reason: null,
        yawDeg: round(yawDeg),
        pitchDeg: round(pitchDeg),
        excessDeg: round(excessDeg),
        direction: excessDeg > -config.returnMarginDeg ? direction : null,
      };
    }

    // Eyes
    /** @type {AttentionSample['eyes']} */
    let eyes = { state: "undecided", reason: "no eye landmarks", closure: null, earRatio: null };
    if (frame.eyes) {
      const { closure, earRatio } = eyeClosure(frame.eyes, profile.openEar);
      const lookingDown =
        head.pitchDeg !== null && head.pitchDeg < -config.eyes.undecidedHeadDownDeg;
      if (closure === null) {
        eyes = { state: "undecided", reason: "no blink scores", closure, earRatio };
      } else if (lookingDown) {
        eyes = { state: "undecided", reason: "head lowered", closure, earRatio };
      } else {
        const closed =
          closure >= config.eyes.closedBlinkScore &&
          (earRatio === null || earRatio <= config.eyes.closedEarRatio);
        eyes = {
          state: closed ? "closed" : "open",
          reason: null,
          closure: round(closure, 3),
          earRatio: earRatio === null ? null : round(earRatio, 3),
        };
      }
    }

    // Gaze (head and eyes together)
    /** @type {AttentionSample['gaze']} */
    let gaze;
    if (!frame.gaze) {
      gaze = undecidedGaze("no gaze estimate");
    } else if (eyes.state === "closed") {
      gaze = undecidedGaze("eyes closed");
    } else if (
      frame.gaze.eyeWidthPx !== null &&
      frame.gaze.eyeWidthPx < config.eyes.minEyeWidthPx
    ) {
      gaze = undecidedGaze("eyes too small in the image");
    } else {
      const yawDeg = frame.gaze.yawDeg - profile.gazeCenter.yawDeg;
      const pitchDeg = frame.gaze.pitchDeg - profile.gazeCenter.pitchDeg;
      const { excessDeg, direction } = boxExcess(yawDeg, pitchDeg, gazeLimits(profile, config));
      this.#gazeAway = this.#gazeAway ? excessDeg > -config.returnMarginDeg : excessDeg > 0;
      gaze = {
        state: this.#gazeAway ? "away" : "on",
        reason: null,
        yawDeg: round(yawDeg),
        pitchDeg: round(pitchDeg),
        excessDeg: round(excessDeg),
        direction: excessDeg > -config.returnMarginDeg ? direction : null,
      };
    }
    return { at: frame.at, baseline: profile.source, gaze, head, eyes };
  }
}

/**
 * Learns a baseline from the first frames after detection starts, when no calibration exists:
 * the median gaze and head pose of frames with a face and open eyes. The median ignores looks
 * away that take less than half of the learning time. The screen extent is the configured
 * default, since only a calibration can measure it.
 */
export class BaselineLearner {
  /** @type {import('../config/schema.js').AttentionConfig} */
  #config;
  /** @type {number | null} */
  #startedAt = null;
  /** @type {{ gazeYaw: number[], gazePitch: number[], headYaw: number[], headPitch: number[], ear: number[] }} */
  #values = emptyValues();

  /** @param {import('../config/schema.js').AttentionConfig} config */
  constructor(config) {
    this.#config = config;
  }

  /** @param {import('../config/schema.js').AttentionConfig} config */
  setConfig(config) {
    this.#config = config;
  }

  reset() {
    this.#startedAt = null;
    this.#values = emptyValues();
  }

  get progress() {
    return {
      startedAt: this.#startedAt,
      samples: this.#values.gazeYaw.length,
      learnMs: this.#config.baseline.learnMs,
      minSamples: this.#config.baseline.minSamples,
    };
  }

  /**
   * @param {AttentionFrame} frame
   * @returns {AttentionProfile | null} the learned profile once enough time and frames passed
   */
  observe(frame) {
    if (this.#startedAt === null) this.#startedAt = frame.at;
    if (usableForBaseline(frame)) {
      const values = this.#values;
      values.gazeYaw.push(/** @type {any} */ (frame.gaze).yawDeg);
      values.gazePitch.push(/** @type {any} */ (frame.gaze).pitchDeg);
      values.headYaw.push(/** @type {any} */ (frame.head).yawDeg);
      values.headPitch.push(/** @type {any} */ (frame.head).pitchDeg);
      const ears = [frame.eyes?.earLeft, frame.eyes?.earRight].filter(isNumber);
      if (ears.length > 0) values.ear.push(mean(ears));
    }
    const { learnMs, minSamples } = this.#config.baseline;
    if (frame.at - this.#startedAt < learnMs || this.#values.gazeYaw.length < minSamples) {
      return null;
    }
    const values = this.#values;
    return {
      source: "learned",
      createdAt: frame.at,
      gazeCenter: {
        yawDeg: round(median(values.gazeYaw)),
        pitchDeg: round(median(values.gazePitch)),
      },
      screen: { ...this.#config.defaultScreen },
      headCenter: {
        yawDeg: round(median(values.headYaw)),
        pitchDeg: round(median(values.headPitch)),
      },
      openEar: values.ear.length > 0 ? round(median(values.ear), 4) : null,
      samples: values.gazeYaw.length,
    };
  }
}

/**
 * A frame that can contribute to a baseline: one face, head pose and gaze measured, eyes
 * clearly open.
 *
 * @param {AttentionFrame} frame
 */
export function usableForBaseline(frame) {
  if (frame.faceCount !== 1 || !frame.head || !frame.gaze) return false;
  const blinks = [frame.eyes?.blinkLeft, frame.eyes?.blinkRight].filter(isNumber);
  return blinks.length === 0 || mean(blinks) < 0.3;
}

/** @param {string} reason @returns {AttentionSample['gaze']} */
function undecidedGaze(reason) {
  return {
    state: "undecided",
    reason,
    yawDeg: null,
    pitchDeg: null,
    excessDeg: null,
    direction: null,
  };
}

/** @param {string} reason @returns {AttentionSample['head']} */
function undecidedHead(reason) {
  return {
    state: "undecided",
    reason,
    yawDeg: null,
    pitchDeg: null,
    excessDeg: null,
    direction: null,
  };
}

function emptyValues() {
  return { gazeYaw: [], gazePitch: [], headYaw: [], headPitch: [], ear: [] };
}

/** @param {...unknown} values */
function finite(...values) {
  return values.every((value) => typeof value === "number" && Number.isFinite(value));
}

/** @param {unknown} value @returns {value is number} */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {number[]} values */
export function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** @param {number[]} values */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @param {number} value
 * @param {number} [digits]
 */
export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
