import { useState } from "react";
import Button from "react-bootstrap/Button";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { SnapshotThumb } from "../snapshots/SnapshotThumb.jsx";
import { SnapshotsModal } from "../snapshots/SnapshotsModal.jsx";
import { describeViolation, formatLength, formatTime } from "../violations/violationText.js";

/**
 * The session's violations, newest first: when each started, how long it lasted or that it is
 * still going on, its detail, and its snapshot, in the colour of its toast. Starting the camera
 * begins a new session and empties the log, as in the lab; snapshots stay until they expire.
 */
export function ViolationLog() {
  const controller = useLabController();
  const { violations, snapshots } = useLabSnapshot();
  /** null: closed; id null: all snapshots; otherwise one snapshot */
  const [view, setView] = useState(/** @type {{ id: string | null } | null} */ (null));
  const labels = new Map(violations.rules.map((rule) => [rule.type, rule.label]));
  const entries = [...violations.history].reverse();
  // Violation ids repeat across page sessions; snapshots of this session match by id.
  const snapshotOf = new Map(
    snapshots.items
      .filter((item) => item.sessionId === snapshots.sessionId)
      .map((item) => [item.violationId, item]),
  );

  return (
    <section className="demo-panel violation-log" aria-label="Violation log">
      <div className="demo-panel-heading">
        <h2 className="demo-panel-title">Violation log</h2>
        {entries.length > 0 && <span className="violation-log-count">{entries.length}</span>}
        <span className="ms-auto d-flex gap-3">
          {snapshots.enabled && (
            <Button
              size="sm"
              variant="link"
              className="p-0"
              onClick={() => setView({ id: null })}
              data-testid="open-snapshots"
            >
              Snapshots ({snapshots.count})
            </Button>
          )}
          <Button
            size="sm"
            variant="link"
            className="p-0"
            disabled={entries.length === 0}
            onClick={() => controller.clearViolations()}
          >
            Clear
          </Button>
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="violation-log-empty">No violations yet.</div>
      ) : (
        <ol className="violation-log-list" data-testid="violation-log">
          {entries.map((violation) => {
            const { title, detail } = describeViolation(violation, labels.get(violation.type));
            const length = formatLength(violation.durationMs);
            const snapshot = snapshotOf.get(violation.id);
            return (
              <li
                key={violation.id}
                className="violation-log-entry"
                data-violation={violation.type}
                data-testid="violation-log-entry"
              >
                <div className="violation-log-text">
                  <div className="violation-log-heading">
                    <strong>{title}</strong>
                    <span className="violation-severity">{violation.severity}</span>
                    <time
                      className="violation-log-time"
                      dateTime={new Date(violation.startedAt).toISOString()}
                    >
                      {formatTime(violation.startedAt)}
                    </time>
                  </div>
                  <div className="violation-log-detail">
                    {detail && `${detail} · `}
                    {violation.status === "active" ? (
                      <span className="violation-log-ongoing">ongoing, {length}</span>
                    ) : (
                      `lasted ${length}`
                    )}
                  </div>
                </div>
                {snapshot && (
                  <SnapshotThumb
                    id={snapshot.id}
                    label={`Open the snapshot of ${title} at ${formatTime(violation.startedAt)}`}
                    onOpen={() => setView({ id: snapshot.id })}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
      <SnapshotsModal
        show={view !== null}
        selectedId={view?.id ?? null}
        onSelect={(id) => setView({ id })}
        onHide={() => setView(null)}
      />
    </section>
  );
}
