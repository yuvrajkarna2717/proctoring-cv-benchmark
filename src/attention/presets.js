/**
 * Strictness presets for the attention rules. Each preset sets the tolerance around the
 * person's own screen area and how long or how often looking away must last before it is
 * reported. Thresholds stay editable after choosing a preset; any edit makes the preset
 * "custom".
 *
 * The three presets keep the same structure, so "lenient" never ignores a pattern that
 * "strict" reports; it only needs more of it:
 * - a look away (GAZE_AWAY) after 3.5 s (lenient) or on the second frame away, about 0.2 s
 *   (balanced as tuned by the user for fast reports: 100 ms, clear after 100 ms, cooldown
 *   1000 ms; strict the same),
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
 * @property {Record<'GAZE_AWAY' | 'HEAD_TURNED' | 'EYES_CLOSED',
 *   Record<string, unknown>>} rules
 */

/** @type {Readonly<Record<PresetName, Readonly<AttentionPreset>>>} */
export const ATTENTION_PRESET_VALUES = Object.freeze({
  lenient: Object.freeze({
    description:
      "Wide tolerance and long durations. For open-book or typing-heavy exams; reports only clear or sustained looks away.",
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
      "The default. Blinks and looking down at the keyboard pass; a look outside the screen area of about 0.2 s (two frames) or a clearly turned head is reported.",
    attention: {
      marginDeg: 5,
      extraDownMarginDeg: 5,
      returnMarginDeg: 2,
      head: { maxYawDeg: 30, maxPitchUpDeg: 20, maxPitchDownDeg: 25 },
    },
    rules: {
      // Tuned by the user for fast reports (was 500 / 300 / 2000, first 2000 / 600 / 3000).
      // At 5 FPS: confirmed on the 2nd frame away, ended on the 2nd frame back.
      GAZE_AWAY: {
        minDurationMs: 100,
        clearAfterMs: 100,
        cooldownMs: 1000,
        escalateAfterMs: 8000,
      },
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
      // Kept at least as strict as balanced (100 / 100 / 1000 since the user's second tuning);
      // shorter would report single misread frames. Strict differs in its narrower tolerance.
      GAZE_AWAY: {
        minDurationMs: 100,
        clearAfterMs: 100,
        cooldownMs: 1000,
        escalateAfterMs: 5000,
      },
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
export const PRESET_RULE_TYPES = /** @type {const} */ (["GAZE_AWAY", "HEAD_TURNED", "EYES_CLOSED"]);

/**
 * @param {string} name
 * @returns {Readonly<AttentionPreset>}
 */
export function attentionPreset(name) {
  const preset = ATTENTION_PRESET_VALUES[/** @type {PresetName} */ (name)];
  if (!preset) throw new TypeError(`Unknown attention preset "${name}"`);
  return preset;
}
