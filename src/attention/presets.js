/**
 * Strictness presets for the attention rules. Each preset sets the tolerance around the
 * person's own screen area and how long or how often looking away must last before it is
 * reported. Thresholds stay editable after choosing a preset; any edit makes the preset
 * "custom".
 *
 * The three presets keep the same structure, so "lenient" never ignores a pattern that
 * "strict" reports; it only needs more of it:
 * - a look away (GAZE_AWAY) after 3.5 / 0.5 / 0.3 s (balanced as tuned by the user on a real
 *   webcam: 500 ms, clear after 300 ms, cooldown 2000 ms),
 * - repeated short looks toward one direction (GAZE_AWAY_REPEATED): 6 / 4 / 3 in 30 s,
 * - a turned head (HEAD_TURNED) and closed eyes (EYES_CLOSED) after longer or shorter times.
 *
 * All values are starting points to be checked against annotated recordings (Phases 7–8).
 *
 * @typedef {'lenient' | 'balanced' | 'strict'} PresetName
 *
 * @typedef {Object} AttentionPreset
 * @property {string} description
 * @property {{ marginDeg: number, extraDownMarginDeg: number, returnMarginDeg: number,
 *   head: { maxYawDeg: number, maxPitchUpDeg: number, maxPitchDownDeg: number } }} attention
 * @property {Record<'GAZE_AWAY' | 'GAZE_AWAY_REPEATED' | 'HEAD_TURNED' | 'EYES_CLOSED',
 *   Record<string, unknown>>} rules
 */

/** @type {Readonly<Record<PresetName, Readonly<AttentionPreset>>>} */
export const ATTENTION_PRESET_VALUES = Object.freeze({
  lenient: Object.freeze({
    description:
      "Wide tolerance and long durations. For open-book or typing-heavy exams; reports only clear, sustained, or frequently repeated looks away.",
    attention: {
      marginDeg: 8,
      extraDownMarginDeg: 8,
      returnMarginDeg: 2,
      head: { maxYawDeg: 40, maxPitchUpDeg: 25, maxPitchDownDeg: 30 },
    },
    rules: {
      GAZE_AWAY: {
        minDurationMs: 3500,
        clearAfterMs: 800,
        cooldownMs: 3000,
        escalateAfterMs: 12_000,
      },
      GAZE_AWAY_REPEATED: { windowMs: 30_000, minGlances: 6, minGlanceMs: 600 },
      HEAD_TURNED: {
        minDurationMs: 2500,
        clearAfterMs: 800,
        cooldownMs: 3000,
        escalateAfterMs: 12_000,
      },
      EYES_CLOSED: {
        minDurationMs: 3000,
        clearAfterMs: 500,
        cooldownMs: 5000,
        escalateAfterMs: 15_000,
      },
    },
  }),
  balanced: Object.freeze({
    description:
      "The default. Blinks and looking down at the keyboard pass; a look outside the screen area of 0.5 s, four looks toward the same side within 30 s, or a clearly turned head are reported.",
    attention: {
      marginDeg: 5,
      extraDownMarginDeg: 5,
      returnMarginDeg: 2,
      head: { maxYawDeg: 30, maxPitchUpDeg: 20, maxPitchDownDeg: 25 },
    },
    rules: {
      // Tuned by the user on a real webcam (was 2000 / 600 / 3000).
      GAZE_AWAY: {
        minDurationMs: 500,
        clearAfterMs: 300,
        cooldownMs: 2000,
        escalateAfterMs: 8000,
      },
      GAZE_AWAY_REPEATED: { windowMs: 30_000, minGlances: 4, minGlanceMs: 400 },
      HEAD_TURNED: {
        minDurationMs: 1500,
        clearAfterMs: 600,
        cooldownMs: 3000,
        escalateAfterMs: 8000,
      },
      EYES_CLOSED: {
        minDurationMs: 2000,
        clearAfterMs: 400,
        cooldownMs: 5000,
        escalateAfterMs: 10_000,
      },
    },
  }),
  strict: Object.freeze({
    description:
      "Narrow tolerance and short durations. For closed-book exams under supervision; expect more reports that a reviewer dismisses.",
    attention: {
      marginDeg: 3,
      extraDownMarginDeg: 2,
      returnMarginDeg: 1.5,
      head: { maxYawDeg: 25, maxPitchUpDeg: 15, maxPitchDownDeg: 20 },
    },
    rules: {
      // Kept at least as strict as balanced (500 / 300 / 2000 since the user's tuning).
      GAZE_AWAY: {
        minDurationMs: 300,
        clearAfterMs: 300,
        cooldownMs: 1500,
        escalateAfterMs: 5000,
      },
      GAZE_AWAY_REPEATED: { windowMs: 30_000, minGlances: 3, minGlanceMs: 200 },
      HEAD_TURNED: {
        minDurationMs: 1000,
        clearAfterMs: 500,
        cooldownMs: 2000,
        escalateAfterMs: 5000,
      },
      EYES_CLOSED: {
        minDurationMs: 1500,
        clearAfterMs: 400,
        cooldownMs: 4000,
        escalateAfterMs: 8000,
      },
    },
  }),
});

/** The attention rule types a preset sets. */
export const PRESET_RULE_TYPES = /** @type {const} */ ([
  "GAZE_AWAY",
  "GAZE_AWAY_REPEATED",
  "HEAD_TURNED",
  "EYES_CLOSED",
]);

/**
 * @param {string} name
 * @returns {Readonly<AttentionPreset>}
 */
export function attentionPreset(name) {
  const preset = ATTENTION_PRESET_VALUES[/** @type {PresetName} */ (name)];
  if (!preset) throw new TypeError(`Unknown attention preset "${name}"`);
  return preset;
}
