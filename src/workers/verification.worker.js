// Worker entry for the face verification engine (YuNet + SFace on ONNX Runtime Web). The loader
// imports the engine and ONNX Runtime's JavaScript together; the WASM binary and the models are
// loaded during initialize(). ONNX Runtime starts its WASM threads as nested workers.
import { createEngineHost, installWorkerSafeguards } from "./engineHost.js";

installWorkerSafeguards(self);

createEngineHost({
  endpoint: self,
  loaders: {
    "face-verifier": async () => {
      const [{ FaceVerificationEngine }, { ortRuntime }] = await Promise.all([
        import("../engines/verification/FaceVerificationEngine.js"),
        import("../engines/verification/ortRuntime.js"),
      ]);
      return class OrtFaceVerificationEngine extends FaceVerificationEngine {
        /**
         * @param {Record<string, unknown>} config
         * @param {{ now?: () => number }} dependencies
         */
        constructor(config, dependencies) {
          super(config, { ...dependencies, runtime: ortRuntime });
        }
      };
    },
  },
});
