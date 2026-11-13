/**
 * Worker constructors per engine kind.
 *
 * Vite only bundles a worker when `new URL(...)` appears literally inside `new Worker(...)` with
 * static options, so every kind needs its own explicit factory here.
 *
 * @type {Readonly<Record<import('../engines/engineKinds.js').EngineKind, () => Worker>>}
 */
export const WORKER_FACTORIES = Object.freeze({
  diagnostic: () =>
    new Worker(new URL("./diagnostic.worker.js", import.meta.url), { type: "module" }),
  "face-landmarker": () =>
    new Worker(new URL("./face.worker.js", import.meta.url), { type: "module" }),
  "face-verifier": () =>
    new Worker(new URL("./verification.worker.js", import.meta.url), { type: "module" }),
  "image-quality": () =>
    new Worker(new URL("./quality.worker.js", import.meta.url), { type: "module" }),
  "mp-object-detector": () =>
    new Worker(new URL("./objects-mediapipe.worker.js", import.meta.url), { type: "module" }),
  "ort-object-detector": () =>
    new Worker(new URL("./objects-onnx.worker.js", import.meta.url), { type: "module" }),
});
