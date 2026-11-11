import Card from "react-bootstrap/Card";
import { formatClock } from "./format.js";

const LEVEL_CLASS = {
  info: "text-body-secondary",
  warn: "text-warning-emphasis",
  error: "text-danger",
};

/** @param {{ entries: import('../../app/LabController.js').LogEntry[] }} props */
export function EventLog({ entries }) {
  const recent = entries.slice(-100).reverse();
  return (
    <Card className="mb-3">
      <Card.Header className="py-2">Event log</Card.Header>
      <Card.Body className="event-log py-2" data-testid="event-log">
        {recent.length === 0 && <div className="text-muted small">No events yet.</div>}
        {recent.map((entry, index) => (
          <div key={`${entry.at}-${index}`} className={LEVEL_CLASS[entry.level]}>
            <span className="font-monospace">{formatClock(entry.at)}</span>{" "}
            <strong>[{entry.source}]</strong> {entry.message}
          </div>
        ))}
      </Card.Body>
    </Card>
  );
}
