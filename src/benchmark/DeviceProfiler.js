import { describeError } from "../utils/errors.js";

/**
 * Collects browser, hardware, and API-support information attached to every benchmark export,
 * so results can be compared across machines. All values are read from the browser; nothing is
 * inferred. The profile is stored locally and only leaves the browser if a tester exports it.
 *
 * Note: GPU and user-agent strings are fingerprinting-grade data. They are required to
 * interpret benchmark numbers and are kept out of any network request (there are none).
 */

// Smallest module using a v128 instruction (from the wasm-feature-detect project).
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function collectDeviceProfile() {
  const nav = /** @type {Navigator & { deviceMemory?: number, userAgentData?: any, gpu?: any }} */ (
    globalThis.navigator
  );
  const isolated = globalThis.crossOriginIsolated === true;
  return {
    collectedAt: new Date().toISOString(),
    userAgent: nav.userAgent,
    userAgentData: await describeUserAgentData(nav),
    language: nav.language,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    // Chromium only, rounded and capped (commonly at 8 GB) by the browser.
    deviceMemoryGb: nav.deviceMemory ?? null,
    screen: {
      width: globalThis.screen?.width ?? null,
      height: globalThis.screen?.height ?? null,
      devicePixelRatio: globalThis.devicePixelRatio ?? null,
    },
    isSecureContext: globalThis.isSecureContext === true,
    crossOriginIsolated: isolated,
    wasm: {
      supported: typeof WebAssembly === "object",
      simd: typeof WebAssembly === "object" && WebAssembly.validate(WASM_SIMD_PROBE),
      // Multi-threaded WASM needs SharedArrayBuffer, which needs cross-origin isolation.
      threads: isolated && typeof SharedArrayBuffer === "function",
    },
    webgpu: await describeWebGpu(nav),
    webgl2: describeWebGl2(),
    apis: {
      getUserMedia: typeof nav.mediaDevices?.getUserMedia === "function",
      requestVideoFrameCallback:
        typeof HTMLVideoElement !== "undefined" &&
        typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function",
      createImageBitmap: typeof createImageBitmap === "function",
      offscreenCanvas: typeof OffscreenCanvas === "function",
      videoFrame: typeof globalThis.VideoFrame === "function",
      mediaRecorder: typeof globalThis.MediaRecorder === "function",
      indexedDb: typeof globalThis.indexedDB === "object",
      measureUserAgentSpecificMemory:
        typeof (/** @type {any} */ (performance).measureUserAgentSpecificMemory) === "function",
      longTaskTiming:
        typeof PerformanceObserver === "function" &&
        Boolean(PerformanceObserver.supportedEntryTypes?.includes("longtask")),
    },
  };
}

/** @param {{ userAgentData?: any }} nav */
async function describeUserAgentData(nav) {
  if (!nav.userAgentData) return null;
  try {
    return await nav.userAgentData.getHighEntropyValues([
      "architecture",
      "bitness",
      "model",
      "platformVersion",
      "fullVersionList",
    ]);
  } catch (error) {
    return { brands: nav.userAgentData.brands, error: describeError(error) };
  }
}

/** @param {{ gpu?: any }} nav */
async function describeWebGpu(nav) {
  if (!nav.gpu) return { available: false, reason: "navigator.gpu is not defined" };
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return { available: false, reason: "requestAdapter() returned null" };
    const info =
      adapter.info ??
      (typeof adapter.requestAdapterInfo === "function"
        ? await adapter.requestAdapterInfo()
        : null);
    return {
      available: true,
      adapter: info
        ? {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description,
          }
        : null,
      isFallbackAdapter: info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
      features: [...adapter.features].sort(),
      limits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      },
    };
  } catch (error) {
    return { available: false, reason: describeError(error) };
  }
}

function describeWebGl2() {
  try {
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(1, 1)
        : globalThis.document?.createElement("canvas");
    const gl = /** @type {WebGL2RenderingContext | null} */ (canvas?.getContext("webgl2") ?? null);
    if (!gl) return { available: false };
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const result = {
      available: true,
      vendor: gl.getParameter(debugInfo ? debugInfo.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  } catch (error) {
    return { available: false, reason: describeError(error) };
  }
}
