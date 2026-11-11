import { describe, expect, it } from "vitest";
import { pruneUnusedGraphInputs } from "../../../src/engines/verification/onnxGraph.js";
import { decode, describeGraph, graph, model, node } from "../../helpers/onnxProto.js";

/**
 * The int8bq pattern: the float weight "w" is declared as an input, but the Conv reads "w_dq",
 * which DequantizeLinear makes from the int8 initializer "w_q".
 */
const BLOCK_QUANTIZED = graph({
  nodes: [
    node({ inputs: ["w_q", "w_scale"], outputs: ["w_dq"], op: "DequantizeLinear" }),
    node({ inputs: ["data", "w_dq"], outputs: ["y"], op: "Conv" }),
  ],
  initializers: ["w_q", "w_scale"],
  inputs: ["data", "w", "w_scale"],
  outputs: ["y"],
});

describe("pruneUnusedGraphInputs", () => {
  it("drops inputs no node reads and keeps nodes, initializers, outputs, and other fields", () => {
    const bytes = model(BLOCK_QUANTIZED, { docString: "after the graph" });
    const { bytes: pruned, removed } = pruneUnusedGraphInputs(bytes);
    expect(removed).toEqual(["w"]);
    expect(describeGraph(pruned)).toEqual({
      inputs: ["data", "w_scale"],
      outputs: ["y"],
      nodes: 2,
      initializers: 2,
    });
    // Top-level fields keep their order and bytes; only the graph field shrinks.
    const before = decode(bytes);
    const after = decode(pruned);
    expect(after.map((f) => f.field)).toEqual(before.map((f) => f.field));
    for (const [index, field] of before.entries()) {
      if (field.field !== 7) expect(after[index].value).toEqual(field.value);
    }
  });

  it("returns the same bytes when every input is read", () => {
    const bytes = model(
      graph({
        nodes: [node({ inputs: ["data"], outputs: ["y"] })],
        inputs: ["data"],
        outputs: ["y"],
      }),
    );
    const result = pruneUnusedGraphInputs(bytes);
    expect(result.removed).toEqual([]);
    expect(result.bytes).toBe(bytes);
  });

  it("is idempotent", () => {
    const once = pruneUnusedGraphInputs(model(BLOCK_QUANTIZED)).bytes;
    const twice = pruneUnusedGraphInputs(once);
    expect(twice.removed).toEqual([]);
    expect(twice.bytes).toBe(once);
  });

  it("keeps an input read only inside a subgraph", () => {
    const body = graph({
      nodes: [node({ inputs: ["outer"], outputs: ["inner"] })],
      outputs: ["inner"],
    });
    const bytes = model(
      graph({
        nodes: [node({ inputs: ["cond"], outputs: ["y"], op: "If", subgraphs: [body] })],
        inputs: ["cond", "outer", "unused"],
        outputs: ["y"],
      }),
    );
    const { bytes: pruned, removed } = pruneUnusedGraphInputs(bytes);
    expect(removed).toEqual(["unused"]);
    expect(describeGraph(pruned).inputs).toEqual(["cond", "outer"]);
  });

  it("keeps an input that is passed straight to a graph output", () => {
    const bytes = model(
      graph({
        nodes: [node({ inputs: ["data"], outputs: ["y"] })],
        inputs: ["data", "passthrough"],
        outputs: ["y", "passthrough"],
      }),
    );
    expect(pruneUnusedGraphInputs(bytes).removed).toEqual([]);
  });

  it("rejects bytes that are not a protobuf", () => {
    // Field 7, length 50, but only 3 bytes follow.
    expect(() => pruneUnusedGraphInputs(Uint8Array.of(0x3a, 50, 1, 2, 3))).toThrow(
      expect.objectContaining({ code: "MODEL_PARSE" }),
    );
    // Wire type 3 (start group) is not used by ONNX.
    expect(() => pruneUnusedGraphInputs(Uint8Array.of(0x0b))).toThrow(
      expect.objectContaining({ code: "MODEL_PARSE" }),
    );
    // A varint that never ends.
    expect(() => pruneUnusedGraphInputs(Uint8Array.of(0x08, 0xff, 0xff))).toThrow(
      expect.objectContaining({ code: "MODEL_PARSE" }),
    );
  });
});
