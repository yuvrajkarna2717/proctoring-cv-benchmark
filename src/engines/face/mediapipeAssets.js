/**
 * Where the MediaPipe Tasks Vision WASM files are served from.
 *
 * The files come from the installed npm package (see scripts/vite-plugin-vendor-assets.js), so
 * they always match the bundled JavaScript. The version is part of the path so a browser cache
 * never mixes files from two releases. The Vite plugin fails the build if this constant differs
 * from the installed package version.
 */
export const MEDIAPIPE_TASKS_VISION_VERSION = "1.2.2";

/** Directory below the site's base URL. */
export const MEDIAPIPE_WASM_DIR = `vendor/mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}`;

/**
 * The ES module build of the loader and its binary. Module workers cannot use importScripts(),
 * so FilesetResolver.forVisionTasks(basePath, true) loads this variant with import().
 */
export const MEDIAPIPE_WASM_FILES = Object.freeze([
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
]);
