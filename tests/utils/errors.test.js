import { describe, expect, it } from "vitest";
import * as errors from "../../src/utils/errors.js";
import {
  EngineTimeoutError,
  LabError,
  describeError,
  deserializeError,
  serializeError,
} from "../../src/utils/errors.js";

describe("error serialization", () => {
  it("names every error class explicitly, so minified builds keep the names", () => {
    const classes = Object.entries(errors).filter(
      ([, value]) =>
        value === LabError || (typeof value === "function" && value.prototype instanceof LabError),
    );
    expect(classes.length).toBeGreaterThanOrEqual(7);
    for (const [exportName, ErrorClass] of classes) {
      // A subclass without its own errorName would inherit its parent's name.
      expect(Object.hasOwn(ErrorClass, "errorName")).toBe(true);
      expect(new ErrorClass("x").name).toBe(exportName);
      expect(deserializeError(serializeError(new ErrorClass("x")))).toBeInstanceOf(ErrorClass);
    }
  });

  it("round-trips lab errors with code, details, and cause chain", () => {
    const cause = new TypeError("bad tensor shape");
    const original = new EngineTimeoutError("detect timed out", {
      code: "TIMEOUT",
      cause,
      details: { ms: 50 },
    });
    const restored = deserializeError(JSON.parse(JSON.stringify(serializeError(original))));
    expect(restored).toBeInstanceOf(EngineTimeoutError);
    expect(restored).toMatchObject({
      name: "EngineTimeoutError",
      code: "TIMEOUT",
      message: "detect timed out",
      details: { ms: 50 },
    });
    expect(restored.cause).toMatchObject({ name: "TypeError", message: "bad tensor shape" });
  });

  it("keeps DOMException-style names for unknown error types", () => {
    const restored = deserializeError(
      serializeError({ name: "NotAllowedError", message: "Permission denied" }),
    );
    expect(restored).toBeInstanceOf(LabError);
    expect(restored.name).toBe("NotAllowedError");
  });

  it("serializes non-Error throws", () => {
    expect(serializeError("plain string")).toEqual({
      name: "NonErrorThrown",
      message: "plain string",
    });
  });

  it("drops non-cloneable details instead of failing", () => {
    const circular = {};
    circular.self = circular;
    const serialized = serializeError(new LabError("x", { details: circular }));
    expect(() => structuredClone(serialized)).not.toThrow();
  });

  it("describes the cause chain", () => {
    const error = new LabError("outer", { code: "OUTER", cause: new Error("inner") });
    expect(describeError(error)).toBe("LabError [OUTER]: outer <- caused by: Error: inner");
  });
});
