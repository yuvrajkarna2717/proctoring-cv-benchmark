import { useEffect } from "react";
import Button from "react-bootstrap/Button";
import { useLabController, useLabSnapshot } from "../common/labContext.js";

/**
 * Full-window layer for the attention calibration: a dot at the current target, the
 * instruction, and progress. Shown only while a calibration runs. Escape cancels.
 */
export function CalibrationOverlay() {
  const controller = useLabController();
  const { attention } = useLabSnapshot();
  const { calibration } = attention;
  const running = calibration.status === "running";

  useEffect(() => {
    if (!running) return undefined;
    const onKey = (/** @type {KeyboardEvent} */ event) => {
      if (event.key === "Escape") controller.cancelAttentionCalibration();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller, running]);

  useEffect(() => {
    // Leave full screen when the run ends (it was entered when the run started).
    if (!running && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, [running]);

  if (!running || !calibration.target) return null;
  const { target } = calibration;
  return (
    <div className="calibration-overlay" data-testid="calibration-overlay">
      <div
        className={`calibration-dot ${calibration.phase === "sample" ? "sampling" : ""}`}
        style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%` }}
        data-testid="calibration-dot"
        data-target={target.id}
      />
      <div className="calibration-message">
        <div className="fw-semibold">{calibration.message}</div>
        <div className="small opacity-75">
          Point {calibration.index + 1} of {calibration.total}
          {calibration.attempt > 1 ? ` · attempt ${calibration.attempt}` : ""} · move your eyes (and
          head, if you normally do) to the dot, then hold still
        </div>
        <Button
          size="sm"
          variant="outline-light"
          className="mt-2"
          onClick={() => controller.cancelAttentionCalibration()}
        >
          Cancel (Esc)
        </Button>
      </div>
    </div>
  );
}
