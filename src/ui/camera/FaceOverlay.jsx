import { useEffect, useRef } from "react";
import { useLabController } from "../common/labContext.js";

/** Boxes from results older than this are removed, so the overlay never shows stale faces. */
const STALE_AFTER_MS = 1000;
const COLORS = {
  single: "#20c997",
  multiple: "#ffc107",
  landmark: "rgba(255, 255, 255, 0.75)",
  verifier: "#6ea8fe",
};
/** Payload formats the overlay can draw (MediaPipe landmarks, YuNet faces). */
const FORMATS = new Set(["mediapipe-face-landmarks", "face-verifier"]);

/**
 * Draws face boxes and landmarks of the latest result of one face engine over the camera
 * preview: MediaPipe Face Landmarker (solid boxes, 478 points) or the face verifier (dashed blue
 * boxes with the YuNet score, five points).
 *
 * Coordinates arrive normalized to the transferred frame, which keeps the video's aspect ratio,
 * so they map onto the letterboxed video area (`object-fit: contain`). Mirroring is applied to
 * the coordinates instead of the canvas so labels stay readable.
 *
 * @param {{ videoRef: { current: HTMLVideoElement | null }, engineId: string | null,
 *   mirrored: boolean, showLandmarks: boolean }} props
 */
export function FaceOverlay({ videoRef, engineId, mirrored, showLandmarks }) {
  const controller = useLabController();
  const canvasRef = useRef(/** @type {HTMLCanvasElement | null} */ (null));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    /** @type {{ payload: any, receivedAt: number } | null} */
    let latest = null;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height);
      const video = videoRef.current;
      const payload = latest?.payload;
      if (!payload || !FORMATS.has(payload.format) || !video?.videoWidth) return;
      const verifier = payload.format === "face-verifier";

      const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
      const drawWidth = video.videoWidth * scale;
      const drawHeight = video.videoHeight * scale;
      const left = (width - drawWidth) / 2;
      const top = (height - drawHeight) / 2;
      const toX = (/** @type {number} */ x) =>
        mirrored ? width - (left + x * drawWidth) : left + x * drawWidth;
      const toY = (/** @type {number} */ y) => top + y * drawHeight;

      const color = verifier
        ? COLORS.verifier
        : payload.faces.length > 1
          ? COLORS.multiple
          : COLORS.single;
      context.lineWidth = 2 * ratio;
      context.font = `${12 * ratio}px system-ui, sans-serif`;
      context.setLineDash(verifier ? [6 * ratio, 4 * ratio] : []);
      payload.faces.forEach((/** @type {any} */ face, /** @type {number} */ index) => {
        const { box } = face;
        const x1 = toX(box.x);
        const x2 = toX(box.x + box.width);
        const boxLeft = Math.min(x1, x2);
        const boxTop = toY(box.y);
        const boxBottom = boxTop + box.height * drawHeight;
        context.strokeStyle = color;
        context.strokeRect(boxLeft, boxTop, Math.abs(x2 - x1), box.height * drawHeight);
        context.fillStyle = color;
        // Verifier labels go below the box so they do not collide with the landmarker's.
        const label = verifier
          ? `YuNet ${face.score.toFixed(2)}${payload.embedding?.faceIndex === index ? " · embedded" : ""}`
          : `face ${index + 1}${face.truncated ? " (partly out of frame)" : ""}`;
        context.fillText(
          label,
          boxLeft,
          verifier
            ? Math.min(height - 4 * ratio, boxBottom + 14 * ratio)
            : Math.max(12 * ratio, boxTop - 4 * ratio),
        );
        if (showLandmarks && face.landmarks) {
          context.fillStyle = verifier ? COLORS.verifier : COLORS.landmark;
          const size = (verifier ? 4 : 1.5) * ratio;
          const points = face.landmarks;
          // MediaPipe sends x, y, z per landmark; the verifier x, y for its five points.
          const stride = verifier ? 2 : 3;
          for (let i = 0; i < points.length; i += stride) {
            context.fillRect(toX(points[i]) - size / 2, toY(points[i + 1]) - size / 2, size, size);
          }
        }
      });
    };

    const unsubscribe = controller.subscribeResults((notice) => {
      if (notice.engineId !== engineId) return;
      latest = { payload: notice.result.payload, receivedAt: performance.now() };
      draw();
    });
    const staleTimer = setInterval(() => {
      if (latest && performance.now() - latest.receivedAt > STALE_AFTER_MS) {
        latest = null;
        draw();
      }
    }, 250);
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    draw();
    return () => {
      unsubscribe();
      clearInterval(staleTimer);
      resizeObserver.disconnect();
    };
  }, [controller, engineId, mirrored, showLandmarks, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className="video-overlay"
      aria-hidden="true"
      data-testid="face-overlay"
    />
  );
}
