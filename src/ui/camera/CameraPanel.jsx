import { useRef, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Form from "react-bootstrap/Form";
import { describeError } from "../../utils/errors.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { FaceOverlay } from "./FaceOverlay.jsx";

/** Camera selection, start/stop, and the live preview with the face overlay. */
export function CameraPanel() {
  const controller = useLabController();
  const { camera, consentAt, violations, identity } = useLabSnapshot();
  const videoRef = useRef(/** @type {HTMLVideoElement | null} */ (null));
  const [deviceId, setDeviceId] = useState("");
  const [mirrored, setMirrored] = useState(true);
  const [overlay, setOverlay] = useState(true);
  const [landmarks, setLandmarks] = useState(true);
  const active = camera.status === "active";
  const starting = camera.status === "starting";
  const settings = camera.track?.settings;

  const start = () => {
    const video = videoRef.current;
    if (video) void controller.startCamera(video, deviceId || null);
  };

  return (
    <Card className="mb-3">
      <Card.Header className="py-2 d-flex align-items-center gap-2">
        Camera
        <span className={`badge ms-auto text-bg-${active ? "success" : "secondary"}`}>
          {camera.status}
        </span>
      </Card.Header>
      <Card.Body>
        <div className="d-flex flex-wrap gap-2 align-items-end mb-2">
          <Form.Group controlId="camera-device" className="flex-grow-1">
            <Form.Label className="small mb-0">Device</Form.Label>
            <Form.Select
              size="sm"
              value={deviceId}
              disabled={active || starting || !consentAt}
              onChange={(event) => setDeviceId(event.target.value)}
              onFocus={() => {
                if (consentAt) void controller.refreshDevices();
              }}
            >
              <option value="">Default camera</option>
              {camera.devices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Button size="sm" onClick={start} disabled={!consentAt || active || starting}>
            {starting ? "Starting…" : "Start camera"}
          </Button>
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => controller.stopCamera()}
            disabled={!active}
          >
            Stop camera
          </Button>
          <Form.Check
            type="switch"
            id="camera-mirror"
            label="Mirror preview"
            className="small"
            checked={mirrored}
            onChange={(event) => setMirrored(event.target.checked)}
          />
          <Form.Check
            type="switch"
            id="camera-overlay"
            label="Face overlay"
            className="small"
            checked={overlay}
            onChange={(event) => setOverlay(event.target.checked)}
          />
          <Form.Check
            type="switch"
            id="camera-landmarks"
            label="Landmarks"
            className="small"
            checked={landmarks}
            disabled={!overlay}
            onChange={(event) => setLandmarks(event.target.checked)}
          />
        </div>
        <div className="video-frame">
          <video ref={videoRef} muted playsInline className={mirrored ? "mirrored" : undefined} />
          {overlay &&
            active &&
            [...new Set([violations.sourceEngineId, identity.sourceEngineId])].map((engineId) => (
              <FaceOverlay
                key={engineId}
                videoRef={videoRef}
                engineId={engineId}
                mirrored={mirrored}
                showLandmarks={landmarks}
              />
            ))}
          {!active && <div className="video-placeholder small">Camera off</div>}
        </div>
        {camera.error && (
          <Alert variant="danger" className="small py-2 mt-2 mb-0" data-testid="camera-error">
            {describeError(camera.error)}
          </Alert>
        )}
        <div className="small text-muted mt-2">
          {settings ? (
            <>
              Delivered mode: {settings.width}×{settings.height} @ {settings.frameRate} fps ·{" "}
              {camera.track?.label}
              {camera.track?.muted ? " · muted" : ""}
            </>
          ) : (
            "Mirroring affects the preview only; engines receive unmirrored frames."
          )}
          {camera.releasedTrackStates && !active && (
            <div>Last stop released tracks: {camera.releasedTrackStates.join(", ")}</div>
          )}
        </div>
      </Card.Body>
    </Card>
  );
}
