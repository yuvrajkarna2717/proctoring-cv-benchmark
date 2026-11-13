/**
 * Observations and payload shared by the object-detection engines, so the rules and the UI do
 * not depend on the model family.
 *
 * - `OBJECTS`: one per frame. `value` is the number of detections reported; `metadata.best`
 *   maps each label to its highest score in the frame (the rules read this).
 * - `OBJECT` per detection: label as `value`, score as `confidence` (a model score, not a
 *   probability; the families are calibrated differently), normalized box.
 *
 * Payload `{ format: 'object-detections', imageWidth, imageHeight, detections }` for the
 * overlay.
 *
 * @typedef {import('./onnxDetectors.js').ObjectDetection} ObjectDetection
 */

/**
 * @param {ObjectDetection[]} detections normalized to the frame, highest score first
 * @param {{ width: number, height: number }} image
 * @param {{ model: string, classes: readonly string[], minScore: number, maxDetections: number }} options
 *   `classes` empty = every class
 */
export function objectResult(detections, image, options) {
  const allowed = options.classes.length > 0 ? new Set(options.classes) : null;
  const reported = detections
    .filter((d) => d.score >= options.minScore && (!allowed || allowed.has(d.label)))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxDetections);
  /** @type {Record<string, number>} */
  const best = {};
  for (const detection of reported) {
    best[detection.label] = Math.max(best[detection.label] ?? 0, round(detection.score));
  }
  return {
    observations: [
      {
        type: "OBJECTS",
        detected: reported.length > 0,
        value: reported.length,
        metadata: { best, model: options.model, minScore: options.minScore },
      },
      ...reported.map((detection) => ({
        type: "OBJECT",
        detected: true,
        confidence: round(detection.score),
        value: detection.label,
        metadata: {
          classId: detection.classId,
          box: {
            x: round(detection.box.x),
            y: round(detection.box.y),
            width: round(detection.box.width),
            height: round(detection.box.height),
          },
        },
      })),
    ],
    payload: {
      format: "object-detections",
      imageWidth: image.width,
      imageHeight: image.height,
      model: options.model,
      detections: reported.map((d) => ({ label: d.label, score: d.score, box: d.box })),
    },
  };
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
