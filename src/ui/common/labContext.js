import { createContext, useContext, useSyncExternalStore } from "react";

/** @type {import('react').Context<import('../../app/LabController.js').LabController | null>} */
export const LabControllerContext = createContext(
  /** @type {import('../../app/LabController.js').LabController | null} */ (null),
);

/** @returns {import('../../app/LabController.js').LabController} */
export function useLabController() {
  const controller = useContext(LabControllerContext);
  if (!controller) throw new Error("useLabController() must be used inside LabControllerContext");
  return controller;
}

/** Subscribes the component to the controller snapshot (re-renders on publish). */
export function useLabSnapshot() {
  const controller = useLabController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}
