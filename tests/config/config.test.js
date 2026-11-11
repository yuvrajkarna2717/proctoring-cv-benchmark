import { describe, expect, it } from "vitest";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import { validateLabConfig } from "../../src/config/schema.js";
import { ConfigValidationError } from "../../src/utils/errors.js";

const clone = () => structuredClone(DEFAULT_LAB_CONFIG);

describe("lab configuration", () => {
  it("default configuration is valid and engine ids are unique", () => {
    expect(() => validateLabConfig(clone())).not.toThrow();
    const ids = DEFAULT_LAB_CONFIG.engines.map((engine) => engine.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects duplicate engine ids", () => {
    const config = clone();
    config.engines[1].id = config.engines[0].id;
    expect(() => validateLabConfig(config)).toThrow(/duplicate engine id/);
  });

  it("rejects a non-positive target rate with the offending path", () => {
    const config = clone();
    config.engines[0].scheduler.targetFps = 0;
    try {
      validateLabConfig(config);
      expect.unreachable("validation should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(
        error.details.some((issue) => issue.path.join(".") === "engines.0.scheduler.targetFps"),
      ).toBe(true);
    }
  });

  it("validates engine-specific configuration with the schema of the engine kind", () => {
    const config = clone();
    const face = config.engines.findIndex((engine) => engine.kind === "face-landmarker");
    const probe = config.engines.findIndex((engine) => engine.kind === "diagnostic");
    config.engines[face].engineConfig.numFaces = 0;
    config.engines[probe].engineConfig.simulatedWorkMs = -1;
    try {
      validateLabConfig(config);
      expect.unreachable("validation should fail");
    } catch (error) {
      const paths = error.details.map((issue) => issue.path.join("."));
      expect(paths).toContain(`engines.${face}.engineConfig.numFaces`);
      expect(paths).toContain(`engines.${probe}.engineConfig.simulatedWorkMs`);
    }
  });

  it("rejects unknown engine kinds and unknown keys", () => {
    const unknownKind = clone();
    unknownKind.engines[0].kind = "mystery";
    expect(() => validateLabConfig(unknownKind)).toThrow(ConfigValidationError);

    const unknownKey = clone();
    unknownKey.engines[0].scheduler.fps = 5;
    expect(() => validateLabConfig(unknownKey)).toThrow(ConfigValidationError);
  });
});
