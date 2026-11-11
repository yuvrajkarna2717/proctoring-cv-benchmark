// Worker entry for the image-quality engine (model-free pixel statistics). One worker hosts one
// engine instance; each engine kind has its own entry file (see diagnostic.worker.js).
import { createEngineHost, installWorkerSafeguards } from "./engineHost.js";

installWorkerSafeguards(self);
createEngineHost({
  endpoint: self,
  loaders: {
    "image-quality": () =>
      import("../engines/quality/ImageQualityEngine.js").then(
        (module) => module.ImageQualityEngine,
      ),
  },
});
