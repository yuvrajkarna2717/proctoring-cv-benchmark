/**
 * Gaze direction relative to the person's screen centre, as the person sees it: right on the
 * chart is to their right, up is up. The solid rectangle is the screen (calibrated or the
 * default size), the dashed one the tolerated area (screen plus margins). Points are recent
 * frames: blue on screen, red away; the last frame is larger.
 */

const SIZE = 240;
const PAD = 6;

const STATE_COLORS = { on: "#0d6efd", away: "#dc3545", undecided: "#adb5bd" };

/**
 * @param {{ screen: import('../../attention/attentionModel.js').ScreenExtent | null,
 *   limits: import('../../attention/attentionModel.js').ScreenExtent | null,
 *   trail: Array<{ yawDeg: number, pitchDeg: number, state: string }> }} props
 */
export function GazePlot({ screen, limits, trail }) {
  const extent = Math.max(
    25,
    ...(limits ? [limits.leftDeg, limits.rightDeg, limits.upDeg, limits.downDeg] : []).map(
      (value) => value + 10,
    ),
  );
  const scale = (SIZE / 2 - PAD) / extent;
  const x = (/** @type {number} */ yaw) => SIZE / 2 + clamp(yaw, extent) * scale;
  const y = (/** @type {number} */ pitch) => SIZE / 2 - clamp(pitch, extent) * scale;
  /** @param {import('../../attention/attentionModel.js').ScreenExtent} box */
  const rect = (box) => ({
    x: x(-box.leftDeg),
    y: y(box.upDeg),
    width: (box.leftDeg + box.rightDeg) * scale,
    height: (box.upDeg + box.downDeg) * scale,
  });
  const last = trail.at(-1);
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="border rounded bg-body-tertiary"
      style={{ width: "100%", maxWidth: SIZE }}
      role="img"
      aria-label="Gaze direction relative to the screen"
      data-testid="gaze-plot"
    >
      <line
        x1={SIZE / 2}
        x2={SIZE / 2}
        y1={0}
        y2={SIZE}
        stroke="currentColor"
        strokeOpacity="0.1"
      />
      <line
        y1={SIZE / 2}
        y2={SIZE / 2}
        x1={0}
        x2={SIZE}
        stroke="currentColor"
        strokeOpacity="0.1"
      />
      {screen && <rect {...rect(screen)} fill="#0d6efd" fillOpacity="0.06" stroke="#0d6efd" />}
      {limits && <rect {...rect(limits)} fill="none" stroke="#dc3545" strokeDasharray="4 3" />}
      {trail.map((point, index) => (
        <circle
          key={index}
          cx={x(point.yawDeg)}
          cy={y(point.pitchDeg)}
          r={point === last ? 4.5 : 1.8}
          fill={STATE_COLORS[/** @type {keyof typeof STATE_COLORS} */ (point.state)] ?? "#6c757d"}
          fillOpacity={point === last ? 1 : 0.5}
        />
      ))}
      <text x={PAD} y={12} fontSize="9" fill="currentColor" opacity="0.6">
        up
      </text>
      <text
        x={SIZE - PAD}
        y={SIZE / 2 - 4}
        fontSize="9"
        textAnchor="end"
        fill="currentColor"
        opacity="0.6"
      >
        their right
      </text>
      <text x={PAD} y={SIZE - 4} fontSize="9" fill="currentColor" opacity="0.6">
        ±{Math.round(extent)}°
      </text>
    </svg>
  );
}

/**
 * @param {number} value
 * @param {number} extent
 */
function clamp(value, extent) {
  return Math.max(-extent, Math.min(extent, value));
}
