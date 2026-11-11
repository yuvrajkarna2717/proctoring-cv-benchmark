// Worker entry for the MediaPipe Face Landmarker engine. The loader imports the engine and the
// MediaPipe runtime together, so the host's module load time includes the MediaPipe JavaScript;
// the WASM binary and the model are loaded during initialize().
import { createEngineHost, installWorkerSafeguards } from "./engineHost.js";

// Before any engine code runs: MediaPipe would otherwise send usage statistics to Google.
installWorkerSafeguards(self);

createEngineHost({
  endpoint: self,
  loaders: {
    "face-landmarker": async () => {
      const [{ FaceLandmarkerEngine }, { mediapipeRuntime }] = await Promise.all([
        import("../engines/face/FaceLandmarkerEngine.js"),
        import("../engines/face/mediapipeRuntime.js"),
      ]);
      return class MediapipeFaceLandmarkerEngine extends FaceLandmarkerEngine {
        /**
         * @param {Record<string, unknown>} config
         * @param {{ now?: () => number }} dependencies
         */
        constructor(config, dependencies) {
          super(config, { ...dependencies, runtime: mediapipeRuntime });
        }
      };
    },
  },
});
