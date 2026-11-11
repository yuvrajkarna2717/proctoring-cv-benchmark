import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Col from "react-bootstrap/Col";
import Form from "react-bootstrap/Form";
import Row from "react-bootstrap/Row";
import Table from "react-bootstrap/Table";
import { describeError } from "../../utils/errors.js";
import { ConfirmButton } from "../common/ConfirmButton.jsx";
import { downloadJson, timestampedFilename } from "../common/download.js";
import { formatClock, formatNumber } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { RocCurve, ScoreHistogram } from "./Charts.jsx";
import { GateChecks, SessionProgress } from "./GateChecks.jsx";

const CONDITION_FIELDS = /** @type {const} */ ([
  ["lighting", "Lighting", ["office", "dim", "backlit", "window side light"]],
  ["pose", "Pose", ["frontal", "slight turn", "looking down"]],
  ["distance", "Distance", ["near (≈40 cm)", "normal (≈60 cm)", "far (≈1 m)"]],
  ["accessories", "Accessories", ["none", "glasses", "headphones", "mask", "cap"]],
]);

/** @param {number | null | undefined} rate */
const percent = (rate) =>
  rate === null || rate === undefined ? "—" : `${(rate * 100).toFixed(2)}%`;

/**
 * Threshold calibration on a local test set: labelled captures of several persons and
 * conditions, genuine/impostor score distributions, FAR/FRR, EER, and ROC for the current
 * recognizer and FACE_MISMATCH threshold.
 */
export function CalibrationPanel() {
  const controller = useLabController();
  const snapshot = useLabSnapshot();
  const { identity, detection } = snapshot;
  const capture = identity.calibrationCapture;
  const results = identity.calibrationResults;
  const metrics = results.metrics;
  const rule = snapshot.violations.rules.find((candidate) => candidate.type === "FACE_MISMATCH");
  const threshold = /** @type {number} */ (rule?.config.similarityThreshold);
  const [person, setPerson] = useState("P1");
  const [conditions, setConditions] = useState(
    /** @type {Record<string, string>} */ ({
      lighting: "office",
      pose: "frontal",
      distance: "normal (≈60 cm)",
      accessories: "none",
    }),
  );
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const collecting = capture.status === "collecting" || capture.status === "saving";

  /** @param {() => unknown} action */
  const run = async (action) => {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  /** @param {number | null | undefined} value */
  const applyThreshold = (value) =>
    run(() =>
      controller.updateViolationRule("FACE_MISMATCH", {
        similarityThreshold: Math.round(/** @type {number} */ (value) * 1000) / 1000,
      }),
    );

  return (
    <Card className="mb-3" data-testid="calibration-panel">
      <Card.Header className="py-2 d-flex align-items-center gap-2">
        Threshold calibration
        <span className="small text-muted">
          {results.recognizer} · {identity.calibration.sampleCount} samples stored
        </span>
      </Card.Header>
      <Card.Body className="small">
        <p className="text-muted mb-2">
          Capture each person several times under different conditions. Use pseudonyms (P1, P2), not
          names. Each capture takes {identity.config.calibration.samplesPerCapture} frames that pass
          the verification gate.
        </p>
        <Row className="g-2 align-items-end mb-2">
          <Col xs={6} md={4}>
            <Form.Group controlId="calibration-person">
              <Form.Label className="mb-0">Person (pseudonym)</Form.Label>
              <Form.Control
                size="sm"
                value={person}
                maxLength={40}
                disabled={collecting}
                onChange={(event) => setPerson(event.target.value)}
              />
            </Form.Group>
          </Col>
          {CONDITION_FIELDS.map(([key, label, options]) => (
            <Col xs={6} md={4} key={key}>
              <Form.Group controlId={`calibration-${key}`}>
                <Form.Label className="mb-0">{label}</Form.Label>
                <Form.Control
                  size="sm"
                  list={`calibration-${key}-options`}
                  value={conditions[key] ?? ""}
                  maxLength={40}
                  disabled={collecting}
                  onChange={(event) => setConditions({ ...conditions, [key]: event.target.value })}
                />
                <datalist id={`calibration-${key}-options`}>
                  {options.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </Form.Group>
            </Col>
          ))}
          <Col xs={12} md={4}>
            {collecting ? (
              <Button
                size="sm"
                variant="outline-secondary"
                onClick={() => run(() => controller.cancelCalibrationCapture())}
              >
                Cancel capture
              </Button>
            ) : (
              <Button
                size="sm"
                id="calibration-capture"
                disabled={!detection.running}
                title={detection.running ? undefined : "Start detection first"}
                onClick={() =>
                  run(() => controller.startCalibrationCapture({ person, conditions }))
                }
              >
                Capture samples
              </Button>
            )}
          </Col>
        </Row>
        {capture.status !== "idle" && (
          <div className="border rounded p-2 mb-2" data-testid="calibration-progress">
            {capture.capture && <div className="mb-1">Capture of “{capture.capture.person}”</div>}
            <SessionProgress session={capture} />
            {collecting && <GateChecks gate={capture.lastGate} />}
          </div>
        )}

        {identity.calibration.captures.length > 0 && (
          <details className="mb-2">
            <summary>
              {identity.calibration.captures.length} captures of {results.composition.personCount}{" "}
              persons for {results.recognizer}
              {results.excludedOtherModel > 0 &&
                ` (${results.excludedOtherModel} samples of another model not used)`}
            </summary>
            <Table size="sm" className="metric-table mb-1" data-testid="calibration-captures">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Conditions</th>
                  <th>Samples</th>
                  <th title="Frames that failed the gate / frames seen">Rejected</th>
                  <th>Model</th>
                  <th>Time</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {identity.calibration.captures.map((item) => (
                  <tr key={item.id}>
                    <td>{item.person}</td>
                    <td className="text-wrap">{Object.values(item.conditions).join(", ")}</td>
                    <td>{item.samples}</td>
                    <td>
                      {item.captureStats.framesRejected} / {item.captureStats.framesOffered}
                    </td>
                    <td>{item.recognizer?.id}</td>
                    <td className="font-monospace">{formatClock(item.capturedAt)}</td>
                    <td>
                      <Button
                        size="sm"
                        variant="link"
                        className="p-0"
                        onClick={() => run(() => controller.deleteCalibrationCapture(item.id))}
                      >
                        delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        )}

        <div data-testid="calibration-results">
          {!results.ready || !metrics ? (
            <div className="text-muted mb-2">{results.reason ?? "No results yet."}</div>
          ) : (
            <>
              <Table size="sm" className="metric-table mb-2">
                <tbody>
                  <tr>
                    <td>Pairs</td>
                    <td>
                      {metrics.genuineCount} genuine · {metrics.impostorCount} impostor (from{" "}
                      {results.composition.captureCount} captures of{" "}
                      {results.composition.personCount} persons; pairs from one capture are
                      correlated)
                    </td>
                  </tr>
                  <tr>
                    <td>At threshold {threshold}</td>
                    <td>
                      FAR {percent(metrics.atThreshold.far)} ({metrics.atThreshold.falseAccepts}{" "}
                      false accepts) · FRR {percent(metrics.atThreshold.frr)} (
                      {metrics.atThreshold.falseRejects} false rejects)
                    </td>
                  </tr>
                  <tr>
                    <td>EER</td>
                    <td>
                      {percent(metrics.eer?.rate)} at threshold{" "}
                      {formatNumber(metrics.eer?.threshold, 3)}{" "}
                      <Button
                        size="sm"
                        variant="link"
                        className="p-0 align-baseline"
                        onClick={() => applyThreshold(metrics.eer?.threshold)}
                      >
                        use
                      </Button>
                    </td>
                  </tr>
                  {metrics.farTargets.map((target) => (
                    <tr key={target.far}>
                      <td>FAR ≤ {percent(target.far)}</td>
                      <td>
                        {target.threshold === null ? (
                          "not reached"
                        ) : (
                          <>
                            threshold {formatNumber(target.threshold, 3)}, FRR {percent(target.frr)}{" "}
                            <Button
                              size="sm"
                              variant="link"
                              className="p-0 align-baseline"
                              onClick={() => applyThreshold(target.threshold)}
                            >
                              use
                            </Button>
                          </>
                        )}
                        {!target.measurable &&
                          ` (needs ≥ ${Math.ceil(1 / target.far)} impostor pairs to resolve; smallest measurable FAR ${percent(metrics.minMeasurableFar)})`}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Scores</td>
                    <td>
                      genuine {formatNumber(metrics.genuineStats?.min, 3)}–
                      {formatNumber(metrics.genuineStats?.max, 3)} · impostor{" "}
                      {formatNumber(metrics.impostorStats?.min, 3)}–
                      {formatNumber(metrics.impostorStats?.max, 3)}
                    </td>
                  </tr>
                </tbody>
              </Table>
              <Row className="g-2 mb-2">
                <Col md={8}>
                  <ScoreHistogram histogram={metrics.histogram} threshold={threshold} />
                </Col>
                <Col md={4}>
                  <RocCurve roc={metrics.roc} at={metrics.atThreshold} />
                </Col>
              </Row>
              <div className="text-muted mb-2">{results.protocol}</div>
            </>
          )}
        </div>
        <div className="d-flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline-primary"
            disabled={identity.calibration.sampleCount === 0}
            onClick={() =>
              run(() =>
                downloadJson(
                  timestampedFilename("cv-lab-calibration"),
                  controller.exportCalibration(),
                ),
              )
            }
          >
            Export results (no embeddings)
          </Button>
          <span className="ms-auto">
            <ConfirmButton
              label="Delete all calibration samples"
              disabled={identity.calibration.sampleCount === 0}
              onConfirm={() => run(() => controller.clearCalibration())}
            />
          </span>
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
