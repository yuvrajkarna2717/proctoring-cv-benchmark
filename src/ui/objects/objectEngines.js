import { OBJECT_ENGINE_KINDS } from "../../objects/objectMonitor.js";

/** Short model names for overlay labels and table cells. */
const SHORT_NAMES = {
  "mp-effdet-lite0-int8": "Lite0",
  "mp-effdet-lite2-int8": "Lite2",
  "ocv-nanodet-plus": "NanoDet",
  "ocv-yolox-s": "YOLOX",
};

/** One colour per object engine, in configuration order. */
const COLORS = ["#ff6b6b", "#f783ac", "#ffa94d", "#da77f2", "#74c0fc", "#a9e34b"];

/**
 * @typedef {ReturnType<import('../../app/LabController.js').LabController['buildSnapshot']>['engines'][number]} EngineView
 */

/**
 * The object-detection engines of a snapshot with a display colour and a short name.
 *
 * @param {EngineView[]} engines
 * @returns {Array<{ engine: EngineView, color: string, name: string }>}
 */
export function objectEngineViews(engines) {
  return engines
    .filter((engine) => OBJECT_ENGINE_KINDS.includes(engine.kind))
    .map((engine, index) => ({
      engine,
      color: COLORS[index % COLORS.length],
      name:
        SHORT_NAMES[/** @type {keyof typeof SHORT_NAMES} */ (engine.engineConfig.model)] ??
        engine.id,
    }));
}
