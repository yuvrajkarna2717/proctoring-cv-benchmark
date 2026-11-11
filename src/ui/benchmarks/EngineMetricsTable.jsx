import Card from "react-bootstrap/Card";
import Table from "react-bootstrap/Table";
import { formatInteger, formatNumber } from "../common/format.js";

const SERIES_LABELS = {
  engineMs: "Engine total (worker)",
  preprocessMs: "Preprocess",
  inferenceMs: "Inference",
  postprocessMs: "Postprocess",
  captureMs: "Capture (createImageBitmap)",
  roundTripMs: "Round trip (dispatch → result)",
  transportMs: "Transport + queueing",
  queueDelayMs: "Dispatch → worker start",
  frameAgeMs: "Frame age at worker start",
  endToEndMs: "Camera capture → result",
};

/** Engine-reported parts of the engine total (`timings.breakdownMs`). */
const BREAKDOWN_LABELS = {
  detectorMs: "Detector model run (YuNet)",
  alignMs: "Alignment crop (canvas warp + readback)",
  recognizerMs: "Recognizer model run (SFace)",
};

/**
 * Measured per-engine performance for the current measurement window. Values without samples
 * are shown as "—"; nothing is estimated.
 *
 * @param {{ engines: ReturnType<import('../../app/LabController.js').LabController['buildSnapshot']>['engines'] }} props
 */
export function EngineMetricsTable({ engines }) {
  return (
    <Card className="mb-3">
      <Card.Header className="py-2">Engine performance (measured)</Card.Header>
      <Card.Body className="p-0">
        <Table
          size="sm"
          responsive
          striped
          className="metric-table mb-0"
          data-testid="metrics-table"
        >
          <thead>
            <tr>
              <th>Engine</th>
              <th>State</th>
              <th>Provider</th>
              <th title="Worker creation to engine ready">Init ms</th>
              <th>Target FPS</th>
              <th title="Results per second over the last FPS window">Eff. FPS</th>
              <th title="Results per second between the first and last result since the last metrics reset">
                Avg FPS
              </th>
              <th title="Engine time in the worker">Mean</th>
              <th>p50</th>
              <th>p95</th>
              <th>p99</th>
              <th title="Camera capture to result on the main thread">E2E p95</th>
              <th>Dispatched</th>
              <th>Results</th>
              <th>Failed</th>
              <th title="Dropped in the worker because the frame was too old">Stale</th>
              <th title="Lost to a restart or unload">Aborted</th>
              <th title="Sampling slots skipped: engine busy / yielded to higher priority">
                Skipped b/y
              </th>
              <th>Restarts</th>
            </tr>
          </thead>
          <tbody>
            {engines.map((engine) => {
              const metrics = engine.metrics;
              const engineMs = metrics?.latency.engineMs;
              return (
                <tr key={engine.id}>
                  <td>{engine.id}</td>
                  <td>{engine.client?.state ?? "not loaded"}</td>
                  <td>{metrics?.executionProvider ?? "—"}</td>
                  <td>{formatNumber(metrics?.init?.spawnToReadyMs)}</td>
                  <td>{formatNumber(engine.scheduler.targetFps, 1)}</td>
                  <td>{formatNumber(metrics?.effectiveFps, 2)}</td>
                  <td>{formatNumber(metrics?.averageFps, 2)}</td>
                  <td>{formatNumber(engineMs?.mean, 2)}</td>
                  <td>{formatNumber(engineMs?.median, 2)}</td>
                  <td>{formatNumber(engineMs?.p95, 2)}</td>
                  <td>{formatNumber(engineMs?.p99, 2)}</td>
                  <td>{formatNumber(metrics?.latency.endToEndMs.p95, 1)}</td>
                  <td>{formatInteger(engine.schedulerCounters.dispatched)}</td>
                  <td>{formatInteger(metrics?.counters.results)}</td>
                  <td>{formatInteger(metrics?.counters.failures)}</td>
                  <td>{formatInteger(metrics?.counters.droppedStale)}</td>
                  <td>{formatInteger(metrics?.counters.droppedAborted)}</td>
                  <td>
                    {formatInteger(engine.schedulerCounters.skippedBusy)} /{" "}
                    {formatInteger(engine.schedulerCounters.skippedYield)}
                  </td>
                  <td>{formatInteger(metrics?.counters.restarts)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {engines.map((engine) =>
          engine.metrics ? (
            <details key={engine.id} className="px-2 py-1 small border-top">
              <summary>
                {engine.id}: latency breakdown ({engine.metrics.samplesInWindow} samples in window)
              </summary>
              <Table size="sm" className="metric-table mb-1">
                <thead>
                  <tr>
                    <th>Series (ms)</th>
                    <th>n</th>
                    <th>Mean</th>
                    <th>p50</th>
                    <th>p95</th>
                    <th>p99</th>
                    <th>Min</th>
                    <th>Max</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...Object.entries(SERIES_LABELS).map(([key, label]) => [
                      key,
                      label,
                      engine.metrics.latency[key],
                    ]),
                    // Parts reported by the engine, e.g. each model of the face verifier.
                    ...Object.entries(engine.metrics.breakdownMs ?? {}).map(([key, summary]) => [
                      `part-${key}`,
                      `↳ ${BREAKDOWN_LABELS[key] ?? key}`,
                      summary,
                    ]),
                  ].map(([key, label, summary]) => {
                    return (
                      <tr key={key}>
                        <td>{label}</td>
                        <td>{summary.count}</td>
                        <td>{formatNumber(summary.mean, 2)}</td>
                        <td>{formatNumber(summary.median, 2)}</td>
                        <td>{formatNumber(summary.p95, 2)}</td>
                        <td>{formatNumber(summary.p99, 2)}</td>
                        <td>{formatNumber(summary.min, 2)}</td>
                        <td>{formatNumber(summary.max, 2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              {engine.metrics.init && (
                <div className="text-muted mb-1">
                  Init breakdown: worker spawn→ready{" "}
                  {formatNumber(engine.metrics.init.spawnToReadyMs)} ms · module load{" "}
                  {formatNumber(engine.metrics.init.moduleLoadMs)} ms · model fetch{" "}
                  {formatNumber(engine.metrics.init.modelFetchMs)} ms · model init{" "}
                  {formatNumber(engine.metrics.init.modelInitMs)} ms · warm-up{" "}
                  {formatNumber(engine.metrics.init.warmupMs)} ms
                </div>
              )}
            </details>
          ) : null,
        )}
      </Card.Body>
    </Card>
  );
}
