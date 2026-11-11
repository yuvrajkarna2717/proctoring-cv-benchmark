import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_QUALITY_CONFIG } from "../../../src/engines/quality/imageQualityConfig.js";
import { ImageQualityEngine } from "../../../src/engines/quality/ImageQualityEngine.js";
import { createMeta } from "../../helpers/fakes.js";

/**
 * Fake OffscreenCanvas: drawImage(frame, 0, 0, w, h) "renders" the frame by sampling its
 * `lumaAt(x, y)` (frame pixels) at the centre of each output pixel; getImageData returns that
 * as grey RGBA. Records the calls.
 */
function createFakeCanvasFactory() {
  const calls = { draws: [], reads: 0 };
  const factory = (width, height) => {
    const canvas = { width, height };
    /** @type {any} */
    let drawn = null;
    canvas.getContext = () => ({
      drawImage(frame, ...args) {
        calls.draws.push(args);
        drawn = { frame, width: args[2], height: args[3] };
      },
      getImageData(x, y, width, height) {
        calls.reads += 1;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let row = 0; row < height; row += 1) {
          for (let col = 0; col < width; col += 1) {
            const fx = ((col + 0.5) * drawn.frame.width) / drawn.width;
            const fy = ((row + 0.5) * drawn.frame.height) / drawn.height;
            const value = drawn.frame.lumaAt(fx, fy);
            const i = (row * width + col) * 4;
            data[i] = data[i + 1] = data[i + 2] = value;
            data[i + 3] = 255;
          }
        }
        return { data };
      },
    });
    return canvas;
  };
  return { factory, calls };
}

/** A 1280×720 frame: the left half at `left`, the right half at `right`. */
const halves = (left, right) => ({
  width: 1280,
  height: 720,
  lumaAt: (x) => (x < 640 ? left : right),
  close() {},
});

async function createEngine(config = {}) {
  const { factory, calls } = createFakeCanvasFactory();
  let time = 10_000;
  const engine = new ImageQualityEngine(
    { ...DEFAULT_IMAGE_QUALITY_CONFIG, ...config },
    { createCanvas: factory, now: () => time },
  );
  await engine.initialize();
  return { engine, calls, advance: (ms) => (time += ms) };
}

const meta = (overrides = {}) =>
  createMeta({
    width: 1280,
    height: 720,
    sourceWidth: 1280,
    sourceHeight: 720,
    captureTime: 10_000,
    ...overrides,
  });

describe("ImageQualityEngine", () => {
  it("measures the frame from one read capped at readWidth, and reports no face without a hint", async () => {
    const { engine, calls } = await createEngine({ readWidth: 640 });
    const result = await engine.detect(halves(200, 50), meta());
    expect(calls.reads).toBe(1);
    expect(calls.draws).toEqual([[0, 0, 640, 360]]);
    const [frame, face] = result.observations;
    expect(frame).toMatchObject({
      type: "FRAME_QUALITY",
      detected: true,
      value: 125,
      metadata: {
        meanLuma: 125,
        stdLuma: 75,
        p5: 50,
        p95: 200,
        readWidth: 640,
        analysisWidth: 320,
        analysisHeight: 180,
        sourceWidth: 1280,
      },
    });
    expect(face).toEqual({
      type: "FACE_QUALITY",
      detected: false,
      metadata: { reason: "no face hint" },
    });
    expect(result.timings.breakdownMs).toHaveProperty("readMs");
  });

  it("measures the face region from the hint, its background, and its size", async () => {
    const { engine, calls } = await createEngine({ faceMarginRatio: 0 });
    // Face box on the bright left half; 0.2 × 1280 = 256 camera pixels wide.
    const hints = {
      face: {
        box: { x: 0.1, y: 0.2, width: 0.2, height: 0.5 },
        at: 9_800,
        sourceEngineId: "face-landmarker",
      },
    };
    const result = await engine.detect(halves(200, 50), meta({ hints }));
    expect(calls.reads).toBe(1);
    const face = result.observations[1];
    expect(face.detected).toBe(true);
    expect(face.metadata).toMatchObject({
      meanLuma: 200,
      stdLuma: 0,
      cropWidth: 112,
      faceWidthPx: 256,
      faceWidthRatio: 0.2,
      hintAgeMs: 200,
    });
    // Background: the frame outside the face box, mostly the dark right half.
    expect(face.metadata.backgroundMeanLuma).toBeGreaterThan(50);
    expect(face.metadata.backgroundMeanLuma).toBeLessThan(125);
    // A flat crop has no defined normalized sharpness.
    expect(face.metadata.sharpness).toBeNaN();
  });

  it("does not use a stale hint or a hint without a face", async () => {
    const { engine } = await createEngine();
    const box = { x: 0.1, y: 0.2, width: 0.2, height: 0.5 };
    const stale = await engine.detect(
      halves(200, 50),
      meta({ hints: { face: { box, at: 8_000, sourceEngineId: "face-landmarker" } } }),
    );
    expect(stale.observations[1]).toMatchObject({
      detected: false,
      metadata: { reason: "face hint 2000 ms old" },
    });
    const noFace = await engine.detect(
      halves(200, 50),
      meta({ hints: { face: { box: null, at: 9_900, sourceEngineId: "face-landmarker" } } }),
    );
    expect(noFace.observations[1].metadata.reason).toMatch(/no face in the face landmarker/);
  });

  it("validates its configuration", () => {
    expect(
      () => new ImageQualityEngine({ ...DEFAULT_IMAGE_QUALITY_CONFIG, readWidth: 10 }, {}),
    ).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
});
