import Badge from "react-bootstrap/Badge";
import Card from "react-bootstrap/Card";
import Col from "react-bootstrap/Col";
import Row from "react-bootstrap/Row";
import Table from "react-bootstrap/Table";
import { CommitNumberInput } from "../common/CommitNumberInput.jsx";
import { formatInteger, formatNumber } from "../common/format.js";
import { useLabController, useLabSnapshot } from "../common/labContext.js";

const STATE_VARIANTS = { ok: "success", issue: "warning", undecided: "secondary" };

/**
 * Image quality: the latest assessment of lighting and image (with reasons), the measured
 * values next to their limits, and the editable limits. Image problems are environment
 * problems; they explain unreliable face results rather than misconduct.
 */
export function ImageQualityPanel() {
  const controller = useLabController();
  const { imageQuality } = useLabSnapshot();
  const { last, config, stats } = imageQuality;
  const { lighting: L, image: I } = config;
  const values = last?.values;

  /**
   * @param {string} id
   * @param {string} label
   * @param {number} value
   * @param {(value: number) => Record<string, unknown>} patch
   * @param {{ min?: number, max?: number, step?: number }} [limits]
   */
  const limitField = (id, label, value, patch, limits = {}) => (
    <Col xs={6} md={4} key={id}>
      <CommitNumberInput
        key={`${id}-${value}`}
        id={`quality-${id}`}
        label={label}
        value={value}
        min={limits.min ?? 0}
        max={limits.max}
        step={limits.step ?? 1}
        onCommit={(next) => controller.updateImageQualityConfig(patch(next))}
      />
    </Col>
  );

  /** @param {number | null | undefined} value @param {number} [digits] */
  const show = (value, digits = 0) => formatNumber(value, digits);

  return (
    <Card className="mb-3" data-testid="image-quality-panel">
      <Card.Header className="py-2 d-flex align-items-center gap-2 flex-wrap">
        Image quality
        <span className="small text-muted">
          {imageQuality.sourceEngineId} · face box from {imageQuality.faceSourceEngineId}
        </span>
      </Card.Header>
      <Card.Body className="small">
        <Table size="sm" className="metric-table mb-2" data-testid="image-quality-live">
          <tbody>
            <tr data-testid="quality-lighting">
              <td>Lighting</td>
              <td>
                <StateBadge part={last?.lighting} />
              </td>
              <td className="text-wrap">
                face {show(values?.faceMeanLuma)} (limits {L.minFaceLuma}–{L.maxFaceLuma}) ·
                background {show(values?.backgroundMeanLuma)} · contrast{" "}
                {show(values?.faceContrast, 1)} (≥ {L.minFaceContrast}) · blown{" "}
                {values?.faceBrightFraction === null || values?.faceBrightFraction === undefined
                  ? "—"
                  : `${formatNumber(values.faceBrightFraction * 100, 0)}%`}{" "}
                · frame {show(values?.frameMeanLuma)}
              </td>
            </tr>
            <tr data-testid="quality-image">
              <td>Image</td>
              <td>
                <StateBadge part={last?.image} />
              </td>
              <td className="text-wrap">
                sharpness {show(values?.faceSharpness, 3)} (≥ {I.minFaceSharpness}) · face{" "}
                {show(values?.faceWidthPx)} px (≥ {I.minFaceWidthPx}),{" "}
                {values?.faceWidthRatio === null || values?.faceWidthRatio === undefined
                  ? "—"
                  : `${formatNumber(values.faceWidthRatio * 100, 0)}%`}{" "}
                of the width · camera {formatInteger(values?.sourceWidth)} px wide
              </td>
            </tr>
          </tbody>
        </Table>
        <div className="text-muted">
          {formatInteger(stats.frames)} frames assessed · lighting issue on{" "}
          {formatInteger(stats.lighting.issue)}, image issue on {formatInteger(stats.image.issue)}
          {Object.keys(stats.reasons).length > 0
            ? ` (${Object.entries(stats.reasons)
                .map(([reason, count]) => `${reason} ${count}`)
                .join(", ")})`
            : ""}
          . Image problems are reported with severity low and noted on other violations that start
          meanwhile.
        </div>
        <details className="mt-2">
          <summary>Limits</summary>
          <Row className="g-2 mt-1">
            {limitField(
              "min-face-luma",
              "Face luma ≥",
              L.minFaceLuma,
              (v) => ({
                lighting: { minFaceLuma: v },
              }),
              { max: 255 },
            )}
            {limitField(
              "max-face-luma",
              "Face luma ≤",
              L.maxFaceLuma,
              (v) => ({
                lighting: { maxFaceLuma: v },
              }),
              { max: 255 },
            )}
            {limitField(
              "min-contrast",
              "Face contrast ≥",
              L.minFaceContrast,
              (v) => ({
                lighting: { minFaceContrast: v },
              }),
              { max: 128 },
            )}
            {limitField(
              "backlit",
              "Backlit: face < background ×",
              L.backlitRatio,
              (v) => ({
                lighting: { backlitRatio: v },
              }),
              { max: 1, step: 0.05 },
            )}
            {limitField(
              "sharpness",
              "Face sharpness ≥",
              I.minFaceSharpness,
              (v) => ({ image: { minFaceSharpness: v } }),
              { max: 100, step: 0.005 },
            )}
            {limitField("face-px", "Face width ≥ (px)", I.minFaceWidthPx, (v) => ({
              image: { minFaceWidthPx: v },
            }))}
          </Row>
        </details>
      </Card.Body>
    </Card>
  );
}

/** @param {{ part: { state: string, reasons: string[], reason: string | null } | undefined }} props */
function StateBadge({ part }) {
  if (!part) return <span className="text-muted">—</span>;
  return (
    <>
      <Badge
        bg={STATE_VARIANTS[/** @type {keyof typeof STATE_VARIANTS} */ (part.state)] ?? "secondary"}
        text={part.state === "issue" ? "dark" : undefined}
      >
        {part.state}
      </Badge>
      {part.reasons.length > 0 && <span className="ms-1">{part.reasons.join(", ")}</span>}
      {part.reason && <span className="text-muted ms-1">{part.reason}</span>}
    </>
  );
}
