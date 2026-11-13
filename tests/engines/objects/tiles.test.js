import { describe, expect, it } from "vitest";
import { mergePasses, objectTiles, rectBoxToFrame } from "../../../src/engines/objects/tiles.js";

describe("objectTiles", () => {
  it("is the whole frame only with zoom off", () => {
    expect(objectTiles(1280, 720, "off")).toEqual([{ x: 0, y: 0, width: 1280, height: 720 }]);
  });

  it("adds two frame-high squares for 16:9 ('tiles'), overlapping by 160 px", () => {
    expect(objectTiles(1280, 720, "tiles")).toEqual([
      { x: 0, y: 0, width: 1280, height: 720 },
      { x: 0, y: 0, width: 720, height: 720 },
      { x: 560, y: 0, width: 720, height: 720 },
    ]);
  });

  it("adds six squares of 3/4 frame height ('fine'), every neighbour overlapping", () => {
    const [, ...tiles] = objectTiles(1280, 720, "fine");
    expect(tiles.map((t) => [t.x, t.y])).toEqual([
      [0, 0],
      [370, 0],
      [740, 0],
      [0, 180],
      [370, 180],
      [740, 180],
    ]);
    expect(tiles.every((t) => t.width === 540 && t.height === 540)).toBe(true);
  });

  it("keeps at least 20% overlap and covers the frame for other sizes", () => {
    for (const [width, height] of [
      [640, 480],
      [1920, 1080],
      [720, 1280],
      [1000, 1000],
      // 1070 / 540 needs a third tile: two would overlap by 10 px only.
      [1070, 720],
    ]) {
      for (const mode of /** @type {const} */ (["tiles", "fine"])) {
        const [, ...tiles] = objectTiles(width, height, mode);
        const xs = [...new Set(tiles.map((t) => t.x))];
        const side = tiles[0]?.width ?? width;
        for (let i = 1; i < xs.length; i += 1) {
          expect(xs[i - 1] + side - xs[i]).toBeGreaterThanOrEqual(0.2 * side - 1);
        }
        if (tiles.length > 0) {
          expect(Math.max(...tiles.map((t) => t.x + t.width))).toBe(width);
          expect(Math.max(...tiles.map((t) => t.y + t.height))).toBe(height);
        }
      }
    }
  });

  it("adds a tile when two would overlap too little", () => {
    expect(objectTiles(1070, 720, "fine").filter((t) => t.y === 0)).toHaveLength(4); // whole + 3
  });

  it("adds nothing for a square frame in 'tiles' mode", () => {
    expect(objectTiles(720, 720, "tiles")).toHaveLength(1);
    expect(objectTiles(720, 720, "fine").length).toBeGreaterThan(1);
  });
});

describe("rectBoxToFrame", () => {
  it("maps a box normalized to a crop to the frame", () => {
    const box = rectBoxToFrame(
      { x: 0.5, y: 0.25, width: 0.1, height: 0.2 },
      { x: 560, y: 0, width: 720, height: 720 },
      1280,
      720,
    );
    expect(box.x).toBeCloseTo((560 + 360) / 1280, 6);
    expect(box.y).toBeCloseTo(0.25, 6);
    expect(box.width).toBeCloseTo(72 / 1280, 6);
    expect(box.height).toBeCloseTo(0.2, 6);
  });
});

describe("mergePasses", () => {
  const frame = { frameWidth: 1000, frameHeight: 1000 };
  const det = (label, score, x, width = 0.1) => ({
    label,
    score,
    box: { x, y: 0.1, width, height: 0.1 },
  });

  it("keeps the higher score of the same object seen in two passes; other labels stay", () => {
    const merged = mergePasses(
      // Shifted by a quarter: IoU 0.6, but only 75% of either box inside the other.
      [det("cell phone", 0.4, 0.5), det("cell phone", 0.7, 0.525), det("remote", 0.6, 0.5)],
      frame,
    );
    expect(merged.map((d) => [d.label, d.score])).toEqual([
      ["cell phone", 0.7],
      ["remote", 0.6],
    ]);
  });

  it("drops the partial box a tile sees of an object cut by its edge", () => {
    // Whole phone 0.50–0.60; a tile cut at 0.55 sees 0.50–0.55 (IoU 0.5, but fully inside).
    const merged = mergePasses(
      [det("cell phone", 0.8, 0.5), det("cell phone", 0.6, 0.5, 0.05)],
      frame,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(0.8);
  });

  it("keeps two separate objects of the same label", () => {
    expect(
      mergePasses([det("cell phone", 0.8, 0.1), det("cell phone", 0.6, 0.5)], frame),
    ).toHaveLength(2);
  });

  it("keeps a larger box that only partly contains a smaller, higher-scored one", () => {
    // A 0.3-wide box around a 0.1-wide one: IoU 0.33, the larger is only 1/3 inside the smaller.
    expect(mergePasses([det("book", 0.9, 0.5), det("book", 0.5, 0.4, 0.3)], frame)).toHaveLength(2);
  });
});
