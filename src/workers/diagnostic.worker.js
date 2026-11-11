// Worker entry for the diagnostic probe engine. One worker hosts one engine instance; each engine
// kind gets its own entry file so worker bundles only contain that engine's code and so memory
// attribution (measureUserAgentSpecificMemory) can tell engines apart by script URL.
import { createEngineHost, installWorkerSafeguards } from "./engineHost.js";

installWorkerSafeguards(self);

createEngineHost({
  endpoint: self,
  loaders: {
    diagnostic: () =>
      import("../engines/diagnostic/DiagnosticEngine.js").then((module) => module.DiagnosticEngine),
  },
});
