import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Table from "react-bootstrap/Table";
import { describeError } from "../../utils/errors.js";
import { formatInteger, formatNumber } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { objectEngineViews } from "./objectEngines.js";

/**
 * Object detectors side by side: what each model saw on its last frame, on how many frames it
 * found the labels the rules watch (at the rules' score limits), its highest score, and its
 * measured latency. One engine feeds PHONE_DETECTED; the others run for
 * comparison only.
 */
export function ObjectsPanel() {
  const controller = useLabController();
  const { engines, objects, violations } = useLabSnapshot();
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const views = objectEngineViews(engines);
  const watched = violations.rules
    .filter((rule) => rule.input === "objects")
    .map((rule) => ({
      type: rule.type,
      label: String(rule.config.label),
      minScore: /** @type {number} */ (rule.config.minScore),
      enabled: rule.config.enabled,
    }));

  /** @param {string} engineId */
  const selectSource = (engineId) => {
    try {
      controller.setObjectSource(engineId);
      setError(null);
    } catch (sourceError) {
      setError(describeError(sourceError));
    }
  };

  return (
    <Card className="mb-3" data-testid="objects-panel">
      <Card.Header className="py-2 d-flex align-items-center gap-2 flex-wrap">
        Object detection
        <span className="small text-muted">
          rules read {objects.sourceEngineId} · counts since detection started
        </span>
      </Card.Header>
      <Card.Body className="p-0">
        <Table size="sm" responsive className="metric-table mb-0" data-testid="objects-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>State</th>
              <th title="Frames with an object result since detection started">Frames</th>
              {watched.map((rule) => (
                <th
                  key={rule.type}
                  title={`Frames whose best "${rule.label}" score reached ${rule.minScore} (the ${rule.type} limit) / highest score`}
                >
                  {rule.label} ≥ {formatNumber(rule.minScore, 2)}
                  {rule.enabled ? "" : " (rule off)"}
                </th>
              ))}
              <th title="Model run in the worker, p50 / p95">Inference ms</th>
              <th title="Engine total in the worker (preprocess, model, postprocess), p50 / p95">
                Engine ms
              </th>
              <th title="Worker creation to ready">Init ms</th>
              <th>Last frame</th>
              <th>Rules</th>
            </tr>
          </thead>
          <tbody>
            {views.map(({ engine, color, name }) => {
              const entry = /** @type {Record<string, any>} */ (objects.engines)[engine.id];
              const latency = engine.metrics?.latency;
              const isSource = engine.id === objects.sourceEngineId;
              const last = /** @type {Array<{ label: string, score: number }>} */ (
                entry?.last?.detections ?? []
              );
              return (
                <tr key={engine.id} data-testid={`objects-row-${engine.id}`}>
                  <td>
                    <span style={{ color }} aria-hidden="true">
                      ■{" "}
                    </span>
                    <strong>{name}</strong>
                    <div className="small text-muted">{engine.id}</div>
                  </td>
                  <td>
                    {engine.scheduler.enabled ? (engine.client?.state ?? "not loaded") : "off"}
                    <div className="small text-muted">{engine.client?.executionProvider ?? ""}</div>
                  </td>
                  <td>{formatInteger(entry?.frames)}</td>
                  {watched.map((rule) => (
                    <td key={rule.type} data-testid={`objects-${engine.id}-${rule.type}`}>
                      {entry ? formatInteger(entry.framesWith[rule.label] ?? 0) : "—"}
                      <div className="small text-muted">
                        max {formatNumber(entry?.maxScore[rule.label], 2)}
                      </div>
                    </td>
                  ))}
                  <td>
                    {formatNumber(latency?.inferenceMs.median, 1)} /{" "}
                    {formatNumber(latency?.inferenceMs.p95, 1)}
                  </td>
                  <td>
                    {formatNumber(latency?.engineMs.median, 1)} /{" "}
                    {formatNumber(latency?.engineMs.p95, 1)}
                  </td>
                  <td>{formatNumber(engine.metrics?.init?.spawnToReadyMs, 0)}</td>
                  <td className="text-wrap small" style={{ minWidth: "9rem" }}>
                    {!entry
                      ? "—"
                      : last.length === 0
                        ? "nothing above the reporting limit"
                        : last
                            .slice(0, 4)
                            .map((d) => `${d.label} ${formatNumber(d.score, 2)}`)
                            .join(", ")}
                  </td>
                  <td>
                    {isSource ? (
                      <Badge bg="primary">source</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline-primary"
                        data-testid={`object-source-${engine.id}`}
                        onClick={() => selectSource(engine.id)}
                      >
                        Use
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {error && (
          <Alert variant="warning" className="small py-1 m-2 text-break">
            {error}
          </Alert>
        )}
        <div className="small text-muted px-2 py-2">
          Scores are model outputs, not probabilities, and are not comparable between models: check
          the rule&apos;s score limit after switching the source. Each enabled model loads its own
          worker; enable the ones you want to compare in their engine cards below.
        </div>
      </Card.Body>
    </Card>
  );
}
