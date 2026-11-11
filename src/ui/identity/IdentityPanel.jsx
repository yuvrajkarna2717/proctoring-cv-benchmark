import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Col from "react-bootstrap/Col";
import Form from "react-bootstrap/Form";
import Row from "react-bootstrap/Row";
import { describeError } from "../../utils/errors.js";
import { CommitNumberInput } from "../common/CommitNumberInput.jsx";
import { ConfirmButton } from "../common/ConfirmButton.jsx";
import { formatNumber } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { SimilaritySparkline } from "./Charts.jsx";
import { GateChecks, SessionProgress } from "./GateChecks.jsx";

const STATUS_TEXT = {
  compared: "compared",
  "no-face": "no face embedded",
  "gate-failed": "not compared: failed the verification gate",
  "model-mismatch": "not compared: the reference was enrolled with another recognizer model",
};

const GATE_NUMBERS = /** @type {const} */ ([
  ["minScore", "Min detector score", 0.05],
  ["minInterEyePx", "Min eye distance (px)", 1],
  ["maxAbsRollDeg", "Max |roll| (°)", 1],
  ["maxAbsYawRatio", "Max |yaw proxy|", 0.01],
  ["minBrightness", "Min brightness", 1],
  ["maxBrightness", "Max brightness", 1],
  ["minSharpness", "Min sharpness", 1],
]);

/**
 * 1:1 verification: enrollment of a reference with a quality gate, live similarity to it, gate
 * settings, and deletion of stored identity data.
 */
export function IdentityPanel() {
  const controller = useLabController();
  const snapshot = useLabSnapshot();
  const { identity, detection } = snapshot;
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const verifier = snapshot.engines.find((engine) => engine.id === identity.sourceEngineId);
  const rule = snapshot.violations.rules.find((candidate) => candidate.type === "FACE_MISMATCH");
  const threshold = /** @type {number} */ (rule?.config.similarityThreshold);
  const { reference, enrollment, verification, storage } = identity;
  const collecting = enrollment.status === "collecting" || enrollment.status === "saving";
  const currentRecognizer = verifier?.engineConfig.recognizerModel;
  const modelMismatch =
    reference && currentRecognizer && reference.recognizer.id !== currentRecognizer;
  const last = verification.last;

  /** @param {() => unknown} action */
  const run = async (action) => {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  return (
    <Card className="mb-3" data-testid="identity-panel">
      <Card.Header className="py-2 d-flex align-items-center gap-2">
        Identity (1:1 verification)
        <span className="small text-muted">source {identity.sourceEngineId}</span>
        <Badge bg={storage.kind === "indexeddb" ? "secondary" : "warning"} className="ms-auto">
          storage: {storage.kind}
          {storage.loadState === "error" ? " (error)" : ""}
        </Badge>
      </Card.Header>
      <Card.Body className="small">
        {storage.error && (
          <Alert variant="danger" className="py-1">
            {storage.error}
          </Alert>
        )}
        <div className="mb-2" data-testid="identity-reference">
          {reference ? (
            <>
              <strong>Reference enrolled</strong> {new Date(reference.createdAt).toLocaleString()} ·{" "}
              {reference.samples} samples ({reference.recognizer.id}) · sample agreement{" "}
              {formatNumber(reference.sampleSimilarity.min, 3)} min /{" "}
              {formatNumber(reference.sampleSimilarity.mean, 3)} mean
              {reference.camera && ` · ${reference.camera.label}`}
            </>
          ) : (
            <span className="text-muted">
              No reference enrolled. FACE_MISMATCH is not evaluated until one is.
            </span>
          )}
        </div>
        {modelMismatch && (
          <Alert variant="warning" className="py-1">
            The reference was enrolled with {reference.recognizer.id}, but the engine now runs{" "}
            {currentRecognizer}. Embeddings of different models are not comparable: re-enroll.
          </Alert>
        )}
        <div className="d-flex flex-wrap gap-2 mb-2">
          {collecting ? (
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => run(() => controller.cancelEnrollment())}
            >
              Cancel enrollment
            </Button>
          ) : (
            <Button
              size="sm"
              id="identity-enroll"
              disabled={!detection.running || verifier?.client?.state !== "ready"}
              title={
                verifier?.client?.state !== "ready"
                  ? "Load the face verification engine first"
                  : detection.running
                    ? undefined
                    : "Start detection first"
              }
              onClick={() => run(() => controller.startEnrollment())}
            >
              {reference ? "Re-enroll" : "Enroll reference"}
            </Button>
          )}
          {reference && (
            <ConfirmButton
              label="Delete reference"
              onConfirm={() => run(() => controller.deleteReference())}
            />
          )}
        </div>
        {enrollment.status !== "idle" && (
          <div className="border rounded p-2 mb-2" data-testid="identity-enrollment">
            <SessionProgress session={enrollment} />
            {collecting && (
              <>
                <div className="text-muted my-1">
                  Look straight at the camera, alone, in even light. Samples are taken at least{" "}
                  {identity.config.enrollment.minIntervalMs} ms apart.
                </div>
                <GateChecks gate={enrollment.lastGate} testId="enrollment-gate" />
              </>
            )}
          </div>
        )}
        {reference && (
          <div className="mb-2" data-testid="identity-verification">
            <div className="mb-1">
              Last frame:{" "}
              {last ? (
                <>
                  <strong>
                    {last.similarity !== null
                      ? `similarity ${formatNumber(last.similarity, 3)}`
                      : STATUS_TEXT[last.status]}
                  </strong>
                  {last.similarity !== null &&
                    (last.similarity < threshold ? (
                      <Badge bg="danger" className="ms-1">
                        below threshold {threshold}
                      </Badge>
                    ) : (
                      <Badge bg="success" className="ms-1">
                        at or above {threshold}
                      </Badge>
                    ))}
                  {last.failedChecks && ` (${last.failedChecks.join(", ")})`}
                </>
              ) : (
                "—"
              )}
            </div>
            <SimilaritySparkline recent={verification.recent} threshold={threshold} />
            <div className="text-muted mt-1">
              Compared {verification.counts.compared} · no face {verification.counts["no-face"]} ·
              gate failed {verification.counts["gate-failed"]} · model mismatch{" "}
              {verification.counts["model-mismatch"]}
              {verification.recentSimilarity &&
                ` · recent similarity ${formatNumber(verification.recentSimilarity.min, 3)}–${formatNumber(verification.recentSimilarity.max, 3)} (mean ${formatNumber(verification.recentSimilarity.mean, 3)})`}
              . Cosine similarity, not a probability.
            </div>
          </div>
        )}
        <details className="mb-2">
          <summary>
            Quality gates (starting values; measured values appear during enrollment)
          </summary>
          {
            /** @type {const} */ (["enrollment", "verification"]).map((kind) => {
              const gate = identity.config[kind].gate;
              return (
                <div key={kind} className="mt-2">
                  <div className="fw-semibold text-capitalize">{kind} gate</div>
                  <Row className="g-2 align-items-end">
                    {GATE_NUMBERS.map(([key, label, step]) => (
                      <Col xs={6} md={3} key={key}>
                        <CommitNumberInput
                          key={`${kind}-${key}-${gate[key]}`}
                          id={`gate-${kind}-${key}`}
                          label={label}
                          value={gate[key]}
                          min={0}
                          step={step}
                          onCommit={(value) => controller.updateQualityGate(kind, { [key]: value })}
                        />
                      </Col>
                    ))}
                    {
                      /** @type {const} */ ([
                        ["requireSingleFace", "Exactly one face"],
                        ["requireInFrame", "Face fully in frame"],
                      ]).map(([key, label]) => (
                        <Col xs={6} md={3} key={key}>
                          <Form.Check
                            type="switch"
                            id={`gate-${kind}-${key}`}
                            label={label}
                            checked={gate[key]}
                            onChange={(event) =>
                              run(() =>
                                controller.updateQualityGate(kind, { [key]: event.target.checked }),
                              )
                            }
                          />
                        </Col>
                      ))
                    }
                  </Row>
                </div>
              );
            })
          }
        </details>
        <div className="d-flex flex-wrap gap-2 align-items-center">
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => run(() => controller.testIdentityStorage())}
          >
            Test storage
          </Button>
          {storage.selfTest && (
            <span className={storage.selfTest.ok ? "text-success" : "text-danger"}>
              {storage.selfTest.ok ? "write/read/delete OK" : `failed: ${storage.selfTest.error}`} (
              {formatNumber(storage.selfTest.ms, 1)} ms)
            </span>
          )}
          <span className="ms-auto">
            <ConfirmButton
              id="identity-delete-all"
              label="Delete all identity data"
              onConfirm={() => run(() => controller.deleteAllIdentityData())}
            />
          </span>
        </div>
        <div className="text-muted mt-2">
          The reference and calibration samples are face templates (128 numbers each), stored only
          in this browser ({storage.kind === "indexeddb" ? "IndexedDB" : "memory, lost on reload"}).
          They are never in exported reports.
        </div>
        {error && (
          <Alert variant="warning" className="py-1 mt-2 mb-0 text-break">
            {error}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}
