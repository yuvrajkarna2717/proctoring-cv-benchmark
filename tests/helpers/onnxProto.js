/**
 * Tiny ONNX protobuf writer and reader for tests, independent of src/engines/verification/
 * onnxGraph.js. Field numbers follow onnx/onnx.proto3.
 */

/** @param {number} value */
function varint(value) {
  const out = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? low | 0x80 : low);
  } while (rest > 0);
  return out;
}

/** @param {Array<number[] | Uint8Array>} parts */
function bytesOf(parts) {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

/**
 * @param {number} field
 * @param {Uint8Array | string} value
 */
export function lengthField(field, value) {
  const payload = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytesOf([varint(field * 8 + 2), varint(payload.length), payload]);
}

/**
 * @param {number} field
 * @param {number} value
 */
export function varintField(field, value) {
  return bytesOf([varint(field * 8), varint(value)]);
}

/** @param {Uint8Array[]} fields */
export function message(...fields) {
  return bytesOf(fields);
}

/** ValueInfoProto with a name (and a type placeholder, so the message has another field). */
export const valueInfo = (name) => message(lengthField(1, name), lengthField(2, new Uint8Array()));

/**
 * NodeProto.
 *
 * @param {{ inputs: string[], outputs: string[], op?: string, subgraphs?: Uint8Array[] }} node
 */
export function node({ inputs, outputs, op = "Identity", subgraphs = [] }) {
  return message(
    ...inputs.map((name) => lengthField(1, name)),
    ...outputs.map((name) => lengthField(2, name)),
    lengthField(4, op),
    ...subgraphs.map((graph) =>
      lengthField(5, message(lengthField(1, "body"), lengthField(6, graph), varintField(20, 5))),
    ),
  );
}

/**
 * GraphProto.
 *
 * @param {{ nodes?: Uint8Array[], inputs?: string[], outputs?: string[], initializers?: string[] }} graph
 */
export function graph({ nodes = [], inputs = [], outputs = [], initializers = [] }) {
  return message(
    ...nodes.map((n) => lengthField(1, n)),
    lengthField(2, "g"),
    ...initializers.map((name) =>
      lengthField(5, message(varintField(1, 4), varintField(2, 1), lengthField(8, name))),
    ),
    ...inputs.map((name) => lengthField(11, valueInfo(name))),
    ...outputs.map((name) => lengthField(12, valueInfo(name))),
  );
}

/**
 * ModelProto: ir_version, producer, the graph, an opset import, and an optional doc string.
 *
 * @param {Uint8Array} graphBytes
 * @param {{ docString?: string }} [options]
 */
export function model(graphBytes, { docString } = {}) {
  return message(
    varintField(1, 10),
    lengthField(2, "test"),
    lengthField(7, graphBytes),
    lengthField(8, message(lengthField(1, ""), varintField(2, 21))),
    ...(docString === undefined ? [] : [lengthField(6, docString)]),
  );
}

/**
 * @param {Uint8Array} bytes
 * @returns {Array<{ field: number, wire: number, value: Uint8Array | number }>}
 */
export function decode(bytes) {
  const fields = [];
  let position = 0;
  const read = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = bytes[position++];
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
    }
  };
  while (position < bytes.length) {
    const key = read();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      fields.push({ field, wire, value: read() });
    } else if (wire === 2) {
      const length = read();
      fields.push({ field, wire, value: bytes.subarray(position, position + length) });
      position += length;
    } else {
      throw new Error(`test decoder: wire type ${wire}`);
    }
  }
  return fields;
}

const text = (bytes) => new TextDecoder().decode(bytes);

/**
 * Names of the graph's inputs and outputs, and how many nodes and initializers it has.
 *
 * @param {Uint8Array} modelBytes
 */
export function describeGraph(modelBytes) {
  const graphField = decode(modelBytes).find((f) => f.field === 7);
  const fields = decode(/** @type {Uint8Array} */ (graphField.value));
  const names = (number) =>
    fields
      .filter((f) => f.field === number)
      .map((f) => text(decode(f.value).find((v) => v.field === 1).value));
  return {
    inputs: names(11),
    outputs: names(12),
    nodes: fields.filter((f) => f.field === 1).length,
    initializers: fields.filter((f) => f.field === 5).length,
  };
}
