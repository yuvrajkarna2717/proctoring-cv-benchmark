/**
 * Zoom pass for the object detectors: besides the whole frame, the detector also runs on
 * overlapping square crops of the full-resolution frame, so small objects (a phone held at arm's
 * length is 60–120 px wide in a 1280×720 frame) are larger in the model input. Detections of all
 * passes are mapped to the frame and merged with per-class NMS.
 *
 * Modes:
 * - `off`: the whole frame only.
 * - `tiles`: plus squares as tall as the frame (two for 16:9), about 1.8× larger objects.
 * - `fine`: plus squares of 3/4 of the frame height (six for 16:9), about 2.4× larger objects.
 *
 * @typedef {'off' | 'tiles' | 'fine'} ZoomMode
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect frame pixels
 */

export const ZOOM_MODES = /** @type {const} */ (["off", "tiles", "fine"]);

/** Tile side as a share of the shorter frame side. */
const TILE_SIDE = { tiles: 1, fine: 0.75 };
/** Neighbouring tiles overlap by at least this share of a tile, so objects on a seam are whole in one. */
const MIN_OVERLAP = 0.2;

/**
 * The passes for a frame: the whole frame first, then the tiles row by row.
 *
 * @param {number} width
 * @param {number} height
 * @param {ZoomMode} mode
 * @returns {Rect[]}
 */
export function objectTiles(width, height, mode) {
  const full = { x: 0, y: 0, width, height };
  if (mode === "off") return [full];
  const side = Math.round(Math.min(width, height) * TILE_SIDE[mode]);
  const xs = positions(width, side);
  const ys = positions(height, side);
  // A single tile equal to the frame adds nothing.
  if (xs.length === 1 && ys.length === 1 && side === width && side === height) return [full];
  const tiles = [];
  for (const y of ys) for (const x of xs) tiles.push({ x, y, width: side, height: side });
  return [full, ...tiles];
}

/**
 * Evenly spaced tile starts along one side, with at least MIN_OVERLAP between neighbours.
 *
 * @param {number} length
 * @param {number} side
 */
function positions(length, side) {
  if (side >= length) return [0];
  let count = Math.ceil(length / side);
  while (count > 1 && (count * side - length) / (count - 1) < MIN_OVERLAP * side) count += 1;
  return Array.from({ length: count }, (_, i) => Math.round((i * (length - side)) / (count - 1)));
}

/**
 * A box normalized to a pass's rectangle → normalized to the frame.
 *
 * @param {{ x: number, y: number, width: number, height: number }} box normalized to `rect`
 * @param {Rect} rect
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
export function rectBoxToFrame(box, rect, frameWidth, frameHeight) {
  return {
    x: (rect.x + box.x * rect.width) / frameWidth,
    y: (rect.y + box.y * rect.height) / frameHeight,
    width: (box.width * rect.width) / frameWidth,
    height: (box.height * rect.height) / frameHeight,
  };
}

/**
 * Merges the detections of all passes: highest score first, a box is dropped when it overlaps a
 * kept box of the same label by more than `iouThreshold`, or lies mostly (`containment`) inside
 * one. The second test removes the partial box a tile sees of an object cut by its edge.
 *
 * @template {{ label: string, score: number, box: { x: number, y: number, width: number, height: number } }} D
 * @param {D[]} detections boxes normalized to the frame
 * @param {{ frameWidth: number, frameHeight: number, iouThreshold?: number, containment?: number }} options
 * @returns {D[]}
 */
export function mergePasses(
  detections,
  { frameWidth, frameHeight, iouThreshold = 0.5, containment = 0.8 },
) {
  const px = (/** @type {D} */ d) => ({
    x1: d.box.x * frameWidth,
    y1: d.box.y * frameHeight,
    x2: (d.box.x + d.box.width) * frameWidth,
    y2: (d.box.y + d.box.height) * frameHeight,
  });
  const ordered = [...detections].sort((a, b) => b.score - a.score);
  /** @type {D[]} */
  const kept = [];
  for (const candidate of ordered) {
    const c = px(candidate);
    const area = (c.x2 - c.x1) * (c.y2 - c.y1);
    const duplicate = kept.some((other) => {
      if (other.label !== candidate.label) return false;
      const k = px(other);
      const w = Math.min(c.x2, k.x2) - Math.max(c.x1, k.x1);
      const h = Math.min(c.y2, k.y2) - Math.max(c.y1, k.y1);
      if (w <= 0 || h <= 0) return false;
      const intersection = w * h;
      const union = area + (k.x2 - k.x1) * (k.y2 - k.y1) - intersection;
      return intersection / union > iouThreshold || (area > 0 && intersection / area > containment);
    });
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}
