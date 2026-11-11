import { z } from "../../utils/zod.js";

/**
 * Configuration of the diagnostic probe engine. The probe validates the capture → worker →
 * result path without a model: it downsamples the frame, computes simple pixel statistics, and
 * can simulate synchronous inference load, slow initialization, and periodic failures.
 */
export const DiagnosticConfigSchema = z
  .object({
    /** Width of the downsampled image used for pixel statistics. */
    sampleWidth: z.number().int().min(8).max(512),
    /** Busy-wait inside the worker after the pixel statistics, emulating blocking WASM inference. */
    simulatedWorkMs: z.number().min(0).max(5000),
    /** Delay inside initialize(), emulating model download and session creation. */
    simulatedInitMs: z.number().min(0).max(60_000),
    /** Throw from every Nth detect() call. 0 disables failure injection. */
    failEveryN: z.number().int().min(0).max(10_000),
  })
  .strict();

/** @typedef {z.infer<typeof DiagnosticConfigSchema>} DiagnosticConfig */

/** @type {DiagnosticConfig} */
export const DEFAULT_DIAGNOSTIC_CONFIG = Object.freeze({
  sampleWidth: 64,
  simulatedWorkMs: 0,
  simulatedInitMs: 0,
  failEveryN: 0,
});
