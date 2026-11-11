import Col from "react-bootstrap/Col";
import Row from "react-bootstrap/Row";
import { EngineMetricsTable } from "../../ui/benchmarks/EngineMetricsTable.jsx";
import { RuntimeHealthPanel } from "../../ui/benchmarks/RuntimeHealthPanel.jsx";
import { CameraPanel } from "../../ui/camera/CameraPanel.jsx";
import { ConsentNotice } from "../../ui/camera/ConsentNotice.jsx";
import { EventLog } from "../../ui/common/EventLog.jsx";
import { useLabSnapshot } from "../../ui/common/labContext.js";
import { DetectionToolbar } from "../../ui/detections/DetectionToolbar.jsx";
import { EngineCard } from "../../ui/detections/EngineCard.jsx";
import { CalibrationPanel } from "../../ui/identity/CalibrationPanel.jsx";
import { IdentityPanel } from "../../ui/identity/IdentityPanel.jsx";
import { ViolationsPanel } from "../../ui/violations/ViolationsPanel.jsx";

/**
 * Page 1: camera, engine controls, and live measurements. Enrollment and calibration sit under
 * the preview, so the person can be positioned while watching it.
 */
export function LiveTestingPage() {
  const snapshot = useLabSnapshot();
  return (
    <Row className="g-3">
      <Col xl={5} lg={6}>
        <ConsentNotice />
        <CameraPanel />
        <IdentityPanel />
        <CalibrationPanel />
        <EventLog entries={snapshot.log} />
      </Col>
      <Col xl={7} lg={6}>
        <DetectionToolbar />
        <ViolationsPanel />
        {snapshot.engines.map((engine) => (
          <EngineCard key={engine.id} engine={engine} />
        ))}
        <EngineMetricsTable engines={snapshot.engines} />
        <RuntimeHealthPanel snapshot={snapshot} />
      </Col>
    </Row>
  );
}
