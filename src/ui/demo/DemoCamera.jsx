import { useRef, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { describeError } from "../../utils/errors.js";
import { FaceOverlay } from "../camera/FaceOverlay.jsx";
import { ObjectOverlay } from "../camera/ObjectOverlay.jsx";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { objectEngineViews } from "../objects/objectEngines.js";

/**
 * Camera preview of the demo page with the lab's overlay switches. "Start camera" opens the
 * camera, waits until the enabled engines have loaded, and starts detection; "Stop camera" stops
 * detection and releases the camera.
 */
export function DemoCamera() {
  const controller = useLabController();
  const { camera, consentAt, violations, identity, engines } = useLabSnapshot();
  const videoRef = useRef(/** @type {HTMLVideoElement | null} */ (null));
  // Bumped by every start and stop: a start stopped while the engines load must not go on to
  // start detection.
  const startAttempt = useRef(0);
  const [deviceId, setDeviceId] = useState("");
  const [mirrored, setMirrored] = useState(true);
  const [overlay, setOverlay] = useState(true);
  const [landmarks, setLandmarks] = useState(true);
  const [objectBoxes, setObjectBoxes] = useState(true);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const active = camera.status === "active";
  const starting = camera.status === "starting";
  // The same overlays as the lab's camera panel.
  const faceEngineIds = [...new Set([violations.sourceEngineId, identity.sourceEngineId])];
  const objectEngines = objectEngineViews(engines).filter(({ engine }) => engine.scheduler.enabled);
  const watchedLabels = violations.rules
    .filter((rule) => rule.input === "objects" && rule.config.enabled)
    .map((rule) => String(rule.config.label));
  const failedEngines = engines.filter(
    (engine) => engine.scheduler.enabled && engine.client?.state === "error",
  );

  const start = async () => {
    const video = videoRef.current;
    if (!video) return;
    const attempt = ++startAttempt.current;
    setError(null);
    try {
      // Resolves once the enabled engines have loaded (or failed to).
      const started = await controller.startCamera(video, deviceId || null);
      const stillWanted =
        attempt === startAttempt.current && controller.getSnapshot().camera.status === "active";
      if (started && stillWanted) controller.startDetection();
    } catch (startError) {
      setError(describeError(startError));
    }
  };

  const stop = () => {
    startAttempt.current += 1;
    controller.stopCamera();
  };

  const placeholder = !consentAt
    ? "Give consent above to use the camera"
    : starting
      ? "Starting camera…"
      : "Camera off";

  return (
    <section className="demo-card" aria-label="Camera">
      <div className="demo-toolbar">
        {active ? (
          <Button size="sm" variant="outline-secondary" onClick={stop}>
            Stop camera
          </Button>
        ) : (
          <Button size="sm" disabled={!consentAt || starting} onClick={() => void start()}>
            {starting ? "Starting…" : "Start camera"}
          </Button>
        )}
        {camera.devices.length > 1 && (
          <Form.Select
            size="sm"
            aria-label="Camera device"
            value={deviceId}
            disabled={active || starting}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            <option value="">Default camera</option>
            {camera.devices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `Camera ${index + 1}`}
              </option>
            ))}
          </Form.Select>
        )}
        <div className="demo-switches">
          <Form.Check
            type="switch"
            id="demo-mirror"
            label="Mirror preview"
            checked={mirrored}
            onChange={(event) => setMirrored(event.target.checked)}
          />
          <Form.Check
            type="switch"
            id="demo-face-overlay"
            label="Face overlay"
            checked={overlay}
            onChange={(event) => setOverlay(event.target.checked)}
          />
          <Form.Check
            type="switch"
            id="demo-landmarks"
            label="Landmarks"
            checked={landmarks}
            disabled={!overlay}
            onChange={(event) => setLandmarks(event.target.checked)}
          />
          <Form.Check
            type="switch"
            id="demo-object-boxes"
            label="Object boxes"
            checked={objectBoxes}
            onChange={(event) => setObjectBoxes(event.target.checked)}
          />
        </div>
      </div>
      <div className="video-frame">
        <video ref={videoRef} muted playsInline className={mirrored ? "mirrored" : undefined} />
        {overlay &&
          active &&
          faceEngineIds.map((engineId) => (
            <FaceOverlay
              key={engineId}
              videoRef={videoRef}
              engineId={engineId}
              mirrored={mirrored}
              showLandmarks={landmarks}
            />
          ))}
        {objectBoxes &&
          active &&
          objectEngines.map(({ engine, color, name }) => (
            <ObjectOverlay
              key={engine.id}
              videoRef={videoRef}
              engineId={engine.id}
              name={name}
              color={color}
              mirrored={mirrored}
              highlight={watchedLabels}
            />
          ))}
        {!active && <div className="video-placeholder small">{placeholder}</div>}
      </div>
      {camera.error && (
        <Alert variant="danger" className="small py-2 mt-2 mb-0" data-testid="camera-error">
          {describeError(camera.error)}
        </Alert>
      )}
      {error && (
        <Alert variant="warning" className="small py-2 mt-2 mb-0">
          {error}
        </Alert>
      )}
      {failedEngines.length > 0 && (
        <Alert variant="warning" className="small py-2 mt-2 mb-0" data-testid="demo-engine-error">
          {failedEngines.map((engine) => (
            <div key={engine.id}>
              {engine.label} failed to load, so its violations cannot fire:{" "}
              {engine.client?.lastError?.message ?? "unknown error"}
            </div>
          ))}
        </Alert>
      )}
    </section>
  );
}
