import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";
import { vendorAssetsPlugin } from "./scripts/vite-plugin-vendor-assets.js";
import {
  MEDIAPIPE_TASKS_VISION_VERSION,
  MEDIAPIPE_WASM_DIR,
  MEDIAPIPE_WASM_FILES,
} from "./src/engines/face/mediapipeAssets.js";
import {
  ONNXRUNTIME_WEB_VERSION,
  ORT_WASM_DIR,
  ORT_WASM_FILES,
} from "./src/engines/verification/ortAssets.js";

/**
 * Cross-origin isolation enables SharedArrayBuffer (multi-threaded WASM for ONNX Runtime Web and
 * MediaPipe) and performance.measureUserAgentSpecificMemory(). With COEP require-corp every
 * subresource must be same-origin or carry CORP headers, so models and WASM binaries are
 * self-hosted. Production hosting must send the same headers (see docs/ARCHITECTURE.md).
 */
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * Content Security Policy for built output. `connect-src 'self'` blocks fetch/XHR/WebSocket/beacon
 * requests to any other origin, which enforces the "no webcam data leaves the browser" rule
 * technically rather than by convention. `'wasm-unsafe-eval'` allows compiling WebAssembly
 * (MediaPipe, ONNX Runtime) without allowing eval(). Not applied in dev because the React
 * Refresh preamble is an inline script.
 *
 * It is delivered twice: as a <meta> tag in index.html (covers the document) and as a response
 * header from `vite preview` (also covers the worker scripts; a dedicated worker loaded from a
 * same-origin URL does not inherit the document's policy). Deployments must send the header.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: mediastream:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** @returns {import('vite').Plugin} */
function contentSecurityPolicyPlugin() {
  return {
    name: "cv-lab-content-security-policy",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

/** Runtime files served from the installed packages (see scripts/vite-plugin-vendor-assets.js). */
const VENDOR_PACKAGES = [
  {
    name: "@mediapipe/tasks-vision",
    version: MEDIAPIPE_TASKS_VISION_VERSION,
    versionSource: "src/engines/face/mediapipeAssets.js",
    dir: MEDIAPIPE_WASM_DIR,
    files: MEDIAPIPE_WASM_FILES,
    bundledAs:
      "The package's JavaScript is bundled, unmodified, into the face engine worker chunk (assets/mediapipeRuntime-*.js).",
  },
  {
    name: "onnxruntime-web",
    version: ONNXRUNTIME_WEB_VERSION,
    versionSource: "src/engines/verification/ortAssets.js",
    dir: ORT_WASM_DIR,
    files: ORT_WASM_FILES,
    bundledAs:
      "The package's JavaScript (dist/ort.webgpu.min.mjs and onnxruntime-common) is bundled, unmodified, into the face verification worker chunk (assets/ortRuntime-*.js).",
  },
];

export default defineConfig({
  plugins: [
    react(),
    contentSecurityPolicyPlugin(),
    vendorAssetsPlugin(VENDOR_PACKAGES, { headers: CROSS_ORIGIN_ISOLATION_HEADERS }),
  ],
  resolve: {
    // Selects ONNX Runtime Web's "extern WASM" builds: the Emscripten glue and binary are loaded
    // from env.wasm.wasmPaths (served from the package by the plugin above) instead of being
    // inlined. The glue must be a separate same-origin file: it is also the entry of the WASM
    // threads' workers.
    conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions],
  },
  server: { headers: CROSS_ORIGIN_ISOLATION_HEADERS },
  preview: {
    headers: {
      ...CROSS_ORIGIN_ISOLATION_HEADERS,
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    },
  },
  worker: {
    // Module workers allow code splitting and native `import()` inside workers. MediaPipe Tasks
    // Vision >= 1.2 falls back to `import()` when `importScripts` is unavailable.
    format: "es",
  },
  optimizeDeps: {
    // Imported only from worker code, which the dev server's dependency scan does not follow.
    // Without this, the first engine load triggers a re-optimization and a full page reload.
    include: ["@mediapipe/tasks-vision", "onnxruntime-web/webgpu"],
  },
  build: {
    sourcemap: true,
    // Emits .vite/license.md with the licenses of all bundled npm dependencies.
    license: true,
  },
});
