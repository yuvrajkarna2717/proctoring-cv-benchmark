import { useState } from "react";
import Button from "react-bootstrap/Button";
import ProgressBar from "react-bootstrap/ProgressBar";
import { describeError } from "../../utils/errors.js";
import { ConfirmButton } from "../common/ConfirmButton.jsx";
import { formatNumber } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { formatTime } from "../violations/violationText.js";

/** What to do about the first failed enrollment-gate check of the latest frame, by check id. */
const GATE_HINTS = /** @type {Record<string, string>} */ ({
  face: "no face found yet",
  singleFace: "only one person may be in view",
  score: "face not clear, look straight at the camera",
  interEyePx: "move closer to the camera",
  rollDeg: "keep your head level",
  yawRatio: "face the camera straight on",
  brightness: "light on the face too dark or too bright",
  sharpness: "image blurry, hold still",
  inFrame: "keep your whole face in view",
  model: "the recognizer model changed, start again",
});

/**
 * Setup of the demo page: gaze calibration (the lab's dot calibration, drawn by
 * CalibrationOverlay) and enrollment of the reference face that FACE_MISMATCH compares with.
 * Both need detection running, which the demo starts with the camera.
 */
export function DemoSetup() {
  const controller = useLabController();
  const { attention, identity, detection, engines, violations } = useLabSnapshot();
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const { profile, calibration } = attention;
  const { reference, enrollment, verification } = identity;
  const landmarker = engines.find((engine) => engine.id === attention.sourceEngineId);
  const verifier = engines.find((engine) => engine.id === identity.sourceEngineId);
  const canCalibrate = detection.running && landmarker?.client?.state === "ready";
  const canEnroll = detection.running && verifier?.client?.state === "ready";
  const calibrating = calibration.status === "running";
  const calibrated = profile?.source === "calibration";
  const enrolling = enrollment.status === "collecting" || enrollment.status === "saving";
  const threshold = /** @type {number | undefined} */ (
    violations.rules.find((rule) => rule.type === "FACE_MISMATCH")?.config.similarityThreshold
  );
  const recognizer = verifier?.engineConfig.recognizerModel;
  const modelChanged = Boolean(reference && recognizer && reference.recognizer.id !== recognizer);

  /** @param {() => unknown} action */
  const run = async (action) => {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  const calibrate = () =>
    run(async () => {
      // As in the lab: full screen makes the measured area the whole screen; without it the
      // window is calibrated (reported as a warning).
      let fullscreen = false;
      try {
        await document.documentElement.requestFullscreen();
        fullscreen = true;
      } catch {
        // Not allowed or not supported.
      }
      try {
        controller.startAttentionCalibration({
          width: window.innerWidth,
          height: window.innerHeight,
          fullscreen,
        });
      } catch (startError) {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        throw startError;
      }
    });

  const calibrationStatus = calibrating
    ? "Calibrating, follow the dot"
    : profile?.source === "calibration"
      ? `Calibrated at ${formatTime(profile.createdAt)}`
      : !detection.running
        ? "Start the camera first"
        : profile
          ? "Not calibrated: using a learned baseline"
          : "Not calibrated: learning a baseline";

  /** @type {import('react').ReactNode} */
  let enrollmentStatus = "Not enrolled: face mismatch is off";
  if (enrollment.status === "saving") {
    enrollmentStatus = "Saving the reference…";
  } else if (enrolling) {
    enrollmentStatus = `Sample ${enrollment.accepted} of ${enrollment.required}`;
  } else if (reference) {
    enrollmentStatus = (
      <>
        Enrolled {formatEnrolledAt(reference.createdAt)} ·{" "}
        <span className="demo-inline-confirm">
          <ConfirmButton
            label="Delete"
            confirmLabel="Click again to delete"
            onConfirm={() => run(() => controller.deleteReference())}
          />
        </span>
      </>
    );
  }

  const failedCheck = enrollment.lastGate?.checks.find((check) => !check.passed);
  const last = verification.last;
  const mismatchNow =
    last?.similarity !== null &&
    last?.similarity !== undefined &&
    threshold !== undefined &&
    last.similarity < threshold;

  return (
    <section className="demo-panel" aria-label="Setup" data-testid="demo-setup">
      <h2 className="demo-panel-title">Setup</h2>

      <div className="demo-setup-item">
        <div className="demo-setup-row">
          <div className="demo-setup-text">
            <div className="demo-setup-name">Gaze calibration</div>
            <div className="demo-setup-status" data-testid="demo-calibration-status">
              {calibrationStatus}
            </div>
          </div>
          <Button
            size="sm"
            variant={calibrated ? "outline-primary" : "primary"}
            disabled={!canCalibrate || calibrating}
            title="A dot moves to the centre and the corners; follow it with your eyes (about 15 s, Esc cancels)"
            onClick={() => void calibrate()}
            data-testid="demo-calibrate"
          >
            {calibrated ? "Recalibrate" : "Calibrate gaze"}
          </Button>
        </div>
        {canCalibrate && !calibrated && !calibrating && (
          <div className="demo-setup-note">
            Follow a dot with your eyes, about 15 s. Esc cancels.
          </div>
        )}
        {(calibration.status === "failed" || calibration.status === "cancelled") && (
          <div className="demo-setup-note text-warning-emphasis">{calibration.message}</div>
        )}
        {calibration.status === "done" && calibration.warnings.length > 0 && (
          <div className="demo-setup-note">{calibration.warnings.join(" ")}</div>
        )}
      </div>

      <div className="demo-setup-item">
        <div className="demo-setup-row">
          <div className="demo-setup-text">
            <div className="demo-setup-name">Face enrollment</div>
            <div className="demo-setup-status" data-testid="demo-enrollment-status">
              {enrollmentStatus}
            </div>
          </div>
          {enrolling ? (
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => void run(() => controller.cancelEnrollment())}
              data-testid="demo-enroll-cancel"
            >
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              variant={reference ? "outline-primary" : "primary"}
              disabled={!canEnroll}
              title={canEnroll ? undefined : "Start the camera and wait for the models"}
              onClick={() => void run(() => controller.startEnrollment())}
              data-testid="demo-enroll"
            >
              {reference ? "Re-enroll" : "Enroll face"}
            </Button>
          )}
        </div>
        {enrolling && (
          <>
            <ProgressBar
              now={(enrollment.accepted / Math.max(1, enrollment.required)) * 100}
              className="demo-progress"
            />
            <div className="demo-setup-note">
              Look straight at the camera, alone, in even light
              {failedCheck ? `; ${GATE_HINTS[failedCheck.id] ?? failedCheck.label}` : ""}.
            </div>
          </>
        )}
        {enrollment.status === "failed" && enrollment.failure && (
          <div className="demo-setup-note text-warning-emphasis">{enrollment.failure}</div>
        )}
        {modelChanged && reference && (
          <div className="demo-setup-note text-warning-emphasis">
            Enrolled with {reference.recognizer.id}, but the engine now runs {recognizer}:
            re-enroll.
          </div>
        )}
        {reference && !enrolling && detection.running && last && (
          <div
            className={`demo-setup-note${mismatchNow ? " text-danger" : ""}`}
            data-testid="demo-similarity"
          >
            {comparisonText(last, threshold)}
          </div>
        )}
      </div>

      {error && <div className="demo-setup-note text-danger text-break">{error}</div>}
    </section>
  );
}

/**
 * The latest frame's comparison with the enrolled face.
 *
 * @param {{ similarity: number | null, status: string, failedChecks?: string[] }} last
 * @param {number | undefined} threshold FACE_MISMATCH similarity threshold
 */
function comparisonText(last, threshold) {
  if (last.similarity !== null) {
    const limit = threshold === undefined ? "" : ` · mismatch below ${formatNumber(threshold, 2)}`;
    return `Similarity now ${formatNumber(last.similarity, 2)}${limit}`;
  }
  if (last.status === "no-face") return "No face to compare";
  if (last.status === "model-mismatch") return "Not compared: the reference is from another model";
  const checks = (last.failedChecks ?? []).map(shortLabel).join(", ");
  return `Not compared: ${checks || "face not clear enough"}`;
}

/** e.g. "12 Nov, 17:08". @param {string} isoDate */
function formatEnrolledAt(isoDate) {
  return new Date(isoDate).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Head roll (°)" → "head roll". @param {string} label */
function shortLabel(label) {
  return label.replace(/\s*\(.*\)$/, "").toLowerCase();
}
