import { FaceLandmarker, FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import { fetchModelBytes, sha256Hex, siteUrl } from "../modelFiles.js";
import { MEDIAPIPE_TASKS_VISION_VERSION, MEDIAPIPE_WASM_DIR } from "./mediapipeAssets.js";

/**
 * MediaPipe Tasks Vision runtime for FaceLandmarkerEngine and MediapipeObjectDetectorEngine.
 * Loads the self-hosted WASM (ES module variant, required in module workers) and the
 * self-hosted models; nothing is fetched from another origin.
 *
 * @type {import('./FaceLandmarkerEngine.js').FaceLandmarkerRuntime &
 *   Pick<import('../objects/MediapipeObjectDetectorEngine.js').MediapipeObjectRuntime, 'createObjectDetector'>}
 */
export const mediapipeRuntime = Object.freeze({
  version: `@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}`,

  loadModel: fetchModelBytes,

  sha256: sha256Hex,

  async createFaceLandmarker(options) {
    return FaceLandmarker.createFromOptions(await visionFileset(), options);
  },

  /** @param {Record<string, unknown>} options */
  async createObjectDetector(options) {
    return ObjectDetector.createFromOptions(await visionFileset(), options);
  },

  createBlankImage(width, height) {
    return new ImageData(width, height);
  },
});

async function visionFileset() {
  const fileset = await FilesetResolver.forVisionTasks(siteUrl(MEDIAPIPE_WASM_DIR), true);
  // The ES module loader assigns globalThis.ModuleFactory only when it is first evaluated, and
  // MediaPipe clears it after creating a task. A second task in the same worker (delegate or
  // model change) would fail with "ModuleFactory not set", so it is restored from the module
  // export.
  const loader = await import(/* @vite-ignore */ fileset.wasmLoaderPath);
  globalThis.ModuleFactory ??= loader.default;
  return fileset;
}
