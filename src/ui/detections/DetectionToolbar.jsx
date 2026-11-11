import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import { describeError } from "../../utils/errors.js";
import { downloadJson, timestampedFilename } from "../common/download.js";
import { formatDuration } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";

/** Start/stop detection, reset the measurement window, measure memory, export the report. */
export function DetectionToolbar() {
  const controller = useLabController();
  const { detection, camera, monitor } = useLabSnapshot();
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const cameraActive = camera.status === "active";

  const startDetection = () => {
    try {
      controller.startDetection();
      setError(null);
    } catch (startError) {
      setError(describeError(startError));
    }
  };

  return (
    <Card className="mb-3">
      <Card.Body className="py-2 d-flex flex-wrap gap-2 align-items-center">
        {detection.running ? (
          <Button size="sm" variant="danger" onClick={() => controller.stopDetection()}>
            Stop detection
          </Button>
        ) : (
          <Button size="sm" variant="success" disabled={!cameraActive} onClick={startDetection}>
            Start detection
          </Button>
        )}
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={!cameraActive}
          onClick={() => controller.resetMetrics()}
        >
          Reset metrics
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={monitor.memoryPending}
          onClick={() => controller.measureMemory()}
        >
          {monitor.memoryPending ? "Measuring memory…" : "Measure memory"}
        </Button>
        <Button
          size="sm"
          variant="outline-primary"
          onClick={() =>
            downloadJson(timestampedFilename("cv-lab-report"), controller.buildReport())
          }
        >
          Export report (JSON)
        </Button>
        <span className="ms-auto small text-muted">
          {detection.running
            ? `Detection running · window ${formatDuration(monitor.elapsedMs)}`
            : "Detection stopped"}
        </span>
        {error && (
          <Alert variant="warning" className="small py-1 mb-0 w-100">
            {error}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}
