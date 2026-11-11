import * as ort from "onnxruntime-web/webgpu";
import { createSerialQueue } from "../../utils/serialQueue.js";
import { fetchModelBytes, sha256Hex, siteUrl } from "../modelFiles.js";
import { createCanvasImageOps } from "./canvasImageOps.js";
import { ONNXRUNTIME_WEB_VERSION, ORT_WASM_DIR } from "./ortAssets.js";

let environmentConfigured = false;

/**
 * One ONNX Runtime call at a time per worker. Calls overlap when the engine opens new sessions
 * while frames keep arriving (a model or option change during detection). With the WebGPU
 * provider that overlap broke the worker in Chrome on Intel UHD: a run failed in
 * BufferManager::Download, then every later call failed with "memory access out of bounds".
 * This build suspends the WASM stack (Asyncify) while it waits for the GPU, so a second call
 * that enters the module meanwhile is not safe.
 */
const serialize = createSerialQueue();

/**
 * ONNX Runtime reads these flags when it initializes its WASM module, which happens once per
 * worker, on the first session.
 *
 * @param {number} numThreads 0 = ONNX Runtime's default
 */
function configureEnvironment(numThreads) {
  if (environmentConfigured) return;
  ort.env.wasm.wasmPaths = siteUrl(`${ORT_WASM_DIR}/`);
  ort.env.wasm.numThreads = numThreads;
  // Already in a worker; ONNX Runtime's own proxy worker is not needed.
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
  environmentConfigured = true;
}

/**
 * Wraps a session so that its runs and its release go through the worker's queue.
 *
 * @param {ort.InferenceSession} session
 * @returns {import('./FaceVerificationEngine.js').OrtSession}
 */
function serializedSession(session) {
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    run: (feeds) =>
      serialize(() => session.run(/** @type {ort.InferenceSession.FeedsType} */ (feeds))),
    release: () => serialize(() => session.release()),
  };
}

/**
 * ONNX Runtime Web runtime for FaceVerificationEngine. Loads the self-hosted WASM (served from the
 * installed package) and the self-hosted models; nothing is fetched from another origin.
 *
 * @type {import('./FaceVerificationEngine.js').FaceVerifierRuntime}
 */
export const ortRuntime = Object.freeze({
  version: `onnxruntime-web@${ONNXRUNTIME_WEB_VERSION}`,

  loadModel: fetchModelBytes,

  sha256: sha256Hex,

  async createSession(bytes, provider, { numThreads, foldWeightDequantization = false }) {
    configureEnvironment(numThreads);
    const session = await serialize(() =>
      ort.InferenceSession.create(bytes, {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
        // Errors only: SFace's graph lists its initializers as inputs, which makes ONNX Runtime
        // print one warning per weight.
        logSeverityLevel: 3,
        // ONNX Runtime keeps DequantizeLinear nodes out of constant folding so that QDQ fusions
        // can use them. With weight-only quantization (int8bq) nothing fuses, and every run
        // would dequantize all weights again; disabling the QDQ pass lets the weights fold to
        // float32 once, at load.
        ...(foldWeightDequantization ? { extra: { session: { disable_quant_qdq: "1" } } } : {}),
      }),
    );
    return serializedSession(session);
  },

  createTensor(data, dims) {
    return new ort.Tensor("float32", data, dims);
  },

  environment() {
    return {
      numThreads: environmentConfigured ? (ort.env.wasm.numThreads ?? null) : null,
      crossOriginIsolated: self.crossOriginIsolated === true,
      webgpuAvailable: typeof navigator !== "undefined" && "gpu" in navigator,
    };
  },

  image: createCanvasImageOps(),
});
