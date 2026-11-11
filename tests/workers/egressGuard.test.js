import { describe, expect, it, vi } from "vitest";
import { installEgressGuard } from "../../src/workers/egressGuard.js";

const ORIGIN = "http://localhost:4173";

function createScope() {
  const opened = [];
  class FakeXMLHttpRequest {
    open(method, url) {
      opened.push({ method, url: String(url) });
    }
  }
  class FakeSocket {
    constructor(url) {
      this.url = url;
    }
  }
  const scope = {
    location: {
      origin: ORIGIN,
      host: "localhost:4173",
      href: `${ORIGIN}/assets/face.worker-abc.js`,
    },
    fetch: vi.fn(async (input) => ({ ok: true, input })),
    XMLHttpRequest: FakeXMLHttpRequest,
    WebSocket: FakeSocket,
    EventSource: FakeSocket,
  };
  const blocked = [];
  installEgressGuard(scope, { onBlocked: (request) => blocked.push(request) });
  return { scope, blocked, opened, originalFetch: scope.fetch };
}

describe("installEgressGuard", () => {
  it("passes same-origin, relative, blob, and data requests through", async () => {
    const { scope, blocked } = createScope();
    await scope.fetch("/models/mp-face-landmarker/face_landmarker.task");
    await scope.fetch(
      `${ORIGIN}/vendor/mediapipe/tasks-vision@1.2.2/vision_wasm_module_internal.wasm`,
    );
    await scope.fetch(`blob:${ORIGIN}/1f6c2a54`);
    await scope.fetch("data:application/octet-stream;base64,AAAA");
    expect(blocked).toEqual([]);
  });

  it("refuses fetch to another origin and reports it", async () => {
    const { scope, blocked } = createScope();
    await expect(
      scope.fetch("https://odml.pa.googleapis.com/v1/log", { method: "POST" }),
    ).rejects.toThrow(/egress guard \(fetch\): https:\/\/odml\.pa\.googleapis\.com\/v1\/log/);
    await expect(scope.fetch({ url: "https://example.com/x" })).rejects.toBeInstanceOf(TypeError);
    expect(blocked).toEqual([
      { url: "https://odml.pa.googleapis.com/v1/log", api: "fetch" },
      { url: "https://example.com/x", api: "fetch" },
    ]);
  });

  it("never forwards a refused fetch to the original implementation", async () => {
    const fetch = vi.fn(async () => ({ ok: true }));
    const scope = {
      location: { origin: ORIGIN, host: "localhost:4173", href: `${ORIGIN}/w.js` },
      fetch,
    };
    installEgressGuard(scope);
    await expect(scope.fetch("https://example.com/")).rejects.toBeInstanceOf(TypeError);
    await scope.fetch("/ok");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/ok", undefined);
  });

  it("refuses cross-origin XMLHttpRequest, WebSocket, and EventSource", () => {
    const { scope, blocked, opened } = createScope();
    const xhr = new scope.XMLHttpRequest();
    xhr.open("GET", "/local.wasm");
    expect(() => xhr.open("POST", "https://example.com/upload")).toThrow(TypeError);
    expect(opened).toEqual([{ method: "GET", url: "/local.wasm" }]);
    expect(() => new scope.WebSocket("wss://example.com/socket")).toThrow(TypeError);
    expect(() => new scope.WebSocket("ws://localhost:9999/")).toThrow(TypeError);
    expect(new scope.WebSocket("ws://localhost:4173/?token=dev").url).toBe(
      "ws://localhost:4173/?token=dev",
    );
    expect(() => new scope.EventSource("https://example.com/events")).toThrow(TypeError);
    expect(new scope.EventSource(`${ORIGIN}/events`).url).toBe(`${ORIGIN}/events`);
    expect(blocked.map((request) => request.api)).toEqual([
      "XMLHttpRequest",
      "WebSocket",
      "WebSocket",
      "EventSource",
    ]);
  });

  it("still refuses the request when the report callback throws", async () => {
    const scope = {
      location: { origin: ORIGIN, host: "localhost:4173", href: `${ORIGIN}/w.js` },
      fetch: vi.fn(),
    };
    installEgressGuard(scope, {
      onBlocked: () => {
        throw new Error("reporting failed");
      },
    });
    await expect(scope.fetch("https://example.com/")).rejects.toBeInstanceOf(TypeError);
  });
});
