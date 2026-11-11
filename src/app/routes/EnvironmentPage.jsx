import Button from "react-bootstrap/Button";
import Card from "react-bootstrap/Card";
import Table from "react-bootstrap/Table";
import { useLabController, useLabSnapshot } from "../../ui/common/labContext.js";

/** Browser, hardware, and API support that every benchmark report carries. */
export function EnvironmentPage() {
  const controller = useLabController();
  const { deviceProfile, camera } = useLabSnapshot();
  const profile = /** @type {Record<string, any> | null} */ (deviceProfile);

  const rows = profile
    ? [
        ["User agent", profile.userAgent],
        ["Logical cores", profile.hardwareConcurrency],
        [
          "Device memory (coarse)",
          profile.deviceMemoryGb ? `${profile.deviceMemoryGb} GB` : "not exposed",
        ],
        ["Cross-origin isolated", yesNo(profile.crossOriginIsolated)],
        ["WASM SIMD / threads", `${yesNo(profile.wasm.simd)} / ${yesNo(profile.wasm.threads)}`],
        [
          "WebGPU",
          profile.webgpu.available
            ? `${profile.webgpu.adapter?.vendor ?? "?"} ${profile.webgpu.adapter?.architecture ?? ""} ${profile.webgpu.adapter?.description ?? ""}`.trim() +
              (profile.webgpu.isFallbackAdapter ? " (fallback adapter)" : "")
            : `unavailable: ${profile.webgpu.reason}`,
        ],
        ["WebGL2 renderer", profile.webgl2.available ? profile.webgl2.renderer : "unavailable"],
        [
          "APIs",
          Object.entries(profile.apis)
            .map(([name, supported]) => `${name}: ${yesNo(supported)}`)
            .join(" · "),
        ],
      ]
    : [];

  return (
    <Card>
      <Card.Header className="py-2 d-flex align-items-center">
        Environment
        <Button
          size="sm"
          variant="outline-secondary"
          className="ms-auto"
          onClick={() => controller.loadDeviceProfile()}
        >
          Refresh
        </Button>
      </Card.Header>
      <Card.Body>
        {!profile && <p className="text-muted small">Collecting device profile…</p>}
        {profile && (
          <Table size="sm" className="metric-table small" data-testid="environment-table">
            <tbody>
              {rows.map(([name, value]) => (
                <tr key={name}>
                  <th className="text-nowrap">{name}</th>
                  <td className="text-break">{String(value)}</td>
                </tr>
              ))}
              <tr>
                <th>Camera track</th>
                <td className="text-break">
                  {camera.track ? JSON.stringify(camera.track.settings) : "camera not running"}
                </td>
              </tr>
            </tbody>
          </Table>
        )}
        {profile && (
          <details className="small">
            <summary>Raw profile JSON</summary>
            <pre className="mb-0">{JSON.stringify(profile, null, 2)}</pre>
          </details>
        )}
      </Card.Body>
    </Card>
  );
}

/** @param {unknown} value */
function yesNo(value) {
  return value ? "yes" : "no";
}
