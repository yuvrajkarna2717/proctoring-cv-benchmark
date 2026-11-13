import { Fragment, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";
import { describeError } from "../../utils/errors.js";
import { ConfirmButton } from "../common/ConfirmButton.jsx";
import { formatRetention } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { describeViolation, formatLength, formatTime } from "../violations/violationText.js";
import { SnapshotThumb } from "./SnapshotThumb.jsx";
import { useSnapshotUrl } from "./useSnapshotUrl.js";

/**
 * @typedef {import('../../snapshots/SnapshotStore.js').SnapshotMeta} SnapshotMeta
 */

/**
 * The violation snapshots stored in this browser: all of them (this and earlier page sessions,
 * newest first), or one large with its details. The parent decides which; `selectedId` null
 * shows all, and an id that no longer exists (deleted, expired) does too.
 *
 * @param {{ show: boolean, selectedId: string | null, onSelect: (id: string | null) => void,
 *   onHide: () => void }} props
 */
export function SnapshotsModal({ show, selectedId, onSelect, onHide }) {
  const controller = useLabController();
  const { snapshots, violations } = useLabSnapshot();
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const labels = new Map(violations.rules.map((rule) => [rule.type, rule.label]));
  const selected = snapshots.items.find((item) => item.id === selectedId) ?? null;
  const retention = formatRetention(snapshots.maxAgeMs);

  /** @param {() => Promise<unknown>} action */
  const run = async (action) => {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  return (
    <Modal show={show} onHide={onHide} size="lg" centered scrollable data-testid="snapshots-modal">
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="fs-5">
          {selected
            ? describeViolation(selected.violation, labels.get(selected.type)).title
            : `Violation snapshots (${snapshots.count})`}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {selected ? (
          <SnapshotDetail
            item={selected}
            current={selected.sessionId === snapshots.sessionId}
            ruleLabel={labels.get(selected.type)}
          />
        ) : snapshots.items.length === 0 ? (
          <p className="text-muted mb-0">
            No snapshots. When a violation starts, the camera image is saved here with its details
            and kept for {retention}.
          </p>
        ) : (
          <>
            <p className="small text-muted">
              Saved in this browser when each violation started, kept for {retention}, newest first.
              Nothing is uploaded.
            </p>
            <ul className="snapshot-grid">
              {snapshots.items.map((item) => {
                const { title } = describeViolation(item.violation, labels.get(item.type));
                return (
                  <li
                    key={item.id}
                    className="snapshot-card"
                    data-violation={item.type}
                    data-testid="snapshot-card"
                  >
                    <SnapshotThumb
                      id={item.id}
                      label={`Open the snapshot of ${title} at ${formatTime(item.capturedAt)}`}
                      onOpen={() => onSelect(item.id)}
                    />
                    <div className="snapshot-card-title">{title}</div>
                    <div className="snapshot-card-meta">
                      {formatTime(item.capturedAt)}
                      {item.sessionId === snapshots.sessionId ? "" : " · earlier session"}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {snapshots.storage.error && (
          <Alert variant="danger" className="small py-2 mt-3 mb-0">
            {snapshots.storage.error}
          </Alert>
        )}
        {error && (
          <Alert variant="warning" className="small py-2 mt-3 mb-0 text-break">
            {error}
          </Alert>
        )}
      </Modal.Body>
      <Modal.Footer>
        {selected ? (
          <>
            <Button
              size="sm"
              variant="outline-secondary"
              className="me-auto"
              onClick={() => onSelect(null)}
            >
              All snapshots
            </Button>
            <ConfirmButton
              label="Delete"
              confirmLabel="Click again to delete"
              onConfirm={() =>
                run(async () => {
                  await controller.deleteSnapshot(selected.id);
                  onSelect(null);
                })
              }
            />
          </>
        ) : (
          snapshots.count > 0 && (
            <ConfirmButton
              label="Delete all"
              confirmLabel="Click again to delete all"
              onConfirm={() => run(() => controller.deleteAllSnapshots())}
            />
          )
        )}
        <Button size="sm" onClick={onHide}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * One snapshot: the image and the violation's details.
 *
 * @param {{ item: SnapshotMeta, current: boolean, ruleLabel: string | undefined }} props
 *   current: taken in this page session
 */
function SnapshotDetail({ item, current, ruleLabel }) {
  const url = useSnapshotUrl(item.id, "image");
  const violation = item.violation;
  const { title, detail } = describeViolation(violation, ruleLabel);
  const severity =
    violation.initialSeverity && violation.initialSeverity !== violation.severity
      ? `${violation.severity} (raised from ${violation.initialSeverity})`
      : violation.severity;
  const duration =
    violation.status === "ended"
      ? `lasted ${formatLength(violation.durationMs)}, ended: ${violation.endReason}`
      : current
        ? `still going on, ${formatLength(violation.durationMs)} so far`
        : "no end recorded (the page was closed during it)";
  /** @type {Array<[string, string]>} */
  const rows = [
    ["Severity", severity],
    ["Detail", detail || "—"],
    ["Started", formatDateTime(violation.startedAt)],
    [
      "Confirmed",
      `${formatTime(violation.confirmedAt)}, after ${formatLength(violation.confirmedAt - violation.startedAt)}`,
    ],
    ["Duration", duration],
    ["Snapshot taken", formatTime(item.capturedAt)],
    ["Kept until", formatTime(item.expiresAt)],
    ["Source engine", violation.sourceEngineId],
    [
      "Camera",
      item.camera ? `${item.camera.label} · ${item.camera.width}×${item.camera.height}` : "—",
    ],
    [
      "Image",
      `${item.image.width}×${item.image.height} JPEG, ${Math.max(1, Math.round(item.image.bytes / 1024))} KB, as the camera sees it (not mirrored)`,
    ],
    ["Session", current ? "this page session" : "an earlier page session"],
    ["Violation id", violation.id],
  ];
  return (
    <div className="snapshot-detail" data-violation={item.type} data-testid="snapshot-detail">
      <div className="snapshot-image">
        {url ? (
          <img src={url} alt={`Camera image when ${title} started`} />
        ) : (
          <span className="small text-secondary">Loading…</span>
        )}
      </div>
      <dl className="snapshot-meta">
        {rows.map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** e.g. "12 Nov 2026, 16:01:22". @param {number} epochMs */
function formatDateTime(epochMs) {
  const date = new Date(epochMs).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${date}, ${formatTime(epochMs)}`;
}
