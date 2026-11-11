import { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";

/**
 * Two-step button for actions that cannot be undone: the first click arms it, the second
 * (within 5 s) runs `onConfirm`.
 *
 * @param {{ label: string, confirmLabel?: string, onConfirm: () => unknown, disabled?: boolean,
 *   size?: 'sm' | 'lg', id?: string }} props
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, size = "sm", id }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      id={id}
      size={size}
      variant={armed ? "danger" : "outline-danger"}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        void onConfirm();
      }}
    >
      {armed ? (confirmLabel ?? `${label}: click again to confirm`) : label}
    </Button>
  );
}
