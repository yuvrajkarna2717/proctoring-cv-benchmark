import { CalibrationOverlay } from "../../ui/attention/CalibrationOverlay.jsx";
import { ConsentNotice } from "../../ui/camera/ConsentNotice.jsx";
import { useLabSnapshot } from "../../ui/common/labContext.js";
import { DemoCamera } from "../../ui/demo/DemoCamera.jsx";
import { DemoSetup } from "../../ui/demo/DemoSetup.jsx";
import { ViolationLog } from "../../ui/demo/ViolationLog.jsx";
import { ViolationToasts } from "../../ui/demo/ViolationToasts.jsx";

/**
 * `/demo`: the camera preview with its overlay switches and a toast under it for every
 * violation; beside it, gaze calibration, face enrollment, and the log of the session's
 * violations. Engines and rules run with the default configuration; the lab at `/` has the
 * measurements and settings.
 */
export function DemoPage() {
  const snapshot = useLabSnapshot();
  const status = demoStatus(snapshot);
  return (
    <main className="demo-page">
      <div className="demo-stage">
        <header className="demo-header">
          <div>
            <h1 className="demo-title">Proctoring demo</h1>
            <div className="small text-body-secondary">
              Video is analysed in this browser; nothing is uploaded.
            </div>
          </div>
          <span className="demo-status" data-tone={status.tone} data-testid="demo-status">
            <span className="demo-status-dot" aria-hidden="true" />
            {status.text}
          </span>
        </header>
        {!snapshot.consentAt && <ConsentNotice />}
        <div className="demo-layout">
          {/* Keeps the sticky toasts (app.css) within the camera column. */}
          <div className="demo-camera">
            <DemoCamera />
            <ViolationToasts />
          </div>
          <aside className="demo-side">
            <DemoSetup />
            <ViolationLog />
          </aside>
        </div>
      </div>
      <CalibrationOverlay />
    </main>
  );
}

/**
 * @param {ReturnType<import('../LabController.js').LabController['getSnapshot']>} snapshot
 * @returns {{ tone: 'idle' | 'busy' | 'wait' | 'live' | 'error', text: string }}
 */
function demoStatus({ camera, detection, engines, attention }) {
  if (camera.status === "error") return { tone: "error", text: "Camera error" };
  if (camera.status === "starting") return { tone: "busy", text: "Starting camera…" };
  if (camera.status !== "active") return { tone: "idle", text: "Camera off" };
  const loading = engines.some(
    (engine) => engine.scheduler.enabled && (!engine.client || engine.busyAction === "loading"),
  );
  if (loading) return { tone: "busy", text: "Loading models…" };
  if (!detection.running) return { tone: "busy", text: "Starting detection…" };
  // Without a baseline (calibrated, or learned in the first seconds) gaze and head rules wait.
  if (!attention.profile) return { tone: "wait", text: "Learning baseline · look at the screen" };
  return { tone: "live", text: "Monitoring" };
}
