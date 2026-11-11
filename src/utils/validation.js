import { ConfigValidationError } from "./errors.js";
import { z } from "./zod.js";

/**
 * Validates `input` against a Zod schema and returns the parsed copy.
 *
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} input
 * @param {string} label used in the error message, e.g. "lab configuration"
 * @returns {T}
 * @throws {ConfigValidationError} with the Zod issues in `details`
 */
export function parseConfig(schema, input, label) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ConfigValidationError(`Invalid ${label}:\n${z.prettifyError(result.error)}`, {
      code: "INVALID_CONFIG",
      details: result.error.issues,
    });
  }
  return result.data;
}
