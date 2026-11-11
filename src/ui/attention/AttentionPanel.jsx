import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Col from "react-bootstrap/Col";
import Form from "react-bootstrap/Form";
import Row from "react-bootstrap/Row";
import Table from "react-bootstrap/Table";
import { ATTENTION_PRESET_VALUES } from "../../attention/presets.js";
import { describeError } from "../../utils/errors.js";
import { CommitNumberInput } from "../common/CommitNumberInput.jsx";
import { formatInteger, formatNumber } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { GazePlot } from "./GazePlot.jsx";

const STATE_VARIANTS = {
  on: "success",
  ok: "success",
  open: "success",
  away: "danger",
  turned: "danger",
  closed: "warning",
  undecided: "secondary",
};

/** @param {number | null | undefined} value */
const deg = (value) => (value === null || value === undefined ? "—" : `${formatNumber(value, 1)}°`);

/**
 * Attention: the person's baseline (calibration or learned), strictness preset, live gaze,
 * head, and eye state with the measured angles, and the tolerances.
 */
export function AttentionPanel() {
  const controller = useLabController();
  const { attention, detection } = useLabSnapshot();
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const { config, profile, last, learning, calibration, stats } = attention;

  /** @param {() => unknown} action */
  const run = async (action) => {
    try {
      await action();
      setError(null);
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  const calibrate = () =>
    run(async () => {
      // Full screen makes the measured area the whole screen; the calibration works without.
      let fullscreen = false;
      try {
        await document.documentElement.requestFullscreen();
        fullscreen = true;
      } catch {
        // Not allowed or not supported: calibrate the window instead (reported as a warning).
      }
      controller.startAttentionCalibration({
        width: window.innerWidth,
        height: window.innerHeight,
        fullscreen,
      });
    });

  const baselineBadge = profile ? (
    profile.source === "calibration" ? (
      <Badge bg="success">calibrated</Badge>
    ) : (
      <Badge
        bg="info"
        text="dark"
        title="Learned from the first seconds; screen size is the default"
      >
        learned baseline
      </Badge>
    )
  ) : detection.running ? (
    <Badge bg="secondary">
      learning {learning ? `${learning.samples}/${learning.minSamples} frames` : ""}
    </Badge>
  ) : (
    <Badge bg="secondary">no baseline</Badge>
  );

  const preset = config.preset;
  const presetInfo =
    preset === "custom"
      ? "Values edited by hand; choose a preset to reset them."
      : ATTENTION_PRESET_VALUES[/** @type {'balanced'} */ (preset)].description;

  /**
   * @param {string} id
   * @param {string} label
   * @param {number} value
   * @param {(value: number) => Record<string, unknown>} patch
   * @param {{ min?: number, max?: number, step?: number }} [limits]
   */
  const numberField = (id, label, value, patch, limits = {}) => (
    <Col xs={6} md={4} key={id}>
      <CommitNumberInput
        key={`${id}-${value}`}
        id={`attention-${id}`}
        label={label}
        value={value}
        min={limits.min ?? 0}
        max={limits.max}
        step={limits.step ?? 0.5}
        onCommit={(next) => controller.updateAttentionConfig(patch(next))}
      />
    </Col>
  );

  return (
    <Card className="mb-3" data-testid="attention-panel">
      <Card.Header className="py-2 d-flex align-items-center gap-2 flex-wrap">
        Attention
        <span className="small text-muted">head pose, gaze, eyes · {attention.sourceEngineId}</span>
        <span className="ms-auto">{baselineBadge}</span>
      </Card.Header>
      <Card.Body className="small">
        <div className="d-flex flex-wrap gap-2 align-items-end mb-2">
          <Form.Group controlId="attention-preset">
            <Form.Label className="small mb-0">Strictness</Form.Label>
            <Form.Select
              size="sm"
              value={preset}
              onChange={(event) =>
                event.target.value !== "custom" &&
                run(() =>
                  controller.applyAttentionPreset(/** @type {'balanced'} */ (event.target.value)),
                )
              }
            >
              <option value="lenient">Lenient</option>
              <option value="balanced">Balanced (default)</option>
              <option value="strict">Strict</option>
              <option value="custom" disabled>
                Custom
              </option>
            </Form.Select>
          </Form.Group>
          <Button
            size="sm"
            onClick={calibrate}
            disabled={!detection.running || calibration.status === "running"}
            data-testid="attention-calibrate"
          >
            Calibrate gaze
          </Button>
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => run(() => controller.resetAttentionBaseline())}
            disabled={!profile}
          >
            Reset baseline
          </Button>
        </div>
        <div className="text-muted mb-2">{presetInfo}</div>
        {!detection.running && (
          <div className="text-muted mb-2">
            Start detection, then calibrate: the person looks at a dot at the centre and the four
            corners (about 15 s). Without a calibration, a baseline is learned from the first{" "}
            {config.baseline.learnMs / 1000} s with a default screen size.
          </div>
        )}
        {(calibration.status === "failed" || calibration.status === "cancelled") && (
          <Alert
            variant="warning"
            className="py-1 small"
            data-testid="attention-calibration-message"
          >
            {calibration.message}
          </Alert>
        )}
        {calibration.status === "done" && calibration.warnings.length > 0 && (
          <Alert variant="info" className="py-1 small">
            {calibration.warnings.join(" ")}
          </Alert>
        )}
        {error && (
          <Alert variant="warning" className="py-1 small text-break">
            {error}
          </Alert>
        )}

        <Row className="g-2">
          <Col md={5}>
            <GazePlot
              screen={profile?.screen ?? null}
              limits={attention.limits}
              trail={attention.trail}
            />
          </Col>
          <Col md={7}>
            <Table size="sm" className="metric-table mb-1" data-testid="attention-live">
              <thead>
                <tr>
                  <th />
                  <th>State</th>
                  <th title="Relative to the baseline; right and up positive">Yaw / pitch</th>
                  <th title="Degrees beyond the tolerated area (negative: inside)">Beyond</th>
                </tr>
              </thead>
              <tbody>
                <tr data-testid="attention-gaze">
                  <td>Gaze</td>
                  <td>
                    <StateBadge state={last?.gaze.state} reason={last?.gaze.reason} />
                  </td>
                  <td>
                    {deg(last?.gaze.yawDeg)} / {deg(last?.gaze.pitchDeg)}
                  </td>
                  <td>
                    {deg(last?.gaze.excessDeg)}
                    {last?.gaze.direction ? ` ${last.gaze.direction}` : ""}
                  </td>
                </tr>
                <tr data-testid="attention-head">
                  <td>Head</td>
                  <td>
                    <StateBadge state={last?.head.state} reason={last?.head.reason} />
                  </td>
                  <td>
                    {deg(last?.head.yawDeg)} / {deg(last?.head.pitchDeg)}
                  </td>
                  <td>
                    {deg(last?.head.excessDeg)}
                    {last?.head.direction ? ` ${last.head.direction}` : ""}
                  </td>
                </tr>
                <tr data-testid="attention-eyes">
                  <td>Eyes</td>
                  <td>
                    <StateBadge state={last?.eyes.state} reason={last?.eyes.reason} />
                  </td>
                  <td colSpan={2}>
                    blink {formatNumber(last?.eyes.closure, 2)} · EAR{" "}
                    {last?.eyes.earRatio === null || last?.eyes.earRatio === undefined
                      ? "—"
                      : `${formatNumber(last.eyes.earRatio * 100, 0)}% of open`}
                  </td>
                </tr>
              </tbody>
            </Table>
            <div className="text-muted">
              {formatInteger(stats.frames)} frames: {formatInteger(stats.gaze.on)} on screen,{" "}
              {formatInteger(stats.gaze.away)} away, {formatInteger(stats.gaze.undecided)} undecided
              · {stats.blinks} blinks seen (at 5 FPS most blinks fall between frames) ·{" "}
              {stats.longClosures} longer closures
            </div>
            {profile && (
              <div className="mt-1" data-testid="attention-profile">
                Screen from centre: {deg(profile.screen.leftDeg)} left,{" "}
                {deg(profile.screen.rightDeg)} right, {deg(profile.screen.upDeg)} up,{" "}
                {deg(profile.screen.downDeg)} down
                {profile.source === "learned" ? " (default size)" : ""} · gaze centre{" "}
                {deg(profile.gazeCenter.yawDeg)} / {deg(profile.gazeCenter.pitchDeg)} · head{" "}
                {deg(profile.headCenter.yawDeg)} / {deg(profile.headCenter.pitchDeg)}
              </div>
            )}
          </Col>
        </Row>

        <details className="mt-2">
          <summary>Tolerances</summary>
          <Row className="g-2 mt-1">
            {numberField("margin", "Margin around screen (°)", config.marginDeg, (value) => ({
              marginDeg: value,
            }))}
            {numberField(
              "extra-down",
              "Extra margin below (°)",
              config.extraDownMarginDeg,
              (value) => ({ extraDownMarginDeg: value }),
            )}
            {numberField("return", "Return hysteresis (°)", config.returnMarginDeg, (value) => ({
              returnMarginDeg: value,
            }))}
            {numberField(
              "head-yaw",
              "Head turn limit (°)",
              config.head.maxYawDeg,
              (value) => ({
                head: { maxYawDeg: value },
              }),
              { min: 1 },
            )}
            {numberField(
              "head-up",
              "Head up limit (°)",
              config.head.maxPitchUpDeg,
              (value) => ({
                head: { maxPitchUpDeg: value },
              }),
              { min: 1 },
            )}
            {numberField(
              "head-down",
              "Head down limit (°)",
              config.head.maxPitchDownDeg,
              (value) => ({ head: { maxPitchDownDeg: value } }),
              { min: 1 },
            )}
            {numberField(
              "closed-blink",
              "Closed: blink score ≥",
              config.eyes.closedBlinkScore,
              (value) => ({ eyes: { closedBlinkScore: value } }),
              { max: 1, step: 0.05 },
            )}
            {numberField(
              "closed-ear",
              "Closed: EAR ≤ open ×",
              config.eyes.closedEarRatio,
              (value) => ({ eyes: { closedEarRatio: value } }),
              { max: 1, step: 0.05 },
            )}
          </Row>
          <div className="text-muted mt-1">
            Rule durations and counts are in the Violations panel. Any change here or there makes
            the strictness "custom".
          </div>
        </details>
      </Card.Body>
    </Card>
  );
}

/** @param {{ state: string | undefined, reason: string | null | undefined }} props */
function StateBadge({ state, reason }) {
  if (!state) return <span className="text-muted">—</span>;
  return (
    <>
      <Badge bg={STATE_VARIANTS[/** @type {keyof typeof STATE_VARIANTS} */ (state)] ?? "secondary"}>
        {state}
      </Badge>
      {reason && <span className="text-muted ms-1">{reason}</span>}
    </>
  );
}
