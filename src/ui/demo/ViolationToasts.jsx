import { useEffect, useState } from "react";
import CloseButton from "react-bootstrap/CloseButton";
import Toast from "react-bootstrap/Toast";
import ToastContainer from "react-bootstrap/ToastContainer";
import { useLabController } from "../common/labContext.js";
import { describeViolation, formatTime } from "./violationText.js";

/** Toasts shown at once; app.css sizes the video to leave room for three. Older ones fade out. */
const MAX_VISIBLE = 3;
/** How long a toast stays before it fades out. */
const HIDE_AFTER_MS = 6000;

/**
 * @typedef {import('../../pipeline/ViolationEngine.js').Violation} Violation
 * @typedef {{ id: string, type: string, severity: string, time: string, title: string,
 *   detail: string, show: boolean }} ToastItem
 */

/**
 * One toast per confirmed violation, newest first, in a light colour per violation type (see
 * `.violation-toast` in app.css).
 *
 * New violations are found by id in the snapshot history, so a violation that starts and ends
 * between two snapshots still gets its toast. Violations recorded before the component mounted
 * are not announced.
 */
export function ViolationToasts() {
  const controller = useLabController();
  const [toasts, setToasts] = useState(/** @type {ToastItem[]} */ ([]));

  useEffect(() => {
    let known = new Set(controller.getSnapshot().violations.history.map(({ id }) => id));
    return controller.subscribe(() => {
      const { history, rules } = controller.getSnapshot().violations;
      const fresh = history.filter(({ id }) => !known.has(id));
      known = new Set(history.map(({ id }) => id));
      if (fresh.length === 0) return;
      const labels = new Map(rules.map((rule) => [rule.type, rule.label]));
      // The history is oldest first; toasts are newest first.
      const added = fresh
        .map((violation) => toToast(violation, labels.get(violation.type)))
        .reverse();
      setToasts((current) => limitVisible([...added, ...current]));
    });
  }, [controller]);

  /** @param {string} id */
  const hide = (id) =>
    setToasts((current) =>
      current.map((toast) => (toast.id === id ? { ...toast, show: false } : toast)),
    );
  /** @param {string} id */
  const remove = (id) => setToasts((current) => current.filter((toast) => toast.id !== id));

  return (
    <ToastContainer className="violation-toasts" data-testid="violation-toasts">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          show={toast.show}
          autohide
          delay={HIDE_AFTER_MS}
          onClose={() => hide(toast.id)}
          onExited={() => remove(toast.id)}
          className="violation-toast"
          data-violation={toast.type}
          data-testid="violation-toast"
        >
          <div className="violation-toast-content">
            <div className="violation-toast-text">
              <div className="violation-toast-heading">
                <strong>{toast.title}</strong>
                <span className="violation-severity">{toast.severity}</span>
                <span className="violation-toast-time">{toast.time}</span>
              </div>
              {toast.detail && <div className="violation-toast-detail">{toast.detail}</div>}
            </div>
            <CloseButton aria-label="Dismiss" onClick={() => hide(toast.id)} />
          </div>
        </Toast>
      ))}
    </ToastContainer>
  );
}

/**
 * @param {Violation} violation
 * @param {string | undefined} ruleLabel
 * @returns {ToastItem}
 */
function toToast(violation, ruleLabel) {
  return {
    id: violation.id,
    type: violation.type,
    severity: violation.severity,
    time: formatTime(violation.startedAt),
    ...describeViolation(violation, ruleLabel),
    show: true,
  };
}

/**
 * Keeps the newest MAX_VISIBLE toasts showing; older ones fade out and are then removed.
 *
 * @param {ToastItem[]} toasts newest first
 */
function limitVisible(toasts) {
  let showing = 0;
  return toasts.map((toast) => {
    if (!toast.show) return toast;
    showing += 1;
    return showing > MAX_VISIBLE ? { ...toast, show: false } : toast;
  });
}
