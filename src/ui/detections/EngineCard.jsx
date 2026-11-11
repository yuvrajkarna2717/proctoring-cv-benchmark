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
import { useLabController } from "../common/labContext.js";

const STATE_VARIANTS = {
  ready: "success",
  initializing: "info",
  uninitialized: "secondary",
  error: "danger",
  disposed: "secondary",
};

/**
 * Controls for one engine instance: enable (load/unload), scheduler settings, engine settings,
 * restart, and the latest observation.
 *
 * @param {{ engine: ReturnType<import('../../app/LabController.js').LabController['buildSnapshot']>['engines'][number] }} props
 */
export function EngineCard({ engine }) {
  const controller = useLabController();
  const [actionError, setActionError] = useState(/** @type {string | null} */ (null));
  const state = engine.client?.state ?? "not loaded";
  const busy = engine.busyAction !== null;
  const probe = engine.lastResult?.observations.find((o) => o.type === "FRAME_PROBE");
  const faceCount = engine.lastResult?.observations.find((o) => o.type === "FACE_COUNT");
  const faces = engine.lastResult?.observations.filter((o) => o.type === "FACE") ?? [];
  const frameError = engine.client?.lastError ?? engine.metrics?.lastError ?? null;
  const details = /** @type {Record<string, any> | null | undefined} */ (engine.client?.details);
  const blocked = engine.client?.blockedRequests;
  const config = /** @type {Record<string, any>} */ (engine.engineConfig);

  /** @param {() => unknown} action */
  const run = async (action) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(describeError(error));
    }
  };

  return (
    <Card className="mb-3" data-testid={`engine-${engine.id}`}>
      <Card.Header className="py-2 d-flex align-items-center gap-2">
        <Form.Check
          type="switch"
          id={`engine-enabled-${engine.id}`}
          checked={engine.scheduler.enabled}
          disabled={busy}
          onChange={(event) =>
            run(() => controller.setEngineEnabled(engine.id, event.target.checked))
          }
          label={<strong>{engine.label}</strong>}
        />
        <span className="small text-muted">
          {engine.id} · {engine.kind}
        </span>
        <Badge
          bg={STATE_VARIANTS[/** @type {keyof typeof STATE_VARIANTS} */ (state)] ?? "secondary"}
          className="ms-auto"
        >
          {engine.busyAction ?? state}
        </Badge>
      </Card.Header>
      <Card.Body className="py-2">
        {engine.description && <p className="small text-muted mb-2">{engine.description}</p>}
        <Row className="g-2 align-items-end">
          <Col xs={6} md={3}>
            <CommitNumberInput
              key={`fps-${engine.scheduler.targetFps}`}
              id={`${engine.id}-target-fps`}
              label="Target FPS"
              value={engine.scheduler.targetFps}
              min={0.1}
              max={60}
              step={0.5}
              onCommit={(value) => controller.updateScheduler(engine.id, { targetFps: value })}
            />
          </Col>
          <Col xs={6} md={3}>
            <CommitNumberInput
              key={`priority-${engine.scheduler.priority}`}
              id={`${engine.id}-priority`}
              label="Priority"
              value={engine.scheduler.priority}
              min={0}
              max={100}
              step={1}
              onCommit={(value) => controller.updateScheduler(engine.id, { priority: value })}
            />
          </Col>
          <Col xs={6} md={3}>
            <CommitNumberInput
              key={`age-${engine.scheduler.maxFrameAgeMs}`}
              id={`${engine.id}-max-age`}
              label="Max frame age"
              unit="ms"
              value={engine.scheduler.maxFrameAgeMs}
              min={1}
              step={50}
              onCommit={(value) => controller.updateScheduler(engine.id, { maxFrameAgeMs: value })}
            />
          </Col>
          <Col xs={6} md={3}>
            <Form.Check
              type="switch"
              id={`${engine.id}-yield`}
              className="small"
              label="Yield to higher priority"
              checked={engine.scheduler.yieldToHigherPriority}
              onChange={(event) =>
                run(() =>
                  controller.updateScheduler(engine.id, {
                    yieldToHigherPriority: event.target.checked,
                  }),
                )
              }
            />
          </Col>
          {engine.scheduler.yieldToHigherPriority && (
            <Col xs={6} md={3}>
              <CommitNumberInput
                key={`max-yield-${engine.scheduler.maxYieldMs}`}
                id={`${engine.id}-max-yield`}
                label="Max yield"
                unit="ms"
                value={engine.scheduler.maxYieldMs}
                min={0}
                step={50}
                onCommit={(value) => controller.updateScheduler(engine.id, { maxYieldMs: value })}
              />
            </Col>
          )}
          {engine.kind === "diagnostic" && (
            <>
              <Col xs={6} md={3}>
                <CommitNumberInput
                  key={`work-${engine.engineConfig.simulatedWorkMs}`}
                  id={`${engine.id}-work`}
                  label="Simulated work"
                  unit="ms"
                  value={/** @type {number} */ (engine.engineConfig.simulatedWorkMs)}
                  min={0}
                  max={5000}
                  step={10}
                  disabled={busy}
                  onCommit={(value) =>
                    controller.configureEngine(engine.id, { simulatedWorkMs: value })
                  }
                />
              </Col>
              <Col xs={6} md={3}>
                <CommitNumberInput
                  key={`fail-${engine.engineConfig.failEveryN}`}
                  id={`${engine.id}-fail`}
                  label="Fail every N (0 = off)"
                  value={/** @type {number} */ (engine.engineConfig.failEveryN)}
                  min={0}
                  step={1}
                  disabled={busy}
                  onCommit={(value) => controller.configureEngine(engine.id, { failEveryN: value })}
                />
              </Col>
            </>
          )}
          {engine.kind === "face-landmarker" && (
            <>
              <Col xs={6} md={3}>
                <Form.Group controlId={`${engine.id}-delegate`}>
                  <Form.Label className="small mb-0">Delegate</Form.Label>
                  <Form.Select
                    size="sm"
                    value={config.delegate}
                    disabled={busy}
                    onChange={(event) =>
                      run(() =>
                        controller.configureEngine(engine.id, { delegate: event.target.value }),
                      )
                    }
                  >
                    <option value="GPU">GPU (WebGL2)</option>
                    <option value="CPU">CPU (WASM)</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col xs={6} md={3}>
                <CommitNumberInput
                  key={`faces-${config.numFaces}`}
                  id={`${engine.id}-num-faces`}
                  label="Max faces"
                  value={config.numFaces}
                  min={1}
                  max={10}
                  step={1}
                  disabled={busy}
                  onCommit={(value) => controller.configureEngine(engine.id, { numFaces: value })}
                />
              </Col>
              {
                /** @type {const} */ ([
                  ["minFaceDetectionConfidence", "Min detection score"],
                  ["minFacePresenceConfidence", "Min presence score"],
                  ["minTrackingConfidence", "Min tracking score"],
                ]).map(([key, label]) => (
                  <Col xs={6} md={3} key={key}>
                    <CommitNumberInput
                      key={`${key}-${config[key]}`}
                      id={`${engine.id}-${key}`}
                      label={label}
                      value={config[key]}
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={busy}
                      onCommit={(value) => controller.configureEngine(engine.id, { [key]: value })}
                    />
                  </Col>
                ))
              }
            </>
          )}
          {engine.kind === "face-verifier" && (
            <>
              <Col xs={6} md={3}>
                <Form.Group controlId={`${engine.id}-provider`}>
                  <Form.Label className="small mb-0">Execution provider</Form.Label>
                  <Form.Select
                    size="sm"
                    value={config.executionProvider}
                    disabled={busy}
                    onChange={(event) =>
                      run(() =>
                        controller.configureEngine(engine.id, {
                          executionProvider: event.target.value,
                        }),
                      )
                    }
                  >
                    <option value="wasm">WASM (CPU)</option>
                    <option value="webgpu">WebGPU</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col xs={6} md={3}>
                <Form.Group controlId={`${engine.id}-recognizer`}>
                  <Form.Label className="small mb-0">Recognizer</Form.Label>
                  <Form.Select
                    size="sm"
                    value={config.recognizerModel}
                    disabled={busy}
                    title="Embeddings of the two models cannot be compared with each other; re-enroll after a change"
                    onChange={(event) =>
                      run(() =>
                        controller.configureEngine(engine.id, {
                          recognizerModel: event.target.value,
                        }),
                      )
                    }
                  >
                    <option value="ocv-sface-int8bq">SFace int8bq (10.7 MB, default)</option>
                    <option value="ocv-sface">SFace fp32 (38.7 MB)</option>
                    <option value="ocv-sface-int8">SFace int8 (9.9 MB, slow)</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col xs={6} md={3}>
                <CommitNumberInput
                  key={`score-${config.scoreThreshold}`}
                  id={`${engine.id}-score-threshold`}
                  label="Min detector score"
                  value={config.scoreThreshold}
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={busy}
                  onCommit={(value) =>
                    controller.configureEngine(engine.id, { scoreThreshold: value })
                  }
                />
              </Col>
              <Col xs={6} md={3}>
                <CommitNumberInput
                  key={`detector-width-${config.detectorInputWidth}`}
                  id={`${engine.id}-detector-width`}
                  label="Detector width"
                  unit="px"
                  value={config.detectorInputWidth}
                  min={160}
                  max={1920}
                  step={32}
                  disabled={busy}
                  onCommit={(value) =>
                    controller.configureEngine(engine.id, { detectorInputWidth: value })
                  }
                />
              </Col>
              <Col xs={12} md={6}>
                <Form.Check
                  type="switch"
                  id={`${engine.id}-embed-no-face`}
                  className="small"
                  label="Embed a centre crop when no face is found (latency diagnostic; never used for identity)"
                  checked={config.embedWhenNoFace}
                  disabled={busy}
                  onChange={(event) =>
                    run(() =>
                      controller.configureEngine(engine.id, {
                        embedWhenNoFace: event.target.checked,
                      }),
                    )
                  }
                />
              </Col>
            </>
          )}
          <Col xs={12} md={6} className="d-flex gap-2 align-items-center">
            <Button
              size="sm"
              variant="outline-warning"
              disabled={!engine.client || busy}
              onClick={() => run(() => controller.restartEngine(engine.id))}
            >
              Restart worker
            </Button>
            <span className="small text-muted">
              Input:{" "}
              {engine.capture.maxInputWidth
                ? `downscaled to ≤ ${engine.capture.maxInputWidth} px wide`
                : "native resolution"}
            </span>
          </Col>
        </Row>
        {probe && engine.lastResult && (
          <div className="small mt-2 font-monospace" data-testid={`probe-${engine.id}`}>
            FRAME_PROBE #{engine.lastResult.frameId}: mean luma {String(probe.value)} · std{" "}
            {String(probe.metadata?.stdLuma)} · frame {String(probe.metadata?.frameWidth)}×
            {String(probe.metadata?.frameHeight)}
          </div>
        )}
        {details?.delegate && (
          <div className="small mt-2" data-testid={`delegate-${engine.id}`}>
            Running on <strong>{engine.client?.executionProvider}</strong>
            {details.fallbackReason
              ? ` (GPU requested but unavailable: ${details.fallbackReason})`
              : ""}
            {details.lastTaskCreation &&
              ` · last task creation ${Math.round(details.lastTaskCreation.createMs)} ms, warm-up ${
                details.lastTaskCreation.warmupMs === null
                  ? "off"
                  : `${Math.round(details.lastTaskCreation.warmupMs)} ms`
              }`}
          </div>
        )}
        {details?.provider && (
          <div className="small mt-2" data-testid={`provider-${engine.id}`}>
            Running on <strong>{engine.client?.executionProvider}</strong>
            {details.environment?.numThreads
              ? ` · ${details.environment.numThreads} WASM threads`
              : ""}
            {details.fallbackReason
              ? ` (WebGPU requested but unavailable: ${details.fallbackReason})`
              : ""}
            {details.lastSessionCreation &&
              ` · last session creation ${Math.round(details.lastSessionCreation.createMs)} ms, warm-up ${
                details.lastSessionCreation.warmupMs === null
                  ? "off"
                  : `${Math.round(details.lastSessionCreation.warmupMs)} ms`
              }`}
          </div>
        )}
        {faceCount && engine.lastResult && (
          <div className="small mt-1 font-monospace" data-testid={`faces-${engine.id}`}>
            FACE_COUNT #{engine.lastResult.frameId}: {String(faceCount.value)}
            {faces.map((face, index) => {
              const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (
                face.metadata?.box
              );
              return (
                <span key={index}>
                  {" "}
                  · face {index + 1}: {Math.round(box.width * 100)}×{Math.round(box.height * 100)}%
                  at ({box.x.toFixed(2)}, {box.y.toFixed(2)})
                  {face.metadata?.truncated ? " partly out of frame" : ""}
                </span>
              );
            })}
          </div>
        )}
        {blocked && blocked.count > 0 && (
          <div className="small mt-1 text-warning-emphasis" data-testid={`blocked-${engine.id}`}>
            Outbound requests blocked: {blocked.count} (last: {blocked.last?.url})
          </div>
        )}
        {frameError && (
          <Alert variant="danger" className="small py-1 mt-2 mb-0 text-break">
            Last error: {describeError(frameError)}
          </Alert>
        )}
        {actionError && (
          <Alert variant="warning" className="small py-1 mt-2 mb-0 text-break">
            {actionError}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}
