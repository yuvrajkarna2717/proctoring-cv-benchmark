// Worker entry for the ONNX object detectors (NanoDet-Plus, YOLOX-S from OpenCV Zoo) on ONNX
// Runtime Web. The WASM binary is served from the app's origin; ONNX Runtime starts its WASM
// threads as nested workers.
import { createEngineHost, installWorkerSafeguards } from "./engineHost.js";

installWorkerSafeguards(self);

createEngineHost({
  endpoint: self,
  loaders: {
    "ort-object-detector": async () => {
      const [
        { OnnxObjectDetectorEngine },
        { ortRuntime },
        { createLetterboxCanvas },
        { cropFrame },
      ] = await Promise.all([
        import("../engines/objects/OnnxObjectDetectorEngine.js"),
        import("../engines/verification/ortRuntime.js"),
        import("../engines/objects/letterboxCanvas.js"),
        import("../engines/objects/cropFrame.js"),
      ]);
      const runtime = {
        version: ortRuntime.version,
        loadModel: ortRuntime.loadModel,
        sha256: ortRuntime.sha256,
        createSession: ortRuntime.createSession,
        createTensor: ortRuntime.createTensor,
        environment: ortRuntime.environment,
        letterboxPixels: createLetterboxCanvas(),
        cropFrame,
      };
      return class OnnxObjectDetector extends OnnxObjectDetectorEngine {
        /**
         * @param {Record<string, unknown>} config
         * @param {{ now?: () => number }} dependencies
         */
        constructor(config, dependencies) {
          super(config, { ...dependencies, runtime });
        }
      };
    },
  },
});
