import Button from "react-bootstrap/Button";
import { useLabController, useLabSnapshot } from "../common/labContext.js";
import { describeViolation, formatLength, formatTime } from "./violationText.js";

/**
 * The session's violations, newest first: when each started, how long it lasted or that it is
 * still going on, and its detail, in the colour of its toast. Starting the camera begins a new
 * session and empties the log, as in the lab.
 */
export function ViolationLog() {
  const controller = useLabController();
  const { violations } = useLabSnapshot();
  const labels = new Map(violations.rules.map((rule) => [rule.type, rule.label]));
  const entries = [...violations.history].reverse();

  return (
    <section className="demo-panel violation-log" aria-label="Violation log">
      <div className="demo-panel-heading">
        <h2 className="demo-panel-title">Violation log</h2>
        {entries.length > 0 && <span className="violation-log-count">{entries.length}</span>}
        <Button
          size="sm"
          variant="link"
          className="ms-auto p-0"
          disabled={entries.length === 0}
          onClick={() => controller.clearViolations()}
        >
          Clear
        </Button>
      </div>
      {entries.length === 0 ? (
        <div className="violation-log-empty">No violations yet.</div>
      ) : (
        <ol className="violation-log-list" data-testid="violation-log">
          {entries.map((violation) => {
            const { title, detail } = describeViolation(violation, labels.get(violation.type));
            const length = formatLength(violation.durationMs);
            return (
              <li
                key={violation.id}
                className="violation-log-entry"
                data-violation={violation.type}
                data-testid="violation-log-entry"
              >
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
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
