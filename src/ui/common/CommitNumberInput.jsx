import { useState } from "react";
import Form from "react-bootstrap/Form";
import { describeError } from "../../utils/errors.js";

/**
 * Number input that commits on blur or Enter and shows validation errors from `onCommit`.
 * Give it a `key` derived from `value` so it re-initializes when the value changes elsewhere.
 *
 * Without a visible `label` (inputs inside a table whose header names the column), pass
 * `ariaLabel` so the input still has an accessible name.
 *
 * @param {{ id: string, label?: string, ariaLabel?: string, value: number,
 *   onCommit: (value: number) => unknown, min?: number, max?: number, step?: number | 'any',
 *   unit?: string, disabled?: boolean }} props
 */
export function CommitNumberInput({
  id,
  label,
  ariaLabel,
  value,
  onCommit,
  min,
  max,
  step = "any",
  unit,
  disabled,
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  const commit = async () => {
    const parsed = Number(text);
    if (text.trim() === "" || !Number.isFinite(parsed)) {
      setError("Enter a number");
      return;
    }
    if (parsed === value) {
      setError(null);
      return;
    }
    try {
      await onCommit(parsed);
      setError(null);
    } catch (commitError) {
      setError(describeError(commitError));
    }
  };

  return (
    <Form.Group controlId={id}>
      {label && (
        <Form.Label className="small mb-0">
          {label}
          {unit ? ` (${unit})` : ""}
        </Form.Label>
      )}
      <Form.Control
        size="sm"
        type="number"
        aria-label={label ? undefined : ariaLabel}
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        isInvalid={error !== null}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <Form.Control.Feedback type="invalid" className="small text-break">
        {error}
      </Form.Control.Feedback>
    </Form.Group>
  );
}
