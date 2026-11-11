import { DiagnosticConfigSchema } from "./diagnostic/diagnosticConfig.js";
import { FaceLandmarkerConfigSchema } from "./face/faceLandmarkerConfig.js";
import { FaceVerifierConfigSchema } from "./verification/faceVerifierConfig.js";

/**
 * Engine kinds known to the lab, with the schema that validates their `engineConfig`.
 *
 * A kind is an implementation (for example `diagnostic` or `face-landmarker`). Several engine
 * instances may share a kind with different configurations, which is how two model variants are
 * compared side by side. Schemas live in small modules without runtime dependencies so the main
 * thread can validate configuration without loading model code.
 */
export const ENGINE_CONFIG_SCHEMAS = Object.freeze({
  diagnostic: DiagnosticConfigSchema,
  "face-landmarker": FaceLandmarkerConfigSchema,
  "face-verifier": FaceVerifierConfigSchema,
});

/** @typedef {keyof typeof ENGINE_CONFIG_SCHEMAS} EngineKind */

/** @type {readonly EngineKind[]} */
export const ENGINE_KINDS = Object.freeze(
  /** @type {EngineKind[]} */ (Object.keys(ENGINE_CONFIG_SCHEMAS)),
);
