import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Form from "react-bootstrap/Form";
import Table from "react-bootstrap/Table";
import { describeError } from "../../utils/errors.js";
import { CommitNumberInput } from "../common/CommitNumberInput.jsx";
import { formatClock, formatInteger, formatNumber } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { SnapshotsModal } from "../snapshots/SnapshotsModal.jsx";

const STATE_VARIANTS = {
  inactive: "secondary",
  pending: "info",
  active: "danger",
  clearing: "warning",
};
const SEVERITY_VARIANTS = { low: "secondary", medium: "warning", high: "danger" };
const DURATION_LABELS = {
  minDurationMs: "minimum duration",
  clearAfterMs: "clear after",
  cooldownMs: "cooldown",
};
const HISTORY_ROWS = 15;

/** @param {number | null | undefined} ms */
const seconds = (ms) => (ms === null || ms === undefined ? "—" : `${formatNumber(ms / 1000, 1)} s`);

/**
 * The rule-specific measure of a violation, with the direction and baseline for attention rules.
 * @param {import('../../pipeline/ViolationEngine.js').Violation} violation
 */
function describeMeasure(violation) {
  const toward = violation.direction ? ` ${violation.direction}` : "";
  const uncalibrated = violation.baseline === "learned" ? " (uncalibrated)" : "";
  if (violation.minSimilarity !== null && violation.minSimilarity !== undefined) {
    return `sim ${formatNumber(violation.minSimilarity, 3)}`;
  }
  if (violation.maxExcessDeg !== null && violation.maxExcessDeg !== undefined) {
    return `${formatNumber(violation.maxExcessDeg, 1)}° beyond${toward}${uncalibrated}`;
  }
  if (violation.maxClosure !== null && violation.maxClosure !== undefined) {
    return `blink ${formatNumber(violation.maxClosure, 2)}`;
  }
  if (violation.maxScore !== null && violation.maxScore !== undefined) {
    return `${violation.label} ${formatNumber(violation.maxScore, 2)}`;
  }
  if (violation.reasons) return violation.reasons.join(", ") || "—";
  return `${violation.maxFaceCount} faces`;
}

/**
 * Image problems present when a violation of another rule started.
 * @param {import('../../pipeline/ViolationEngine.js').Violation} violation
 */
function imageNote(violation) {
  return violation.imageIssues && violation.imageIssues.length > 0
    ? `image: ${violation.imageIssues.join(", ")}`
    : "";
}

/**
 * Temporal rules (face, identity, attention, image, objects): live state, editable thresholds, active
 * violations, and history. Thresholds are starting values; changes apply from the next frame.
 */
export function ViolationsPanel() {
  const controller = useLabController();
  const { violations, snapshots } = useLabSnapshot();
  const [error, setError] = useState(/** @type {string | null} */ (null));
  /** null: closed; id null: all snapshots; otherwise one snapshot */
  const [snapshotView, setSnapshotView] = useState(
    /** @type {{ id: string | null } | null} */ (null),
  );

  /**
   * For switches and selects; number inputs show their own validation errors.
   *
   * @param {import('../../config/schema.js').ViolationType} type
   * @param {Record<string, unknown>} patch
   */
  const update = (type, patch) => {
    try {
      controller.updateViolationRule(type, patch);
      setError(null);
    } catch (updateError) {
      setError(describeError(updateError));
    }
  };

  const history = violations.history.slice(-HISTORY_ROWS).reverse();

  return (
    <Card className="mb-3" data-testid="violations-panel">
      <Card.Header className="py-2 d-flex align-items-center gap-2">
        Violations
        <span className="small text-muted">
          faces: {violations.sourceEngineId}, {formatInteger(violations.framesEvaluated)} frames ·
          identity: {violations.identitySourceEngineId},{" "}
          {formatInteger(violations.identityFramesEvaluated)} compared · attention:{" "}
          {formatInteger(violations.attentionFramesEvaluated)} frames · objects:{" "}
          {violations.objectSourceEngineId}, {formatInteger(violations.objectFramesEvaluated)}{" "}
          frames · gap limit {violations.maxGapMs} ms · rule times in ms
        </span>
        {violations.active.length > 0 && (
          <Badge bg="danger" data-testid="violations-active-count">
            {violations.active.length} active
          </Badge>
        )}
        {snapshots.enabled && (
          <Button
            size="sm"
            variant="outline-secondary"
            className="ms-auto text-nowrap"
            onClick={() => setSnapshotView({ id: null })}
            data-testid="open-snapshots"
          >
            Snapshots ({snapshots.count})
          </Button>
        )}
        <Button
          size="sm"
          variant="outline-secondary"
          className={snapshots.enabled ? undefined : "ms-auto"}
          onClick={() => controller.clearViolations()}
        >
          Clear
        </Button>
      </Card.Header>
      <Card.Body className="p-0">
        <Table size="sm" responsive className="metric-table mb-0" data-testid="violation-rules">
          <thead>
            <tr>
              <th>Rule</th>
              <th>State</th>
              <th>On</th>
              <th title="Milliseconds the condition must hold on every frame">Min duration</th>
              <th title="Hysteresis: milliseconds the condition must be absent to end">
                Clear after
              </th>
              <th title="Minimum milliseconds between the end of one violation and the next of the same type">
                Cooldown
              </th>
              <th title="MULTIPLE_FACES: minimum face count. FACE_MISMATCH: cosine similarity below which a compared frame counts as a mismatch (not a probability). GAZE_AWAY, HEAD_TURNED, EYES_CLOSED: severity raised when a violation lasts this long. PHONE_DETECTED: minimum model score of the COCO label, and how many of the last samples must reach it">
                Rule value
              </th>
              <th>Severity</th>
              <th title="Confirmed violations; below them, runs that ended before the minimum duration">
                Count
              </th>
            </tr>
          </thead>
          <tbody>
            {violations.rules.map((rule) => (
              <tr key={rule.type} data-testid={`rule-${rule.type}`}>
                <td>
                  <strong>{rule.type}</strong>
                  <div className="small text-muted text-wrap">{rule.label}</div>
                </td>
                <td>
                  <Badge
                    bg={
                      STATE_VARIANTS[
                        /** @type {keyof typeof STATE_VARIANTS} */ (rule.condition.state)
                      ]
                    }
                  >
                    {rule.config.enabled ? rule.condition.state : "off"}
                  </Badge>
                  {rule.condition.waitingForCooldown && (
                    <div className="small text-muted">
                      cooldown until {formatClock(rule.condition.cooldownUntil)}
                    </div>
                  )}
                </td>
                <td>
                  <Form.Check
                    type="switch"
                    id={`rule-enabled-${rule.type}`}
                    aria-label={`Enable ${rule.type}`}
                    checked={rule.config.enabled}
                    onChange={(event) => update(rule.type, { enabled: event.target.checked })}
                  />
                </td>
                {
                  /** @type {const} */ (["minDurationMs", "clearAfterMs", "cooldownMs"]).map(
                    (key) => (
                      <td key={key} style={{ minWidth: "5.5rem" }}>
                        <CommitNumberInput
                          key={`${rule.type}-${key}-${rule.config[key]}`}
                          id={`rule-${rule.type}-${key}`}
                          ariaLabel={`${rule.type} ${DURATION_LABELS[key]} (ms)`}
                          value={rule.config[key]}
                          min={0}
                          step={100}
                          onCommit={(value) =>
                            controller.updateViolationRule(rule.type, { [key]: value })
                          }
                        />
                      </td>
                    ),
                  )
                }
                <td style={{ minWidth: "5rem" }}>
                  {"minFaces" in rule.config ? (
                    <CommitNumberInput
                      key={`${rule.type}-minFaces-${rule.config.minFaces}`}
                      id={`rule-${rule.type}-minFaces`}
                      ariaLabel={`${rule.type} minimum number of faces`}
                      value={/** @type {number} */ (rule.config.minFaces)}
                      min={2}
                      max={10}
                      step={1}
                      onCommit={(value) =>
                        controller.updateViolationRule(rule.type, { minFaces: value })
                      }
                    />
                  ) : "escalateAfterMs" in rule.config ? (
                    <span className="small text-muted text-wrap">
                      {rule.config.escalateAfterMs === null
                        ? "no escalation"
                        : `→ ${rule.config.escalatedSeverity} after ${formatNumber(/** @type {number} */ (rule.config.escalateAfterMs) / 1000, 0)} s`}
                    </span>
                  ) : "votes" in rule.config ? (
                    <div className="d-flex gap-1 align-items-start flex-wrap">
                      <span className="small text-muted text-wrap" style={{ minWidth: "4rem" }}>
                        {String(rule.config.label)} ≥
                      </span>
                      <CommitNumberInput
                        key={`${rule.type}-minScore-${rule.config.minScore}`}
                        id={`rule-${rule.type}-minScore`}
                        ariaLabel={`${rule.type} minimum score`}
                        value={/** @type {number} */ (rule.config.minScore)}
                        min={0}
                        max={1}
                        step={0.05}
                        onCommit={(value) =>
                          controller.updateViolationRule(rule.type, { minScore: value })
                        }
                      />
                      <CommitNumberInput
                        key={`${rule.type}-votes-${rule.config.votes}`}
                        id={`rule-${rule.type}-votes`}
                        ariaLabel={`${rule.type} samples that must reach the score`}
                        value={/** @type {number} */ (rule.config.votes)}
                        min={1}
                        max={/** @type {number} */ (rule.config.window)}
                        step={1}
                        onCommit={(value) =>
                          controller.updateViolationRule(rule.type, { votes: value })
                        }
                      />
                      <span className="small text-muted">of</span>
                      <CommitNumberInput
                        key={`${rule.type}-window-${rule.config.window}`}
                        id={`rule-${rule.type}-window`}
                        ariaLabel={`${rule.type} samples in the window`}
                        value={/** @type {number} */ (rule.config.window)}
                        min={/** @type {number} */ (rule.config.votes)}
                        max={20}
                        step={1}
                        onCommit={(value) =>
                          controller.updateViolationRule(rule.type, { window: value })
                        }
                      />
                    </div>
                  ) : "similarityThreshold" in rule.config ? (
                    <CommitNumberInput
                      key={`${rule.type}-threshold-${rule.config.similarityThreshold}`}
                      id={`rule-${rule.type}-similarityThreshold`}
                      ariaLabel={`${rule.type} similarity threshold`}
                      value={/** @type {number} */ (rule.config.similarityThreshold)}
                      min={-1}
                      max={1}
                      step={0.01}
                      onCommit={(value) =>
                        controller.updateViolationRule(rule.type, { similarityThreshold: value })
                      }
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ minWidth: "7rem" }}>
                  <Form.Select
                    size="sm"
                    aria-label={`${rule.type} severity`}
                    value={rule.config.severity}
                    onChange={(event) => update(rule.type, { severity: event.target.value })}
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </Form.Select>
                </td>
                <td data-testid={`rule-${rule.type}-count`}>
                  {rule.stats.violations}
                  <div className="small text-muted">{rule.condition.suppressedShort} short</div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        {error && (
          <Alert variant="warning" className="small py-1 m-2 text-break">
            {error}
          </Alert>
        )}
        <div className="px-2 pt-2 small fw-semibold">History (latest {HISTORY_ROWS})</div>
        <Table
          size="sm"
          responsive
          striped
          className="metric-table mb-0"
          data-testid="violation-history"
        >
          <thead>
            <tr>
              <th>Type</th>
              <th>Severity</th>
              <th>Started</th>
              <th>Duration</th>
              <th title="Frames on which the condition held">Frames</th>
              <th title="Highest face count; FACE_MISMATCH: lowest similarity to the reference; GAZE_AWAY, HEAD_TURNED: largest angle beyond the tolerated area and its direction; EYES_CLOSED: highest blink score; PHONE_DETECTED: highest score of the label">
                Measure
              </th>
              <th>Status</th>
              <th title="The page was hidden during the violation; few or no frames arrive then">
                Page hidden
              </th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 && (
              <tr>
                <td colSpan={8} className="text-muted small">
                  No violations in this session.
                </td>
              </tr>
            )}
            {history.map((violation) => (
              <tr
                key={violation.id}
                className={violation.status === "active" ? "table-danger" : undefined}
              >
                <td>{violation.type}</td>
                <td>
                  <Badge bg={SEVERITY_VARIANTS[violation.severity]}>{violation.severity}</Badge>
                  {violation.escalatedAt !== null && violation.escalatedAt !== undefined && (
                    <div className="small text-muted">from {violation.initialSeverity}</div>
                  )}
                </td>
                <td className="font-monospace">{formatClock(violation.startedAt)}</td>
                <td>{seconds(violation.durationMs)}</td>
                <td>{violation.frames}</td>
                <td>
                  {describeMeasure(violation)}
                  {imageNote(violation) && (
                    <div className="small text-warning-emphasis">{imageNote(violation)}</div>
                  )}
                </td>
                <td>
                  {violation.status === "active" ? "active" : `ended (${violation.endReason})`}
                </td>
                <td>{violation.pageHidden ? "yes" : ""}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
      <SnapshotsModal
        show={snapshotView !== null}
        selectedId={snapshotView?.id ?? null}
        onSelect={(id) => setSnapshotView({ id })}
        onHide={() => setSnapshotView(null)}
      />
    </Card>
  );
}
