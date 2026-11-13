import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Form from "react-bootstrap/Form";
import { formatRetention } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";

/** Explicit consent gate shown before any camera access. */
export function ConsentNotice() {
  const controller = useLabController();
  const { consentAt, snapshots } = useLabSnapshot();
  const [acknowledged, setAcknowledged] = useState(false);

  if (consentAt) {
    return (
      <Alert variant="light" className="small py-2 mb-3 border">
        Consent recorded at {new Date(consentAt).toLocaleString()}. Video is processed in this
        browser only.
      </Alert>
    );
  }

  return (
    <Card border="warning" className="mb-3" data-testid="consent-notice">
      <Card.Header className="py-2">Camera consent</Card.Header>
      <Card.Body className="small">
        <p className="mb-2">
          This research tool analyses your webcam video to evaluate computer vision models.
        </p>
        <ul className="mb-2">
          <li>
            All processing runs locally in this browser. No video, images, or biometric data are
            uploaded.
          </li>
          {snapshots.enabled && (
            <li>
              When a violation starts, a snapshot of the camera image is saved in this browser with
              the violation&apos;s details, for review. Snapshots are deleted after{" "}
              {formatRetention(snapshots.maxAgeMs)} (if the browser was closed by then, when the lab
              is next opened), or earlier with &quot;Delete all&quot; under Snapshots.
            </li>
          )}
          <li>
            {snapshots.enabled ? "No other images are stored." : "No images are stored."} If you
            enroll a reference face or record calibration samples, the lab stores face templates
            (128 numbers computed from a face, not pictures) in this browser&apos;s storage until
            you delete them with &quot;Delete all identity data&quot;. Landmarks and templates never
            appear in exported reports.
          </li>
          <li>
            Exported reports contain timing measurements and device information, never images.
          </li>
          <li>You can stop the camera at any time; stopping releases the device.</li>
        </ul>
        <Form.Check
          id="consent-checkbox"
          label="I understand and consent to camera capture for this test session."
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <Button
          className="mt-2"
          size="sm"
          disabled={!acknowledged}
          onClick={() => controller.recordConsent()}
        >
          Continue
        </Button>
      </Card.Body>
    </Card>
  );
}
