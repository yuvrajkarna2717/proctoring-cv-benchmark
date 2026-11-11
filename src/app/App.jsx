import { useState } from "react";
import Container from "react-bootstrap/Container";
import Nav from "react-bootstrap/Nav";
import Navbar from "react-bootstrap/Navbar";
import { EnvironmentPage } from "./routes/EnvironmentPage.jsx";
import { LiveTestingPage } from "./routes/LiveTestingPage.jsx";

const PAGES = [
  { key: "live", label: "Live testing" },
  { key: "environment", label: "Environment" },
];

export function App() {
  const [page, setPage] = useState("live");
  return (
    <>
      <Navbar bg="dark" data-bs-theme="dark" className="mb-3 py-1">
        <Container fluid>
          <Navbar.Brand className="fs-6">Proctoring CV Lab</Navbar.Brand>
          <Nav activeKey={page} onSelect={(key) => key && setPage(key)}>
            {PAGES.map(({ key, label }) => (
              <Nav.Link key={key} eventKey={key}>
                {label}
              </Nav.Link>
            ))}
          </Nav>
          <Navbar.Text className="small ms-auto">Phase 3 · all processing local</Navbar.Text>
        </Container>
      </Navbar>
      <Container fluid className="pb-4">
        {/* Pages stay mounted so the camera <video> element survives navigation. */}
        <div hidden={page !== "live"}>
          <LiveTestingPage />
        </div>
        <div hidden={page !== "environment"}>
          <EnvironmentPage />
        </div>
      </Container>
    </>
  );
}
