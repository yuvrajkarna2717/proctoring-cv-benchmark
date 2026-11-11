/**
 * Small SVG charts for similarity scores. Similarity is cosine similarity in [-1, 1]; the
 * dashed line is the FACE_MISMATCH threshold.
 */

const WIDTH = 320;
const HEIGHT = 90;
const PAD = 4;

/** @param {number} similarity */
const yOf = (similarity, top = PAD, height = HEIGHT - 2 * PAD) =>
  top + ((1 - Math.max(-1, Math.min(1, similarity))) / 2) * height;

/**
 * Recent comparisons over time; gaps where frames were not compared.
 *
 * @param {{ recent: Array<{ at: number, similarity: number | null }>, threshold: number }} props
 */
export function SimilaritySparkline({ recent, threshold }) {
  if (recent.length === 0) {
    return <div className="small text-muted">No frames compared yet.</div>;
  }
  const first = recent[0].at;
  const span = Math.max(1, recent[recent.length - 1].at - first);
  const xOf = (/** @type {number} */ at) => PAD + ((at - first) / span) * (WIDTH - 2 * PAD);
  /** @type {string[]} */
  const segments = [];
  let current = "";
  for (const point of recent) {
    if (point.similarity === null) {
      if (current) segments.push(current);
      current = "";
      continue;
    }
    current += `${current ? "L" : "M"}${xOf(point.at).toFixed(1)},${yOf(point.similarity).toFixed(1)}`;
  }
  if (current) segments.push(current);
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-100 border rounded bg-body-tertiary"
      role="img"
      aria-label="Similarity to the reference over time"
      data-testid="similarity-sparkline"
    >
      <line x1={0} x2={WIDTH} y1={yOf(0)} y2={yOf(0)} stroke="currentColor" strokeOpacity="0.15" />
      <line
        x1={0}
        x2={WIDTH}
        y1={yOf(threshold)}
        y2={yOf(threshold)}
        stroke="#dc3545"
        strokeDasharray="4 3"
      />
      {segments.map((d, index) => (
        <path key={index} d={d} fill="none" stroke="#0d6efd" strokeWidth="1.5" />
      ))}
      {recent
        .filter((point) => point.similarity !== null)
        .map((point, index) => (
          <circle
            key={index}
            cx={xOf(point.at)}
            cy={yOf(/** @type {number} */ (point.similarity))}
            r="1.6"
            fill={/** @type {number} */ (point.similarity) < threshold ? "#dc3545" : "#0d6efd"}
          />
        ))}
      <text x={WIDTH - PAD} y={yOf(threshold) - 3} fontSize="9" textAnchor="end" fill="#dc3545">
        threshold {threshold}
      </text>
      <text x={PAD} y={10} fontSize="9" fill="currentColor" opacity="0.6">
        1
      </text>
      <text x={PAD} y={HEIGHT - 2} fontSize="9" fill="currentColor" opacity="0.6">
        −1
      </text>
    </svg>
  );
}

/**
 * Genuine and impostor score histograms, each normalized to its own maximum.
 *
 * @param {{ histogram: { start: number, binWidth: number, genuine: number[], impostor: number[] },
 *   threshold: number }} props
 */
export function ScoreHistogram({ histogram, threshold }) {
  const bins = histogram.genuine.length;
  const width = WIDTH;
  const height = 110;
  const bottom = height - 14;
  const barWidth = (width - 2 * PAD) / bins;
  const xOf = (/** @type {number} */ score) =>
    PAD + ((score - histogram.start) / (histogram.binWidth * bins)) * (width - 2 * PAD);
  const maxGenuine = Math.max(1, ...histogram.genuine);
  const maxImpostor = Math.max(1, ...histogram.impostor);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-100 border rounded bg-body-tertiary"
      role="img"
      aria-label="Histogram of genuine and impostor similarity scores"
      data-testid="score-histogram"
    >
      {histogram.impostor.map((count, index) => (
        <rect
          key={`i${index}`}
          x={PAD + index * barWidth}
          width={barWidth - 0.5}
          y={bottom - (count / maxImpostor) * (bottom - PAD)}
          height={(count / maxImpostor) * (bottom - PAD)}
          fill="#dc3545"
          fillOpacity="0.45"
        />
      ))}
      {histogram.genuine.map((count, index) => (
        <rect
          key={`g${index}`}
          x={PAD + index * barWidth}
          width={barWidth - 0.5}
          y={bottom - (count / maxGenuine) * (bottom - PAD)}
          height={(count / maxGenuine) * (bottom - PAD)}
          fill="#198754"
          fillOpacity="0.45"
        />
      ))}
      <line
        x1={xOf(threshold)}
        x2={xOf(threshold)}
        y1={PAD}
        y2={bottom}
        stroke="#212529"
        strokeDasharray="4 3"
      />
      {[-1, -0.5, 0, 0.5, 1].map((tick) => (
        <text
          key={tick}
          x={xOf(tick)}
          y={height - 3}
          fontSize="9"
          textAnchor="middle"
          fill="currentColor"
          opacity="0.7"
        >
          {tick}
        </text>
      ))}
      <text x={width - PAD} y={12} fontSize="9" textAnchor="end" fill="#198754">
        genuine
      </text>
      <text x={width - PAD} y={23} fontSize="9" textAnchor="end" fill="#dc3545">
        impostor
      </text>
    </svg>
  );
}

/**
 * ROC curve: true accept rate against false accept rate, with the point at the threshold.
 *
 * @param {{ roc: Array<{ far: number, tar: number }>, at: { far: number | null, frr: number | null } }} props
 */
export function RocCurve({ roc, at }) {
  const size = 150;
  const pad = 18;
  const xOf = (/** @type {number} */ far) => pad + far * (size - pad - 4);
  const yOf = (/** @type {number} */ tar) => size - pad - tar * (size - pad - 4);
  const d = roc
    .map((p, i) => `${i ? "L" : "M"}${xOf(p.far).toFixed(1)},${yOf(p.tar).toFixed(1)}`)
    .join("");
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      style={{ maxWidth: 220 }}
      className="w-100 border rounded bg-body-tertiary"
      role="img"
      aria-label="ROC curve"
      data-testid="roc-curve"
    >
      <rect
        x={xOf(0)}
        y={yOf(1)}
        width={xOf(1) - xOf(0)}
        height={yOf(0) - yOf(1)}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
      />
      <line
        x1={xOf(0)}
        y1={yOf(0)}
        x2={xOf(1)}
        y2={yOf(1)}
        stroke="currentColor"
        strokeOpacity="0.15"
        strokeDasharray="3 3"
      />
      <path d={d} fill="none" stroke="#0d6efd" strokeWidth="1.5" />
      {at.far !== null && at.frr !== null && (
        <circle cx={xOf(at.far)} cy={yOf(1 - at.frr)} r="3" fill="#dc3545" />
      )}
      <text
        x={size / 2}
        y={size - 3}
        fontSize="9"
        textAnchor="middle"
        fill="currentColor"
        opacity="0.7"
      >
        false accept rate
      </text>
      <text
        x={8}
        y={size / 2}
        fontSize="9"
        textAnchor="middle"
        fill="currentColor"
        opacity="0.7"
        transform={`rotate(-90 8 ${size / 2})`}
      >
        true accept rate
      </text>
    </svg>
  );
}
