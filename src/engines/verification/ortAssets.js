/**
 * Where the ONNX Runtime Web WASM files are served from.
 *
 * The app imports the "extern WASM" build of `onnxruntime-web/webgpu` (Vite resolve condition
 * `onnxruntime-web-use-extern-wasm`), which loads its Emscripten glue (.mjs) and binary (.wasm)
 * from `env.wasm.wasmPaths` at runtime instead of inlining them. The glue file is also the entry
 * of the WASM threads' workers, so it must be a separate same-origin file (CSP `script-src
 * 'self'`, `worker-src 'self'`). scripts/vite-plugin-vendor-assets.js serves both files from the
 * installed package and fails the build if the version differs.
 */
export const ONNXRUNTIME_WEB_VERSION = "1.31.1";

/** Directory below the site's base URL. */
export const ORT_WASM_DIR = `vendor/onnxruntime-web@${ONNXRUNTIME_WEB_VERSION}`;

/**
 * The binary of the WebGPU build: the native WebGPU execution provider (built with Asyncify)
 * plus the CPU (WASM) execution provider. One binary serves both providers.
 */
export const ORT_WASM_FILES = Object.freeze([
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
]);
