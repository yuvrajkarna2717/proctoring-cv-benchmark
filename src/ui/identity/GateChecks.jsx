import Table from "react-bootstrap/Table";

/** @param {unknown} value */
function show(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Every check of a quality-gate result with its measured value and limit.
 *
 * @param {{ gate: import('../../identity/qualityGate.js').GateResult | null, testId?: string }} props
 */
export function GateChecks({ gate, testId }) {
  if (!gate) return <div className="small text-muted">No frame evaluated yet.</div>;
  // Without an embedded face nothing else was measured; one line says more than a table of dashes.
  const faceCheck = gate.checks.find((check) => check.id === "face");
  if (faceCheck && !faceCheck.passed) {
    const faces = gate.checks.find((check) => check.id === "singleFace")?.value;
    return (
      <div className="small text-warning-emphasis" data-testid={testId}>
        Last frame: no face detected
        {typeof faces === "number" && faces > 0 ? ` (${faces} faces, none embedded)` : ""}. Move
        into the camera view.
      </div>
    );
  }
  return (
    <Table size="sm" className="metric-table mb-1" data-testid={testId}>
      <thead>
        <tr>
          <th>Check (last frame)</th>
          <th>Measured</th>
          <th>Required</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {gate.checks.map((check) => (
          <tr key={check.id} className={check.passed ? undefined : "table-warning"}>
            <td>{check.label}</td>
            <td>{show(check.value)}</td>
            <td>{check.limit}</td>
            <td>{check.passed ? "✓" : "✗"}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Progress line of an enrollment or calibration capture.
 *
 * @param {{ session: ReturnType<import('../../identity/IdentityManager.js').IdentityManager['getSnapshot']>['enrollment'] }} props
 */
export function SessionProgress({ session }) {
  return (
    <div className="small">
      <strong>{session.status}</strong>: {session.accepted} / {session.required} samples ·{" "}
      {session.framesOffered} frames seen, {session.framesRejected} failed the gate,{" "}
      {session.framesSkipped} skipped (too soon after the previous sample)
      {session.mostFrequentFailure && session.status === "collecting" && (
        <div className="text-warning-emphasis">
          Most frequent failed check: {session.mostFrequentFailure.label} (
          {session.mostFrequentFailure.count} frames)
        </div>
      )}
      {session.failure && <div className="text-danger">{session.failure}</div>}
    </div>
  );
}
