// Worker entry for the MediaPipe object detector (EfficientDet-Lite). Same MediaPipe WASM as the
// face worker, loaded from the app's origin; one engine instance per worker.
import { createEngineHost, installWorkerSafeguards } from "./engineHost.js";

// Before any engine code runs: MediaPipe would otherwise send usage statistics to Google.
installWorkerSafeguards(self);

createEngineHost({
  endpoint: self,
  loaders: {
    "mp-object-detector": async () => {
      const [{ MediapipeObjectDetectorEngine }, { mediapipeRuntime }, { cropFrame }] =
        await Promise.all([
          import("../engines/objects/MediapipeObjectDetectorEngine.js"),
          import("../engines/face/mediapipeRuntime.js"),
          import("../engines/objects/cropFrame.js"),
        ]);
      const runtime = { ...mediapipeRuntime, cropFrame };
      return class MediapipeObjectDetector extends MediapipeObjectDetectorEngine {
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
