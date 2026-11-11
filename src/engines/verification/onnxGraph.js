import { LabError } from "../../utils/errors.js";

/**
 * Minimal ONNX protobuf edits, done on the raw bytes without an ONNX library.
 *
 * Field numbers (onnx/onnx.proto3):
 * - ModelProto.graph = 7
 * - GraphProto.node = 1, GraphProto.input = 11, GraphProto.output = 12
 * - NodeProto.input = 1, NodeProto.attribute = 5
 * - AttributeProto.g = 6, AttributeProto.graphs = 11
 * - ValueInfoProto.name = 1
 */

const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const GRAPH_INPUT = 11;
const GRAPH_OUTPUT = 12;
const NODE_INPUT = 1;
const NODE_ATTRIBUTE = 5;
const ATTRIBUTE_GRAPH = 6;
const ATTRIBUTE_GRAPHS = 11;
const VALUE_INFO_NAME = 1;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

/**
 * @typedef {Object} ProtoField
 * @property {number} field field number
 * @property {number} wire wire type
 * @property {number} start offset of the field's key
 * @property {number} valueStart offset of the value (after the length prefix for wire type 2)
 * @property {number} end offset after the field
 */

const utf8 = new TextDecoder();

/**
 * Removes graph inputs that no node of the main graph or its subgraphs reads and that are not
 * graph outputs.
 *
 * OpenCV Zoo's block-quantized SFace (`*_int8bq.onnx`) still lists the 29 original float weight
 * names as graph inputs after the weights became int8 initializers with DequantizeLinear nodes.
 * Nothing consumes them, but ONNX Runtime reports them in `inputNames` and `run()` demands a
 * feed for each. Dropping their declarations leaves every node, initializer, and output as it
 * was, so the computation is unchanged.
 *
 * Call it after the SHA-256 check: the result differs from the pinned bytes.
 *
 * @param {Uint8Array} bytes serialized ModelProto
 * @returns {{ bytes: Uint8Array, removed: string[] }} the input bytes themselves when nothing
 *   was removed
 * @throws {LabError} code MODEL_PARSE when the bytes are not a well-formed protobuf
 */
export function pruneUnusedGraphInputs(bytes) {
  /** @type {Uint8Array[]} */
  const parts = [];
  /** @type {string[]} */
  const removed = [];
  for (const top of readFields(bytes, 0, bytes.length)) {
    if (top.field !== MODEL_GRAPH || top.wire !== WIRE_LENGTH_DELIMITED) {
      parts.push(bytes.subarray(top.start, top.end));
      continue;
    }
    const consumed = new Set();
    collectConsumedNames(bytes, top.valueStart, top.end, consumed);
    for (const field of readFields(bytes, top.valueStart, top.end)) {
      if (field.field === GRAPH_OUTPUT && field.wire === WIRE_LENGTH_DELIMITED) {
        const name = valueInfoName(bytes, field);
        if (name !== null) consumed.add(name);
      }
    }
    /** @type {Uint8Array[]} */
    const graphParts = [];
    for (const field of readFields(bytes, top.valueStart, top.end)) {
      if (field.field === GRAPH_INPUT && field.wire === WIRE_LENGTH_DELIMITED) {
        const name = valueInfoName(bytes, field);
        if (name !== null && !consumed.has(name)) {
          removed.push(name);
          continue;
        }
      }
      graphParts.push(bytes.subarray(field.start, field.end));
    }
    const graph = concat(graphParts);
    parts.push(encodeVarint(MODEL_GRAPH * 8 + WIRE_LENGTH_DELIMITED), encodeVarint(graph.length));
    parts.push(graph);
  }
  return removed.length === 0 ? { bytes, removed } : { bytes: concat(parts), removed };
}

/**
 * Adds the input names of every node in a GraphProto, including nodes of subgraphs (If, Loop,
 * Scan bodies), which may read names of the enclosing graph.
 *
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @param {Set<string>} names
 */
function collectConsumedNames(bytes, start, end, names) {
  for (const graphField of readFields(bytes, start, end)) {
    if (graphField.field !== GRAPH_NODE || graphField.wire !== WIRE_LENGTH_DELIMITED) continue;
    for (const nodeField of readFields(bytes, graphField.valueStart, graphField.end)) {
      if (nodeField.wire !== WIRE_LENGTH_DELIMITED) continue;
      if (nodeField.field === NODE_INPUT) {
        names.add(text(bytes, nodeField));
      } else if (nodeField.field === NODE_ATTRIBUTE) {
        for (const attributeField of readFields(bytes, nodeField.valueStart, nodeField.end)) {
          const isGraph =
            attributeField.field === ATTRIBUTE_GRAPH || attributeField.field === ATTRIBUTE_GRAPHS;
          if (isGraph && attributeField.wire === WIRE_LENGTH_DELIMITED) {
            collectConsumedNames(bytes, attributeField.valueStart, attributeField.end, names);
          }
        }
      }
    }
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {ProtoField} valueInfo
 * @returns {string | null}
 */
function valueInfoName(bytes, valueInfo) {
  for (const field of readFields(bytes, valueInfo.valueStart, valueInfo.end)) {
    if (field.field === VALUE_INFO_NAME && field.wire === WIRE_LENGTH_DELIMITED) {
      return text(bytes, field);
    }
  }
  return null;
}

/**
 * The fields of one protobuf message, in order.
 *
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {Generator<ProtoField>}
 */
function* readFields(bytes, start, end) {
  let position = start;
  while (position < end) {
    const fieldStart = position;
    const [key, afterKey] = readVarint(bytes, position, end);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let valueStart = afterKey;
    let fieldEnd;
    if (wire === WIRE_VARINT) {
      fieldEnd = readVarint(bytes, afterKey, end)[1];
    } else if (wire === WIRE_FIXED64) {
      fieldEnd = afterKey + 8;
    } else if (wire === WIRE_FIXED32) {
      fieldEnd = afterKey + 4;
    } else if (wire === WIRE_LENGTH_DELIMITED) {
      const [length, afterLength] = readVarint(bytes, afterKey, end);
      valueStart = afterLength;
      fieldEnd = afterLength + length;
    } else {
      throw parseError(`unsupported wire type ${wire} at byte ${fieldStart}`);
    }
    if (field === 0 || fieldEnd > end) {
      throw parseError(`malformed field at byte ${fieldStart}`);
    }
    yield { field, wire, start: fieldStart, valueStart, end: fieldEnd };
    position = fieldEnd;
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {number} position
 * @param {number} end
 * @returns {[number, number]} value and the offset after it
 */
function readVarint(bytes, position, end) {
  let value = 0;
  let scale = 1;
  for (let offset = position; offset < end && offset < position + 10; offset += 1) {
    const byte = bytes[offset];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw parseError(`varint too large at byte ${position}`);
      return [value, offset + 1];
    }
    scale *= 128;
  }
  throw parseError(`truncated varint at byte ${position}`);
}

/**
 * @param {number} value non-negative safe integer
 * @returns {Uint8Array}
 */
function encodeVarint(value) {
  /** @type {number[]} */
  const out = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? low | 0x80 : low);
  } while (rest > 0);
  return Uint8Array.from(out);
}

/** @param {Uint8Array[]} parts */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {ProtoField} field
 */
function text(bytes, field) {
  return utf8.decode(bytes.subarray(field.valueStart, field.end));
}

/** @param {string} detail */
function parseError(detail) {
  return new LabError(`The model file is not a valid ONNX protobuf: ${detail}`, {
    code: "MODEL_PARSE",
  });
}
