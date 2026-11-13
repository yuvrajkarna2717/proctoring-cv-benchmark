import { useEffect, useRef } from "react";
import { useLabController } from "../common/labContext.js";

/** Object engines run at about 1 FPS; boxes older than this are removed. */
const STALE_AFTER_MS = 2500;

/**
 * Draws the latest `object-detections` payload of one object engine over the camera preview:
 * a box per detection with its label and score, in the engine's colour. Boxes of the labels the
 * rules watch (`highlight`) are drawn thicker.
 *
 * Coordinates are normalized to the frame; they map onto the letterboxed video area
 * (`object-fit: contain`) like the face overlay, with mirroring applied to the coordinates.
 *
 * @param {{ videoRef: { current: HTMLVideoElement | null }, engineId: string, name: string,
 *   color: string, mirrored: boolean, highlight: readonly string[] }} props
 */
export function ObjectOverlay({ videoRef, engineId, name, color, mirrored, highlight }) {
  const controller = useLabController();
  const canvasRef = useRef(/** @type {HTMLCanvasElement | null} */ (null));
  const highlightKey = highlight.join("|");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const watched = new Set(highlightKey.split("|"));
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
      if (payload?.format !== "object-detections" || !video?.videoWidth) return;

      const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
      const drawWidth = video.videoWidth * scale;
      const drawHeight = video.videoHeight * scale;
      const left = (width - drawWidth) / 2;
      const top = (height - drawHeight) / 2;
      const toX = (/** @type {number} */ x) =>
        mirrored ? width - (left + x * drawWidth) : left + x * drawWidth;
      const toY = (/** @type {number} */ y) => top + y * drawHeight;

      context.font = `${12 * ratio}px system-ui, sans-serif`;
      context.setLineDash([]);
      for (const detection of payload.detections) {
        const { box } = detection;
        const x1 = toX(box.x);
        const x2 = toX(box.x + box.width);
        const boxLeft = Math.min(x1, x2);
        const boxTop = toY(box.y);
        context.lineWidth = (watched.has(detection.label) ? 3 : 1.5) * ratio;
        context.strokeStyle = color;
        context.strokeRect(boxLeft, boxTop, Math.abs(x2 - x1), box.height * drawHeight);
        const label = `${name}: ${detection.label} ${detection.score.toFixed(2)}`;
        const textWidth = context.measureText(label).width;
        const textTop = Math.min(height - 16 * ratio, boxTop + 2 * ratio);
        context.fillStyle = "rgba(0, 0, 0, 0.6)";
        context.fillRect(boxLeft + 2 * ratio, textTop, textWidth + 6 * ratio, 15 * ratio);
        context.fillStyle = color;
        context.fillText(label, boxLeft + 5 * ratio, textTop + 12 * ratio);
      }
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
  }, [controller, engineId, name, color, mirrored, highlightKey, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className="video-overlay"
      aria-hidden="true"
      data-testid={`object-overlay-${engineId}`}
    />
  );
}
