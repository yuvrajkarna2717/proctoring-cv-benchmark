import { sleep } from "../../utils/clock.js";
import { LabError } from "../../utils/errors.js";
import { parseConfig } from "../../utils/validation.js";
import { BaseDetectionEngine } from "../BaseDetectionEngine.js";
import { DiagnosticConfigSchema } from "./diagnosticConfig.js";

/**
 * Model-free probe engine used to validate the capture → worker → result architecture.
 *
 * It downsamples the frame on an OffscreenCanvas and reports the mean and standard deviation of
 * Rec. 709 luma over gamma-encoded pixel values. Covering the camera should drop the mean, which
 * shows that real pixel data reached the worker. It is a diagnostic, not the Phase 5 image
 * quality engine.
 *
 * `simulatedWorkMs` busy-waits on the worker thread, which is how blocking WASM inference
 * behaves, so scheduler backpressure can be tested before real models are integrated.
 */
export class DiagnosticEngine extends BaseDetectionEngine {
  static kind = "diagnostic";

  /** @type {import('./diagnosticConfig.js').DiagnosticConfig} */
  #options;
  /** @type {OffscreenCanvas | null} */
  #canvas = null;
  /** @type {OffscreenCanvasRenderingContext2D | null} */
  #context = null;
  #callCount = 0;

  /**
   * @param {Record<string, unknown>} config
   * @param {{ now?: () => number }} [dependencies]
   */
  constructor(config, dependencies) {
    const options = parseConfig(DiagnosticConfigSchema, config, "diagnostic engine configuration");
    super(options, dependencies);
    this.#options = options;
  }

  async onInitialize() {
    if (typeof OffscreenCanvas === "undefined") {
      throw new LabError("OffscreenCanvas is not available in this worker", {
        code: "UNSUPPORTED_API",
      });
    }
    const startedAt = this.now();
    if (this.#options.simulatedInitMs > 0) await sleep(this.#options.simulatedInitMs);
    const modelFetchMs = this.now() - startedAt;

    const contextStartedAt = this.now();
    this.#canvas = new OffscreenCanvas(this.#options.sampleWidth, this.#options.sampleWidth);
    this.#context = this.#canvas.getContext("2d", { willReadFrequently: true, alpha: false });
    if (!this.#context) {
      throw new LabError("Could not create an OffscreenCanvas 2D context", {
        code: "CONTEXT_UNAVAILABLE",
      });
    }
    return { modelFetchMs, modelInitMs: this.now() - contextStartedAt };
  }

  /**
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('../EngineContract.js').FrameMeta} meta
   * @param {import('../EngineContract.js').StageTimer} timer
   */
  async onDetect(frame, meta, timer) {
    const canvas = /** @type {OffscreenCanvas} */ (this.#canvas);
    const context = /** @type {OffscreenCanvasRenderingContext2D} */ (this.#context);
    const { sampleWidth, simulatedWorkMs, failEveryN } = this.#options;
    this.#callCount += 1;

    timer.start("preprocess");
    const [frameWidth, frameHeight] = frameSize(frame, meta);
    const sampleHeight = Math.max(1, Math.round((sampleWidth * frameHeight) / frameWidth));
    if (canvas.width !== sampleWidth || canvas.height !== sampleHeight) {
      canvas.width = sampleWidth;
      canvas.height = sampleHeight;
    }
    context.drawImage(frame, 0, 0, sampleWidth, sampleHeight);
    const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);

    timer.start("inference");
    let sum = 0;
    let sumOfSquares = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luma;
      sumOfSquares += luma * luma;
    }
    const pixelCount = sampleWidth * sampleHeight;
    const meanLuma = sum / pixelCount;
    const stdLuma = Math.sqrt(Math.max(0, sumOfSquares / pixelCount - meanLuma * meanLuma));
    if (simulatedWorkMs > 0) busyWait(simulatedWorkMs, this.now);
    if (failEveryN > 0 && this.#callCount % failEveryN === 0) {
      throw new LabError(`Injected failure on call ${this.#callCount} (failEveryN=${failEveryN})`, {
        code: "INJECTED_FAILURE",
      });
    }

    timer.start("postprocess");
    return {
      observations: [
        {
          type: "FRAME_PROBE",
          detected: true,
          value: Math.round(meanLuma * 100) / 100,
          metadata: {
            stdLuma: Math.round(stdLuma * 100) / 100,
            sampleWidth,
            sampleHeight,
            frameWidth,
            frameHeight,
            simulatedWorkMs,
          },
        },
      ],
    };
  }

  /** @param {Record<string, unknown>} patch */
  async onConfigure(patch) {
    this.#options = parseConfig(
      DiagnosticConfigSchema,
      { ...this.#options, ...patch },
      "diagnostic engine configuration",
    );
    return { ...this.#options };
  }

  async onDispose() {
    this.#context = null;
    this.#canvas = null;
  }

  getModelInfo() {
    return { id: "diagnostic-probe", version: "1", runtime: "javascript" };
  }

  getExecutionProvider() {
    return "js";
  }
}

/**
 * @param {ImageBitmap | VideoFrame} frame
 * @param {import('../EngineContract.js').FrameMeta} meta
 * @returns {[number, number]}
 */
function frameSize(frame, meta) {
  if ("displayWidth" in frame) return [frame.displayWidth, frame.displayHeight];
  if (frame.width > 0 && frame.height > 0) return [frame.width, frame.height];
  return [meta.width, meta.height];
}

/**
 * Blocks the current thread, emulating synchronous inference.
 *
 * @param {number} durationMs
 * @param {() => number} now
 */
function busyWait(durationMs, now) {
  const until = now() + durationMs;
  let spins = 0;
  while (now() < until) spins += 1;
  return spins;
}
