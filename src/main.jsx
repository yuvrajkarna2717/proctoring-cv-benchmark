import "bootstrap/dist/css/bootstrap.min.css";
import "./app/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.jsx";
import { LabController } from "./app/LabController.js";
import { LabControllerContext } from "./ui/common/labContext.js";

const controller = new LabController();
void controller.loadDeviceProfile();

// Automation hook used by scripts/browser-smoke.mjs. Only exposed when the URL asks for it.
if (new URLSearchParams(window.location.search).has("automation")) {
  window.__CV_LAB__ = controller;
}

// Release the camera and workers when the page goes away. A page restored from the
// back/forward cache keeps its controller, so only the camera is stopped in that case.
window.addEventListener("pagehide", (event) => {
  if (event.persisted) controller.stopCamera();
  else void controller.dispose();
});

createRoot(/** @type {HTMLElement} */ (document.getElementById("root"))).render(
  <StrictMode>
    <LabControllerContext value={controller}>
      <App />
    </LabControllerContext>
  </StrictMode>,
);
