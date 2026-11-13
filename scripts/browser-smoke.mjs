/**
 * Headless browser smoke test of the lab (pipeline from Phase 1, face engine and violation rules
 * from Phase 2, face verification from Phase 3, attention from Phase 4, image quality from
 * Phase 5, object detection from Phase 6).
 *
 * Builds the app, serves the production build with `vite preview` (same COOP/COEP headers and
 * CSP as a deployment), opens it in an installed Chromium-based browser with Chrome's synthetic
 * camera, and runs scripted scenarios through the real UI plus the `?automation` hook. Every
 * number in the report is measured in that browser session.
 *
 * Scenarios:
 * - A–H: pipeline behaviour with the model-free diagnostic probes (the face engine is disabled
 *   so the numbers stay comparable with Phase 1).
 * - I, J: MediaPipe Face Landmarker on the GPU delegate, then switched live to CPU in the same
 *   worker. The synthetic camera shows no face, so these measure the detector-only path.
 * - K: NO_FACE fires and ends; MULTIPLE_FACES does not fire; a threshold edited in the UI applies.
 * - L: inside the face worker, the egress guard refuses other origins and the CSP applies.
 * - Q (runs after L): attention without a face: every frame undecided, no baseline, no attention
 *   violation; the calibration overlay appears and the calibration fails with its reason; a
 *   strictness preset chosen in the UI applies.
 * - R (after Q): image-quality engine next to the face landmarker: frame statistics from real
 *   pixels with a timed read-back, the face region not measured without a face, no
 *   LIGHTING_ISSUE, the Image quality panel rendered.
 * - M, N: face verifier (YuNet + SFace, ONNX Runtime Web) on the WASM provider, then switched live
 *   to WebGPU. With no face on the synthetic camera, the centre-crop diagnostic runs both models.
 * - O: identity storage, enrollment refusing frames without a face, no FACE_MISMATCH without a
 *   reference, deletion of all identity data, and the verification worker's CSP and egress guard.
 * - S (after O): the four object detectors (EfficientDet-Lite0/Lite2 on MediaPipe, NanoDet-Plus and
 *   YOLOX-S on ONNX Runtime Web) load from the app's origin and run together at 1 FPS without
 *   failures; no PHONE_DETECTED on the synthetic camera; latency and memory recorded per model;
 *   the Objects panel switches the rules' source engine.
 * - P: stopping the camera releases every track.
 *
 * Checks come in two kinds:
 * - functional: properties that must hold on any machine (no backlog, stale frames dropped,
 *   restart works, violations fire, requests to other origins are blocked, ...). Any failure
 *   fails the run.
 * - performance: expectations that depend on the machine and its load (FPS within 10% of the
 *   target, preview frame rate, event-loop lag, GPU delegate available). Failures are reported
 *   as WARN together with the machine-wide CPU load measured during the same window.
 *
 * The browser resolves no host name except localhost, so a request that slipped past the app's
 * own blocking could not leave the machine; every request is recorded and checked.
 *
 * Usage:
 *   node scripts/browser-smoke.mjs [--channel=chrome|msedge] [--headed] [--skip-build] [--seconds=8] [--dev]
 *
 * --dev runs against the Vite dev server (unbundled modules, no CSP) instead of the build.
 * Requires the model files (npm run fetch-models).
 *
 * Output: reports/phase<N>-smoke-<channel>-<timestamp>.json; exit code 1 if a functional check fails.
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { chromium } from "playwright-core";
import { build, createServer, preview } from "vite";
import { MODEL_ASSETS } from "../src/config/modelAssets.js";
import { MEDIAPIPE_WASM_DIR } from "../src/engines/face/mediapipeAssets.js";
import { DEFAULT_FACE_VERIFIER_CONFIG } from "../src/engines/verification/faceVerifierConfig.js";
import { ORT_WASM_DIR } from "../src/engines/verification/ortAssets.js";
import { ensureModels } from "./fetch-models.mjs";

const PHASE = 6;
const IDENTITY_DATABASE = "proctoring-cv-lab-identity";
const FACE_MODEL = MODEL_ASSETS["mp-face-landmarker"];
/** The verifier's default SFace variant, which the smoke run loads. */
const RECOGNIZER = DEFAULT_FACE_VERIFIER_CONFIG.recognizerModel;
/** MediaPipe Tasks Vision 1.2.2 posts usage statistics here; the face worker must block it. */
const MEDIAPIPE_TELEMETRY_PREFIX = "https://odml.pa.googleapis.com/";
/** Console errors that are expected in a run, each with the scenario that causes it. */
const EXPECTED_CONSOLE_ERRORS = [
  /INJECTED_FAILURE/, // D: injected failures
  /dropped \(stale\)/, // E: stale frames
  /similar suppressed/, // throttled repeats of the above
  // MediaPipe's WASM logs this INFO line through console.error when the CPU delegate starts.
  /Created TensorFlow Lite XNNPACK delegate for CPU/,
  // L: the eval probe in the face worker, refused by the CSP and reported by the app.
  /Content Security Policy blocked eval in the worker/,
  /Refused to evaluate a string as JavaScript/,
];

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  }),
);
const channel = typeof args.channel === "string" ? args.channel : "chrome";
const windowMs = Number(args.seconds ?? 8) * 1000;
const PERFORMANCE = { kind: "performance" };

/** @type {{ name: string, kind: string, passed: boolean, detail?: unknown }[]} */
const checks = [];
const scenarios = {};

function check(name, passed, detail, { kind = "functional" } = {}) {
  checks.push({ name, kind, passed: Boolean(passed), detail });
  const label = passed ? "PASS" : kind === "performance" ? "WARN" : "FAIL";
  const suffix = detail === undefined ? "" : ` (${JSON.stringify(detail)})`;
  console.log(`${label}  [${kind}] ${name}${suffix}`);
}

function within(value, target, tolerance) {
  return typeof value === "number" && Math.abs(value - target) <= target * tolerance;
}

const round = (value, digits = 2) =>
  typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : value;

/** Results, failures, and drops recorded for an engine in the current window. */
function settledCount(engine) {
  const c = engine.metrics.counters;
  return c.results + c.failures + c.droppedStale + c.droppedAborted;
}

/** Outcomes recorded in a window must come from frames dispatched in that window. */
function windowAccounting(engines) {
  return engines.map((e) => ({
    id: e.id,
    dispatched: e.schedulerCounters.dispatched,
    settled: settledCount(e),
  }));
}

/** Machine-wide CPU busy share between two os.cpus() samples, all processes included. */
function cpuBusyPercent(before, after) {
  let busy = 0;
  let total = 0;
  after.forEach((cpu, index) => {
    const prev = before[index].times;
    const now = cpu.times;
    const idle = now.idle - prev.idle;
    const all =
      now.user -
      prev.user +
      (now.nice - prev.nice) +
      (now.sys - prev.sys) +
      (now.irq - prev.irq) +
      idle;
    busy += all - idle;
    total += all;
  });
  return total > 0 ? round((100 * busy) / total, 1) : null;
}

/** Compact per-engine metrics for the report. */
function engineSummary(engine) {
  const m = engine.metrics;
  const pick = (series) => ({
    n: m.latency[series].count,
    mean: round(m.latency[series].mean),
    p50: round(m.latency[series].median),
    p95: round(m.latency[series].p95),
    p99: round(m.latency[series].p99),
    max: round(m.latency[series].max),
  });
  return {
    state: engine.client?.state ?? "not loaded",
    targetFps: engine.scheduler.targetFps,
    effectiveFps: round(m.effectiveFps),
    averageFps: round(m.averageFps),
    counters: m.counters,
    scheduler: engine.schedulerCounters,
    init: m.init,
    latencyMs: {
      engine: pick("engineMs"),
      inference: pick("inferenceMs"),
      capture: pick("captureMs"),
      roundTrip: pick("roundTripMs"),
      transport: pick("transportMs"),
      queueDelay: pick("queueDelayMs"),
      frameAge: pick("frameAgeMs"),
      endToEnd: pick("endToEndMs"),
    },
    lastObservation: engine.lastResult?.observations?.[0] ?? null,
  };
}

function healthSummary(snapshot) {
  const source = snapshot.camera.frameSource;
  const { mainThread } = snapshot.monitor;
  const lag = mainThread.eventLoopLagMs;
  return {
    frameClock: source?.mode,
    frameTicksInWindow: source?.ticks,
    frameTickRate:
      source && snapshot.monitor.elapsedMs
        ? round((source.ticks * 1000) / snapshot.monitor.elapsedMs)
        : null,
    frameCallbackFps: source?.frameIntervalMs ? round(1000 / source.frameIntervalMs) : null,
    frameClockStalls: source?.stalls,
    fallbackTicks: source?.fallbackTicks,
    timestampSources: source?.timestampSources,
    missedFrameCallbacks: source?.missedCallbacks,
    playbackQuality: source?.playbackQuality,
    eventLoopLagMs: {
      n: lag.count,
      p50: round(lag.median),
      p95: round(lag.p95),
      max: round(lag.max),
    },
    hiddenSamplesExcluded: mainThread.hiddenSamplesExcluded,
    mainThreadStalls: {
      count: mainThread.stalls.count,
      maxMs: round(mainThread.stalls.maxMs),
      hiddenPageGaps: mainThread.stalls.hiddenPageGaps,
    },
    pageEvents: mainThread.pageEvents.counts,
    longTasks: mainThread.longTasks,
  };
}

/** Production build served by `vite preview`, or the dev server with `--dev`. */
async function startServer() {
  if (args.dev) {
    const server = await createServer({
      server: { port: 4318, strictPort: false, open: false },
      logLevel: "warn",
    });
    await server.listen();
    return server;
  }
  if (!args["skip-build"]) {
    console.log("Building production bundle…");
    await build({ logLevel: "warn" });
  }
  return preview({ preview: { port: 4317, strictPort: false, open: false }, logLevel: "warn" });
}

/** Per-frame face results recorded in the page: counts, payload shape, inference time. */
function summarizeFaceFrames(frames) {
  const inference = frames.map((f) => f.inferenceMs).filter((v) => typeof v === "number");
  const faceCounts = {};
  for (const frame of frames) faceCounts[frame.faceCount] = (faceCounts[frame.faceCount] ?? 0) + 1;
  return {
    n: frames.length,
    faceCounts,
    payloadFormats: [...new Set(frames.map((f) => f.format))],
    payloadImageSizes: [...new Set(frames.map((f) => `${f.imageWidth}x${f.imageHeight}`))],
    inferenceMaxMs: inference.length ? round(Math.max(...inference)) : null,
    framesOver100Ms: inference.filter((v) => v > 100).length,
  };
}

async function main() {
  const models = await ensureModels({ checkOnly: true, log: () => {} });
  if (!models.ok) {
    console.error("Model files are missing or wrong. Run: npm run fetch-models");
    process.exitCode = 1;
    return;
  }
  const server = await startServer();
  const baseUrl = server.resolvedUrls.local[0];
  const base = new URL(baseUrl);
  console.log(
    `Serving ${baseUrl} (${args.dev ? "dev server" : "production build"}) · browser: ${channel}`,
  );

  const browser = await chromium.launch({
    channel,
    headless: !args.headed,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      // Only localhost resolves: nothing can reach another host even if the app's blocking failed.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
    ],
  });
  /** Every request the browser made (pages and workers), to prove nothing left the origin. */
  const requests = { total: 0, offOrigin: [], workerAssets: new Set() };
  const startedAt = new Date().toISOString();
  let finalReport = null;
  /** @type {import('playwright-core').Page | null} */
  let page = null;
  let failureDiagnostics = null;
  const consoleErrors = [];
  const pageErrors = [];
  const failedResponses = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
    await context.grantPermissions(["camera"], { origin: base.origin });
    context.on("request", (request) => {
      requests.total += 1;
      const url = new URL(request.url());
      if (!/^(https?|wss?):$/.test(url.protocol)) return;
      if (url.host !== base.host) requests.offOrigin.push(`${request.method()} ${request.url()}`);
      if (
        url.pathname.endsWith(`/${FACE_MODEL.file}`) ||
        url.pathname.endsWith(".onnx") ||
        url.pathname.endsWith(".tflite") ||
        url.pathname.includes(MEDIAPIPE_WASM_DIR) ||
        url.pathname.includes(ORT_WASM_DIR)
      ) {
        requests.workerAssets.add(url.pathname);
      }
    });
    page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
    });
    page.on("requestfailed", (request) => {
      failedResponses.push(`failed ${request.url()} ${request.failure()?.errorText ?? ""}`);
    });
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    await page.goto(`${baseUrl}?automation=1`);
    // buildSnapshot() is fresh; getSnapshot() may be up to one UI refresh interval old.
    const snapshot = () => page.evaluate(() => window.__CV_LAB__.buildSnapshot());
    const engine = (snap, id) => snap.engines.find((e) => e.id === id);
    const lab = (method, ...methodArgs) =>
      page.evaluate(([name, params]) => window.__CV_LAB__[name](...params), [method, methodArgs]);
    const waitFor = (predicate, timeout = 15_000) =>
      page.waitForFunction(predicate, null, { timeout });
    const waitForEngineReady = (id, timeout = 15_000) =>
      page.waitForFunction(
        (engineId) =>
          window.__CV_LAB__.getSnapshot().engines.find((e) => e.id === engineId)?.client?.state ===
          "ready",
        id,
        { timeout },
      );
    const waitForDetection = (running) =>
      page.waitForFunction(
        (expected) => window.__CV_LAB__.getSnapshot().detection.running === expected,
        running,
        { timeout: 5000 },
      );
    /** Records every face-engine result in the page (the snapshot keeps only the latest). */
    const recordFaceFrames = () =>
      page.evaluate(() => {
        window.__faceFrames = [];
        window.__stopFaceRecorder?.();
        window.__stopFaceRecorder = window.__CV_LAB__.subscribeResults((notice) => {
          if (notice.engineId !== "face-landmarker") return;
          const { observations, payload, timings } = notice.result;
          window.__faceFrames.push({
            faceCount: observations.find((o) => o.type === "FACE_COUNT")?.value ?? null,
            format: payload?.format ?? null,
            payloadFaces: Array.isArray(payload?.faces) ? payload.faces.length : null,
            imageWidth: payload?.imageWidth ?? null,
            imageHeight: payload?.imageHeight ?? null,
            inferenceMs: timings?.inferenceMs ?? null,
          });
        });
      });
    const takeFaceFrames = () =>
      page.evaluate(() => {
        const frames = window.__faceFrames ?? [];
        window.__faceFrames = [];
        return frames;
      });
    /**
     * Stops the run with the camera's error when the camera is no longer active (for example
     * when the synthetic camera ends its track), instead of letting later scenarios fail
     * for that reason.
     */
    const assertCameraActive = (snap, label) => {
      if (snap.camera.status === "active" && snap.camera.frameSource) return;
      const error = snap.camera.error;
      throw new Error(
        `${label}: camera is ${snap.camera.status}` +
          (error ? ` (${error.code}: ${error.message})` : ""),
      );
    };
    /** Resets metrics, waits one measurement window, and records machine CPU load meanwhile. */
    const measureWindow = async (label, durationMs = windowMs) => {
      await lab("resetMetrics");
      const before = os.cpus();
      await page.waitForTimeout(durationMs);
      const machineCpuBusyPercent = cpuBusyPercent(before, os.cpus());
      const snap = await snapshot();
      assertCameraActive(snap, label);
      const source = snap.camera.frameSource;
      console.log(
        `--- ${label}: ${Math.round(snap.monitor.elapsedMs)} ms window, machine CPU busy ` +
          `${machineCpuBusyPercent}%, frame ticks ${source?.ticks} (fallback ${source?.fallbackTicks}, ` +
          `stalls ${source?.stalls}), decoded frames ${source?.playbackQuality?.totalVideoFrames}`,
      );
      return { snap, machineCpuBusyPercent };
    };

    check(
      "page is cross-origin isolated (COOP/COEP)",
      await page.evaluate(() => crossOriginIsolated),
    );

    // Consent and camera start through the real UI.
    await page.locator("#consent-checkbox").check();
    await page.getByRole("button", { name: "Continue" }).click();
    // A–H measure the pipeline with the diagnostic probe, as in Phase 1. The face engines, the
    // image-quality engine, and the object detector (on by default) are loaded later: the face
    // landmarker for I–L and Q, the image-quality engine with it for R, the face verifier for
    // M–O, the object detectors for S.
    await page.locator("#engine-enabled-face-landmarker").uncheck();
    await page.locator("#engine-enabled-face-verifier").uncheck();
    await page.locator("#engine-enabled-image-quality").uncheck();
    // The default object detector (Phase 6) is loaded with the others in S.
    await page.locator("#engine-enabled-objects-effdet-lite2").uncheck();
    await page.locator("#engine-enabled-probe-high").check();
    // Start the camera. Chromium's synthetic camera has occasionally ended its track right after
    // getUserMedia; the app then reports TRACK_ENDED. Retry once and keep the reason in the report.
    scenarios.cameraStartAttempts = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await page.getByRole("button", { name: "Start camera" }).click();
      await waitFor(() =>
        ["active", "error"].includes(window.__CV_LAB__.getSnapshot().camera.status),
      );
      const camera = (await snapshot()).camera;
      scenarios.cameraStartAttempts.push({ attempt, status: camera.status, error: camera.error });
      if (camera.status === "active") break;
      console.log(
        `Camera start attempt ${attempt} failed: ${camera.error?.code} ${camera.error?.message}`,
      );
    }
    check(
      "camera started (at most one retry)",
      scenarios.cameraStartAttempts.at(-1).status === "active",
      scenarios.cameraStartAttempts.map((a) => a.error?.code ?? "ok"),
    );
    await waitFor(() => window.__CV_LAB__.getSnapshot().camera.status === "active");
    await waitForEngineReady("probe-high");
    const started = await snapshot();
    const track = started.camera.track;
    scenarios.camera = { label: track.label, settings: track.settings };
    check("camera track is live", track.readyState === "live", {
      width: track.settings.width,
      height: track.settings.height,
      frameRate: track.settings.frameRate,
    });

    await page.getByRole("button", { name: "Start detection" }).click();
    await waitFor(() => window.__CV_LAB__.getSnapshot().detection.running);

    // A: baseline, one engine at 5 FPS without simulated work.
    const a = await measureWindow("A baseline");
    const aHigh = engine(a.snap, "probe-high");
    scenarios.A_baseline = {
      machineCpuBusyPercent: a.machineCpuBusyPercent,
      probeHigh: engineSummary(aHigh),
      health: healthSummary(a.snap),
    };
    check(
      "A: frame clock uses requestVideoFrameCallback",
      a.snap.camera.frameSource.mode === "requestVideoFrameCallback",
    );
    check("A: no inference failures", aHigh.metrics.counters.failures === 0);
    const aAccounting = windowAccounting([aHigh]);
    check(
      "A: only frames dispatched in the window are recorded (settled <= dispatched)",
      aAccounting.every((row) => row.settled <= row.dispatched),
      aAccounting,
    );
    check(
      "A: worker received real pixels (FRAME_PROBE mean luma > 0)",
      aHigh.lastResult?.observations?.[0]?.type === "FRAME_PROBE" &&
        aHigh.lastResult.observations[0].value > 0,
      aHigh.lastResult?.observations?.[0]?.value,
    );
    check(
      "A: average FPS within 10% of the 5 FPS target",
      within(aHigh.metrics.averageFps, 5, 0.1),
      round(aHigh.metrics.averageFps),
      PERFORMANCE,
    );
    const baselineCallbackFps = scenarios.A_baseline.health.frameCallbackFps;

    // B: backpressure, 450 ms of blocking work per frame at a 5 FPS target.
    await lab("configureEngine", "probe-high", { simulatedWorkMs: 450 });
    const b = await measureWindow("B backpressure");
    const bHigh = engine(b.snap, "probe-high");
    const bSettled = settledCount(bHigh);
    scenarios.B_backpressure = {
      machineCpuBusyPercent: b.machineCpuBusyPercent,
      probeHigh: engineSummary(bHigh),
      health: healthSummary(b.snap),
    };
    check(
      "B: no backlog (dispatched - settled <= 1)",
      bHigh.schedulerCounters.dispatched - bSettled <= 1,
      {
        dispatched: bHigh.schedulerCounters.dispatched,
        settled: bSettled,
      },
    );
    check(
      "B: skipped sampling slots are counted",
      bHigh.schedulerCounters.skippedBusy > 0,
      bHigh.schedulerCounters.skippedBusy,
    );
    check(
      "B: rate falls below target instead of queueing (average FPS < 2.5)",
      bHigh.metrics.averageFps < 2.5,
      round(bHigh.metrics.averageFps),
    );
    check(
      "B: frames stay fresh (frame age at worker start p95 < 150 ms)",
      bHigh.metrics.latency.frameAgeMs.p95 < 150,
      round(bHigh.metrics.latency.frameAgeMs.p95),
    );
    check(
      "B: preview frame callbacks >= 90% of baseline while the worker is saturated",
      scenarios.B_backpressure.health.frameCallbackFps >= baselineCallbackFps * 0.9,
      {
        baseline: baselineCallbackFps,
        underLoad: scenarios.B_backpressure.health.frameCallbackFps,
      },
      PERFORMANCE,
    );
    check(
      "B: main thread responsive (event-loop lag p95 < 50 ms)",
      b.snap.monitor.mainThread.eventLoopLagMs.p95 < 50,
      round(b.snap.monitor.mainThread.eventLoopLagMs.p95),
      PERFORMANCE,
    );
    await lab("configureEngine", "probe-high", { simulatedWorkMs: 0 });

    // C: two engines with independent schedulers and priority yielding.
    await page.locator("#engine-enabled-probe-low").check();
    await waitForEngineReady("probe-low");
    const c = await measureWindow("C two engines");
    const cHigh = engine(c.snap, "probe-high");
    const cLow = engine(c.snap, "probe-low");
    await lab("measureMemory");
    const memory = (await snapshot()).monitor.memory;
    scenarios.C_twoEngines = {
      machineCpuBusyPercent: c.machineCpuBusyPercent,
      probeHigh: engineSummary(cHigh),
      probeLow: engineSummary(cLow),
      health: healthSummary(c.snap),
      memory,
    };
    check(
      "C: low-priority engine is not starved (results > 0)",
      cLow.metrics.counters.results > 0,
      cLow.metrics.counters.results,
    );
    if (track.settings.width > 640) {
      check(
        "C: low-priority input downscaled to 640 px during capture",
        cLow.lastResult?.observations?.[0]?.metadata?.frameWidth === 640,
        cLow.lastResult?.observations?.[0]?.metadata?.frameWidth,
      );
    }
    check(
      "C: no inference failures",
      cHigh.metrics.counters.failures + cLow.metrics.counters.failures === 0,
    );
    const cAccounting = windowAccounting([cHigh, cLow]);
    check(
      "C: only frames dispatched in the window are recorded (settled <= dispatched)",
      cAccounting.every((row) => row.settled <= row.dispatched),
      cAccounting,
    );
    check(
      "C: memory measured including workers",
      memory?.method === "measureUserAgentSpecificMemory",
      memory?.method,
    );
    check(
      "C: high-priority average FPS within 10% of 5",
      within(cHigh.metrics.averageFps, 5, 0.1),
      round(cHigh.metrics.averageFps),
      PERFORMANCE,
    );
    check(
      "C: low-priority average FPS within 25% of 1",
      within(cLow.metrics.averageFps, 1, 0.25),
      round(cLow.metrics.averageFps),
      PERFORMANCE,
    );

    // D: failure injection; failures are counted and the pipeline keeps running.
    await lab("configureEngine", "probe-high", { failEveryN: 5 });
    const d = await measureWindow("D failure injection");
    const dHigh = engine(d.snap, "probe-high");
    scenarios.D_failures = {
      machineCpuBusyPercent: d.machineCpuBusyPercent,
      probeHigh: engineSummary(dHigh),
      health: healthSummary(d.snap),
    };
    const failureShare =
      dHigh.metrics.counters.failures / Math.max(1, dHigh.schedulerCounters.dispatched);
    check(
      "D: every 5th frame fails (failure share 10-30%)",
      failureShare >= 0.1 && failureShare <= 0.3,
      round(failureShare),
    );
    check(
      "D: engine stays ready and keeps producing results",
      dHigh.client.state === "ready" && dHigh.metrics.counters.results > 0,
    );
    await lab("configureEngine", "probe-high", { failEveryN: 0 });

    // E: stale frames are dropped in the worker, before inference. Frames can reach the worker
    // less than 1 ms after capture (0.85-0.99 ms seen in one Chrome run), so the limit must be far
    // below that for every frame to count as stale.
    await lab("updateScheduler", "probe-high", { maxFrameAgeMs: 0.01 });
    const e = await measureWindow("E stale frames", 3000);
    const eHigh = engine(e.snap, "probe-high");
    scenarios.E_stale = { probeHigh: engineSummary(eHigh), health: healthSummary(e.snap) };
    check(
      "E: frames older than maxFrameAgeMs are dropped before inference",
      eHigh.metrics.counters.droppedStale > 0 &&
        eHigh.metrics.counters.results <= eHigh.schedulerCounters.dispatched * 0.2,
      eHigh.metrics.counters,
    );
    await lab("updateScheduler", "probe-high", { maxFrameAgeMs: 500 });

    // F: worker restart.
    await lab("resetMetrics");
    await lab("restartEngine", "probe-high");
    await page.waitForTimeout(2500);
    const f = await snapshot();
    assertCameraActive(f, "F restart");
    const fHigh = engine(f, "probe-high");
    scenarios.F_restart = { probeHigh: engineSummary(fHigh), health: healthSummary(f) };
    check(
      "F: restarted worker is ready and produces results",
      fHigh.client.state === "ready" &&
        fHigh.client.restarts === 1 &&
        fHigh.metrics.counters.results > 0,
      {
        restarts: fHigh.client.restarts,
        results: fHigh.metrics.counters.results,
        spawnToReadyMs: round(fHigh.metrics.init?.spawnToReadyMs),
      },
    );

    // G: disabling an engine terminates its worker.
    await page.locator("#engine-enabled-probe-low").uncheck();
    await waitFor(
      () =>
        window.__CV_LAB__.getSnapshot().engines.find((e) => e.id === "probe-low")?.client === null,
    );
    check("G: disabled engine is unloaded (worker terminated)", true);

    // H: a blocked main thread is recorded as a timestamped stall and logged; frame capture and
    // detection recover afterwards. Synthetic blur/focus events check the page-event wiring.
    const blockMs = 700;
    await lab("resetMetrics");
    await page.waitForTimeout(500);
    const block = await page.evaluate((durationMs) => {
      const now = () => performance.timeOrigin + performance.now();
      const startedAt = now();
      while (now() - startedAt < durationMs) {
        // Busy-wait: no timer, frame callback or message handler runs on this thread meanwhile.
      }
      return { startedAt, endedAt: now(), documentHasFocus: document.hasFocus() };
    }, blockMs);
    await page.waitForTimeout(300);
    const hStall = await snapshot();
    assertCameraActive(hStall, "H main-thread stall");
    const hStalls = hStall.monitor.mainThread.stalls;
    const blockStall = hStalls.recent.find(
      (stall) => stall.endedAt >= block.endedAt - 1 && stall.startedAt <= block.endedAt,
    );
    const stallLog = hStall.log.find(
      (entry) =>
        entry.source === "monitor" &&
        entry.level === "warn" &&
        entry.at >= block.endedAt - 1 &&
        entry.message.startsWith("Main thread unavailable for"),
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(1000);
    // The UI refreshes every uiRefreshIntervalMs while detection runs.
    const stallCellPattern = /^[1-9]\d* · max \d+ ms · last at /;
    const stallCell = page.getByTestId("main-thread-stalls");
    const stallCellText = await stallCell
      .filter({ hasText: stallCellPattern })
      .textContent({ timeout: 3000 })
      .catch(() => stallCell.textContent());
    const hAfter = await snapshot();
    assertCameraActive(hAfter, "H main-thread stall");
    const ticksAfterStall = hAfter.camera.frameSource.ticks - hStall.camera.frameSource.ticks;
    const resultsAfterStall =
      engine(hAfter, "probe-high").metrics.counters.results -
      engine(hStall, "probe-high").metrics.counters.results;
    const pageLog = hAfter.log
      .filter((entry) => entry.source === "monitor" && entry.at >= block.endedAt)
      .map((entry) => entry.message);
    scenarios.H_mainThreadStall = {
      blockedMs: round(block.endedAt - block.startedAt),
      block: { startedAt: round(block.startedAt), endedAt: round(block.endedAt) },
      documentHasFocus: block.documentHasFocus,
      recordedStall: blockStall ?? null,
      stalls: { count: hStalls.count, maxMs: round(hStalls.maxMs) },
      stallLog: stallLog?.message ?? null,
      ticksInSecondAfterStall: ticksAfterStall,
      resultsInSecondAfterStall: resultsAfterStall,
      frameClockAfter: hAfter.camera.frameSource.clock,
      pageEvents: hAfter.monitor.mainThread.pageEvents.counts,
      monitorLog: pageLog,
      stallCellText,
      health: healthSummary(hAfter),
    };
    check(
      "H: blocked main thread recorded as a stall whose timestamps cover the block",
      Boolean(blockStall) &&
        !blockStall.pageHiddenDuringGap &&
        blockStall.durationMs >= blockMs - 150 &&
        blockStall.startedAt >= block.startedAt - 50,
      blockStall
        ? {
            durationMs: round(blockStall.durationMs),
            startedAfterBlockStartMs: round(blockStall.startedAt - block.startedAt),
            endedAfterBlockEndMs: round(blockStall.endedAt - block.endedAt),
          }
        : hStalls.recent,
    );
    check("H: stall logged as a warning with its duration", Boolean(stallLog), stallLog?.message);
    check(
      "H: runtime health panel shows the stall",
      stallCellPattern.test(stallCellText ?? ""),
      stallCellText,
    );
    check(
      "H: frame ticks and results resume after the stall, frame clock back on rVFC",
      ticksAfterStall > 0 &&
        resultsAfterStall > 0 &&
        hAfter.camera.frameSource.clock === "requestVideoFrameCallback",
      {
        ticks: ticksAfterStall,
        results: resultsAfterStall,
        clock: hAfter.camera.frameSource.clock,
      },
    );
    check(
      "H: window blur and focus recorded and logged",
      hAfter.monitor.mainThread.pageEvents.counts.blur >= 1 &&
        hAfter.monitor.mainThread.pageEvents.counts.focus >= 1 &&
        pageLog.includes("Window lost focus") &&
        pageLog.includes("Window regained focus"),
      hAfter.monitor.mainThread.pageEvents.counts,
    );

    // I: MediaPipe Face Landmarker on the GPU delegate, running alone. The synthetic camera
    // shows no face, so every frame takes the detector-only path (no landmark model).
    await page.getByRole("button", { name: "Stop detection" }).click();
    await waitForDetection(false);
    await page.locator("#engine-enabled-probe-high").uncheck();
    await waitFor(
      () =>
        window.__CV_LAB__.getSnapshot().engines.find((e) => e.id === "probe-high")?.client === null,
    );
    const faceLoadStartedAt = Date.now();
    await page.locator("#engine-enabled-face-landmarker").check();
    await waitForEngineReady("face-landmarker", 90_000);
    const faceLoadMs = Date.now() - faceLoadStartedAt;
    await recordFaceFrames();
    await page.getByRole("button", { name: "Start detection" }).click();
    await waitForDetection(true);
    await takeFaceFrames();
    const i = await measureWindow("I face engine, GPU delegate");
    const iFrames = await takeFaceFrames();
    const iFace = engine(i.snap, "face-landmarker");
    // JavaScript and WASM memory of the page and the face worker (GPU memory is not observable).
    await lab("measureMemory");
    const iMemory = (await snapshot()).monitor.memory;
    scenarios.I_faceGpu = {
      machineCpuBusyPercent: i.machineCpuBusyPercent,
      enableToReadyMs: faceLoadMs,
      executionProvider: iFace.client.executionProvider,
      details: iFace.client.details,
      model: iFace.client.model,
      face: engineSummary(iFace),
      frames: summarizeFaceFrames(iFrames),
      health: healthSummary(i.snap),
      memory: iMemory,
    };
    check(
      "I: face engine ready on a MediaPipe delegate",
      ["mediapipe-gpu", "mediapipe-cpu"].includes(iFace.client.executionProvider),
      { provider: iFace.client.executionProvider, init: iFace.client.initTimings },
    );
    check(
      "I: GPU delegate in use (no CPU fallback)",
      iFace.client.executionProvider === "mediapipe-gpu",
      iFace.client.details?.fallbackReason ?? "no fallback",
      PERFORMANCE,
    );
    check(
      "I: model verified at load (pinned SHA-256)",
      iFace.client.model?.sha256 === FACE_MODEL.sha256,
      iFace.client.model?.sha256,
    );
    check(
      "I: results without failures",
      iFace.metrics.counters.results > 0 && iFace.metrics.counters.failures === 0,
      iFace.metrics.counters,
    );
    check(
      "I: FACE_COUNT 0 on every frame (the synthetic camera shows no face)",
      iFrames.length > 0 && iFrames.every((f) => f.faceCount === 0),
      scenarios.I_faceGpu.frames.faceCounts,
    );
    check(
      "I: landmark payload has the documented format, sized to the transferred frame",
      iFrames.length > 0 &&
        iFrames.every(
          (f) =>
            f.format === "mediapipe-face-landmarks" &&
            f.payloadFaces === 0 &&
            f.imageWidth === track.settings.width &&
            f.imageHeight === track.settings.height,
        ),
      {
        formats: scenarios.I_faceGpu.frames.payloadFormats,
        sizes: scenarios.I_faceGpu.frames.payloadImageSizes,
      },
    );
    check(
      "I: average FPS within 10% of the 5 FPS target",
      within(iFace.metrics.averageFps, 5, 0.1),
      round(iFace.metrics.averageFps),
      PERFORMANCE,
    );

    // J: live switch to the CPU delegate in the same worker while detection runs. The GPU task
    // keeps serving frames until the CPU task is ready; closing the GPU task makes MediaPipe
    // flush its usage statistics, which the worker must refuse to send.
    await takeFaceFrames();
    const switchStartedAt = Date.now();
    await lab("configureEngine", "face-landmarker", { delegate: "CPU" });
    const switchMs = Date.now() - switchStartedAt;
    const framesDuringSwitch = (await takeFaceFrames()).length;
    const j = await measureWindow("J face engine, CPU delegate (switched live)");
    const jFrames = await takeFaceFrames();
    const jFace = engine(j.snap, "face-landmarker");
    const telemetryLog = j.snap.log.find(
      (entry) =>
        entry.source === "face-landmarker" &&
        entry.level === "warn" &&
        entry.message.startsWith(
          `Blocked a request from the worker to ${MEDIAPIPE_TELEMETRY_PREFIX}`,
        ),
    );
    scenarios.J_faceCpu = {
      machineCpuBusyPercent: j.machineCpuBusyPercent,
      switchMs,
      framesDuringSwitch,
      executionProvider: jFace.client.executionProvider,
      details: jFace.client.details,
      restarts: jFace.client.restarts,
      blockedRequests: jFace.client.blockedRequests,
      blockedRequestLog: telemetryLog?.message ?? null,
      face: engineSummary(jFace),
      frames: summarizeFaceFrames(jFrames),
      health: healthSummary(j.snap),
    };
    check(
      "J: delegate switched live to CPU in the same worker",
      jFace.client.executionProvider === "mediapipe-cpu" &&
        jFace.client.details?.lastTaskCreation?.delegate === "CPU" &&
        jFace.client.restarts === 0 &&
        jFace.client.workerAlive,
      { switchMs, framesDuringSwitch, lastTaskCreation: jFace.client.details?.lastTaskCreation },
    );
    check(
      "J: results without failures, FACE_COUNT 0 on every frame",
      jFace.metrics.counters.results > 0 &&
        jFace.metrics.counters.failures === 0 &&
        jFrames.length > 0 &&
        jFrames.every((f) => f.faceCount === 0),
      { counters: jFace.metrics.counters, faceCounts: scenarios.J_faceCpu.frames.faceCounts },
    );
    check(
      "J: MediaPipe usage statistics refused in the worker and logged",
      jFace.client.blockedRequests.count >= 1 &&
        jFace.client.blockedRequests.last?.url.startsWith(MEDIAPIPE_TELEMETRY_PREFIX) &&
        Boolean(telemetryLog),
      { blocked: jFace.client.blockedRequests, log: telemetryLog?.message },
    );
    check(
      "J: average FPS within 10% of the 5 FPS target",
      within(jFace.metrics.averageFps, 5, 0.1),
      round(jFace.metrics.averageFps),
      PERFORMANCE,
    );
    for (const [label, summary] of [
      ["GPU", scenarios.I_faceGpu.face.latencyMs.inference],
      ["CPU", scenarios.J_faceCpu.face.latencyMs.inference],
    ]) {
      console.log(
        `    face inference ${label}: n ${summary.n}, mean ${summary.mean}, p50 ${summary.p50}, ` +
          `p95 ${summary.p95}, p99 ${summary.p99}, max ${summary.max} ms`,
      );
    }

    // K: violation rules. A threshold is edited in the UI first. Starting detection clears
    // violations; with no face on the synthetic camera NO_FACE must confirm after the edited
    // minimum duration and end when detection stops, and MULTIPLE_FACES must stay inactive.
    await page.getByRole("button", { name: "Stop detection" }).click();
    await waitForDetection(false);
    const editedMinMs = 1500;
    const minInput = page.locator("#rule-NO_FACE-minDurationMs");
    await minInput.fill(String(editedMinMs));
    await minInput.press("Enter");
    await page.waitForFunction(
      (ms) =>
        window.__CV_LAB__.getSnapshot().violations.rules.find((r) => r.type === "NO_FACE").config
          .minDurationMs === ms,
      editedMinMs,
      { timeout: 5000 },
    );
    const detectionStartedAt = await page.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    await page.getByRole("button", { name: "Start detection" }).click();
    await page.waitForFunction(
      () => window.__CV_LAB__.getSnapshot().violations.active.some((v) => v.type === "NO_FACE"),
      null,
      { timeout: 10_000 },
    );
    const kActive = await snapshot();
    assertCameraActive(kActive, "K violations");
    const noFace = kActive.violations.active.find((v) => v.type === "NO_FACE");
    const confirmDelayMs = noFace.confirmedAt - noFace.startedAt;
    const activeBadge = await page
      .getByTestId("violations-active-count")
      .textContent({ timeout: 3000 })
      .catch(() => null);
    const historyRow = await page
      .getByTestId("violation-history")
      .locator("tbody tr")
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => null);
    // NO_FACE was also active during I and J; only log lines of this detection run count.
    const startLog = kActive.log.findLast(
      (entry) =>
        entry.at >= detectionStartedAt &&
        entry.source === "violations" &&
        entry.level === "warn" &&
        entry.message.startsWith("NO_FACE started (no face for "),
    );
    await page.getByRole("button", { name: "Stop detection" }).click();
    await waitForDetection(false);
    const kStopped = await snapshot();
    const noFaceEnded = kStopped.violations.history.find((v) => v.id === noFace.id);
    const multipleFaces = kStopped.violations.rules.find((r) => r.type === "MULTIPLE_FACES");
    const endLog = kStopped.log.findLast(
      (entry) =>
        entry.at >= detectionStartedAt &&
        entry.source === "violations" &&
        /^NO_FACE ended after \d+(\.\d)? s \(stopped\)$/.test(entry.message),
    );
    scenarios.K_violations = {
      editedMinDurationMs: editedMinMs,
      confirmDelayMs: round(confirmDelayMs),
      onsetAfterDetectionStartMs: round(noFace.startedAt - detectionStartedAt),
      confirmedAfterDetectionStartMs: round(noFace.confirmedAt - detectionStartedAt),
      noFace: noFaceEnded ?? null,
      multipleFaces: { state: multipleFaces.condition.state, stats: multipleFaces.stats },
      ui: { activeBadge, historyRow },
      log: { start: startLog?.message ?? null, end: endLog?.message ?? null },
    };
    check(
      "K: NO_FACE minimum duration edited in the UI is applied",
      kActive.violations.rules.find((r) => r.type === "NO_FACE").config.minDurationMs ===
        editedMinMs,
    );
    check(
      "K: NO_FACE never confirms before its minimum duration",
      confirmDelayMs >= editedMinMs,
      round(confirmDelayMs),
    );
    check(
      "K: NO_FACE confirms within two frame intervals after the minimum duration",
      confirmDelayMs < editedMinMs + 2 * (1000 / iFace.scheduler.targetFps),
      round(confirmDelayMs),
      PERFORMANCE,
    );
    check(
      "K: active violation shown in the UI and logged with its severity",
      /1 active/.test(activeBadge ?? "") &&
        /NO_FACE/.test(historyRow ?? "") &&
        /active/.test(historyRow ?? "") &&
        /severity medium\)$/.test(startLog?.message ?? ""),
      { activeBadge, historyRow, log: startLog?.message },
    );
    check(
      "K: stopping detection ends NO_FACE with reason 'stopped'",
      kStopped.violations.active.length === 0 &&
        noFaceEnded?.status === "ended" &&
        noFaceEnded.endReason === "stopped" &&
        Boolean(endLog),
      { violation: noFaceEnded, log: endLog?.message },
    );
    check(
      "K: MULTIPLE_FACES did not fire",
      multipleFaces.stats.violations === 0 && multipleFaces.condition.state === "inactive",
      scenarios.K_violations.multipleFaces,
    );
    await lab("updateViolationRule", "NO_FACE", { minDurationMs: 1000 });

    // L: inside the face worker. The egress guard refuses another origin; with the build's CSP
    // header the worker also refuses eval and reports the violation to the page.
    const faceWorker = page.workers().find((worker) => /face\.worker/.test(worker.url()));
    if (!faceWorker) throw new Error("L: the face worker was not found");
    const probeUrl = "https://example.com/cv-lab-smoke-egress-probe";
    const egressProbe = await faceWorker.evaluate(async (url) => {
      try {
        await fetch(url);
        return { blocked: false };
      } catch (error) {
        return { blocked: true, message: String(error?.message ?? error) };
      }
    }, probeUrl);
    // DevTools-protocol evaluations may compile strings despite the CSP
    // (allowUnsafeEvalBlockedByCSP), so the probe runs later, from a timer task of the worker.
    const evalProbe = await faceWorker.evaluate(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            try {
              resolve({ evalAllowed: new Function("return 1")() === 1 });
            } catch (error) {
              resolve({ evalAllowed: false, message: String(error?.message ?? error) });
            }
          }, 0);
        }),
    );
    await page.waitForTimeout(500);
    const lSnap = await snapshot();
    const lFace = engine(lSnap, "face-landmarker");
    const cspLog = lSnap.log.find(
      (entry) =>
        entry.source === "face-landmarker" &&
        entry.level === "error" &&
        entry.message.includes("Content Security Policy blocked eval in the worker"),
    );
    const workerScript = await fetch(faceWorker.url());
    const workerCsp = workerScript.headers.get("content-security-policy");
    const wasmResponse = await fetch(
      new URL(`${MEDIAPIPE_WASM_DIR}/vision_wasm_module_internal.wasm`, baseUrl),
      { method: "HEAD" },
    );
    const noticeResponse = await fetch(
      new URL(`${MEDIAPIPE_WASM_DIR}/LICENSE-NOTICE.txt`, baseUrl),
    );
    const noticeText = noticeResponse.ok ? await noticeResponse.text() : null;
    scenarios.L_workerSecurity = {
      workerUrl: new URL(faceWorker.url()).pathname,
      egressProbe,
      evalProbe,
      cspLog: cspLog?.message ?? null,
      workerScriptCsp: workerCsp,
      blockedRequests: lFace.client.blockedRequests,
      wasm: { status: wasmResponse.status, contentType: wasmResponse.headers.get("content-type") },
      licenseNotice: {
        status: noticeResponse.status,
        firstLine: noticeText?.split("\n")[0] ?? null,
      },
      workerAssetRequestsSeen: [...requests.workerAssets],
    };
    check(
      "L: egress guard refuses another origin inside the face worker and reports it",
      egressProbe.blocked &&
        /egress guard/.test(egressProbe.message ?? "") &&
        lFace.client.blockedRequests.last?.url === probeUrl,
      { probe: egressProbe, last: lFace.client.blockedRequests.last },
    );
    check(
      "L: MediaPipe WASM served from the app's origin as application/wasm",
      wasmResponse.status === 200 &&
        /application\/wasm/.test(wasmResponse.headers.get("content-type") ?? ""),
      scenarios.L_workerSecurity.wasm,
    );
    check(
      "L: model and WASM requests from the worker are visible to the request monitor",
      [...requests.workerAssets].some((p) => p.endsWith(FACE_MODEL.file)) &&
        [...requests.workerAssets].some((p) => p.endsWith(".wasm")),
      [...requests.workerAssets],
    );
    if (!args.dev) {
      check(
        "L: worker script served with the CSP header",
        /connect-src 'self'/.test(workerCsp ?? "") &&
          /script-src 'self' 'wasm-unsafe-eval'/.test(workerCsp ?? ""),
        workerCsp,
      );
      check(
        "L: CSP enforced inside the worker (eval refused) and the violation reported",
        evalProbe.evalAllowed === false && Boolean(cspLog),
        { probe: evalProbe, log: cspLog?.message },
      );
      check(
        "L: error class names survive minification and the worker boundary",
        /^LabError \[CSP_VIOLATION\]: /.test(cspLog?.message ?? ""),
        cspLog?.message,
      );
      check(
        "L: license notice emitted next to the MediaPipe WASM",
        noticeResponse.status === 200 && /Apache-2\.0/.test(noticeText ?? ""),
        scenarios.L_workerSecurity.licenseNotice,
      );
    }

    // Q: attention (head pose, gaze, eyes) on the face landmarker. The synthetic camera shows no
    // face, so every frame is "undecided": no baseline may be learned, no attention rule may
    // fire, and a calibration must fail with a clear reason instead of hanging. Detection was
    // stopped at the end of K.
    await waitForDetection(false);
    const calibrateButton = page.getByTestId("attention-calibrate");
    const calibrateDisabledWhileStopped = await calibrateButton.isDisabled();
    const qLandmarkerConfig = engine(await snapshot(), "face-landmarker").engineConfig;
    await page.getByRole("button", { name: "Start detection" }).click();
    await waitForDetection(true);
    await page.waitForTimeout(3000);
    const qLive = await snapshot();
    assertCameraActive(qLive, "Q attention");
    await calibrateButton.click();
    const overlayShown = await page
      .getByTestId("calibration-dot")
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    const firstTarget = overlayShown
      ? await page.getByTestId("calibration-dot").getAttribute("data-target")
      : null;
    await page.waitForFunction(
      () => window.__CV_LAB__.getSnapshot().attention.calibration.status === "failed",
      null,
      { timeout: 20_000 },
    );
    const overlayGone = (await page.getByTestId("calibration-overlay").count()) === 0;
    const calibrationMessage = await page
      .getByTestId("attention-calibration-message")
      .textContent({ timeout: 3000 })
      .catch(() => null);
    await page.locator("#attention-preset").selectOption("strict");
    await page.waitForFunction(
      () => window.__CV_LAB__.getSnapshot().attention.config.preset === "strict",
      null,
      { timeout: 5000 },
    );
    const qStrict = await snapshot();
    await page.locator("#attention-preset").selectOption("balanced");
    await page.getByRole("button", { name: "Stop detection" }).click();
    await waitForDetection(false);
    const qEnd = await snapshot();
    const attentionTypes = ["GAZE_AWAY", "HEAD_TURNED", "EYES_CLOSED"];
    const attentionViolations = qEnd.violations.history.filter((v) =>
      attentionTypes.includes(v.type),
    );
    const failedLog = qEnd.log.findLast(
      (entry) => entry.source === "attention" && /^Calibration failed: /.test(entry.message),
    );
    scenarios.Q_attention = {
      landmarkerOutputs: {
        blendshapes: qLandmarkerConfig.outputFaceBlendshapes,
        matrices: qLandmarkerConfig.outputFacialTransformationMatrixes,
      },
      last: qLive.attention.last,
      profile: qLive.attention.profile,
      attentionFrames: qLive.violations.attentionFramesEvaluated,
      stats: qEnd.attention.stats,
      calibration: {
        overlayShown,
        firstTarget,
        overlayGone,
        status: qEnd.attention.calibration.status,
        message: calibrationMessage,
      },
      strictPreset: {
        config: qStrict.attention.config.preset,
        gazeAwayMinDurationMs: qStrict.violations.rules.find((r) => r.type === "GAZE_AWAY").config
          .minDurationMs,
      },
      attentionViolations,
    };
    check(
      "Q: face landmarker outputs blendshapes and transformation matrices",
      qLandmarkerConfig.outputFaceBlendshapes === true &&
        qLandmarkerConfig.outputFacialTransformationMatrixes === true,
      scenarios.Q_attention.landmarkerOutputs,
    );
    check(
      "Q: calibration needs running detection (button disabled while stopped)",
      calibrateDisabledWhileStopped,
    );
    check(
      "Q: attention samples evaluated; without a face every frame is undecided and no baseline is learned",
      qLive.violations.attentionFramesEvaluated > 0 &&
        qLive.attention.last?.gaze.state === "undecided" &&
        qLive.attention.last?.gaze.reason === "no face" &&
        qLive.attention.profile === null &&
        qEnd.attention.stats.gaze.on + qEnd.attention.stats.gaze.away === 0,
      { last: qLive.attention.last?.gaze, stats: qEnd.attention.stats.gaze },
    );
    check(
      "Q: calibration shows the target overlay, then fails without a face and removes the overlay",
      overlayShown &&
        firstTarget === "center" &&
        overlayGone &&
        qEnd.attention.calibration.status === "failed" &&
        /only 0 usable frames/.test(calibrationMessage ?? "") &&
        Boolean(failedLog),
      scenarios.Q_attention.calibration,
    );
    check(
      "Q: strict preset applied from the UI to tolerances and rules",
      qStrict.attention.config.preset === "strict" &&
        qStrict.attention.config.marginDeg === 3 &&
        scenarios.Q_attention.strictPreset.gazeAwayMinDurationMs === 300 &&
        qEnd.attention.config.preset === "balanced",
      scenarios.Q_attention.strictPreset,
    );
    check(
      "Q: no attention violation without a face",
      attentionViolations.length === 0,
      attentionViolations,
    );

    // R: image quality (model-free, 1 FPS) next to the face landmarker. The synthetic camera
    // shows no face, so the face region is never measured: lighting and image stay undecided
    // unless the whole frame is too dark or bright. The frame statistics must come from real
    // pixels, and the read-back cost is recorded.
    await page.locator("#engine-enabled-image-quality").check();
    await waitForEngineReady("image-quality");
    await page.getByRole("button", { name: "Start detection" }).click();
    await waitForDetection(true);
    await page.waitForTimeout(5000);
    const rLive = await snapshot();
    assertCameraActive(rLive, "R image quality");
    await page.getByRole("button", { name: "Stop detection" }).click();
    await waitForDetection(false);
    const rQuality = engine(rLive, "image-quality");
    const rObservations = rQuality.lastResult?.observations ?? [];
    const rFrame = rObservations.find((o) => o.type === "FRAME_QUALITY");
    const rFace = rObservations.find((o) => o.type === "FACE_QUALITY");
    const rPanel = await page
      .getByTestId("quality-lighting")
      .textContent({ timeout: 3000 })
      .catch(() => null);
    const rEnd = await snapshot();
    const qualityViolations = rEnd.violations.history.filter((v) =>
      ["LIGHTING_ISSUE"].includes(v.type),
    );
    const rNoFace = rEnd.violations.history.findLast((v) => v.type === "NO_FACE");
    scenarios.R_imageQuality = {
      quality: engineSummary(rQuality),
      readMs: rQuality.metrics.breakdownMs?.readMs ?? null,
      frame: rFrame?.metadata ?? null,
      face: rFace ?? null,
      assessment: rLive.imageQuality.last,
      stats: rEnd.imageQuality.stats,
      qualityViolations,
      noFaceImageIssues: rNoFace?.imageIssues ?? null,
      panel: rPanel,
    };
    check(
      "R: image-quality engine ready, results without failures at about 1 FPS",
      rQuality.client.state === "ready" &&
        rQuality.metrics.counters.results >= 3 &&
        rQuality.metrics.counters.failures === 0,
      rQuality.metrics.counters,
    );
    check(
      "R: frame statistics from real pixels (mean luma > 0, contrast > 0), one timed read per frame",
      rFrame?.metadata.meanLuma > 0 &&
        rFrame?.metadata.stdLuma > 0 &&
        rFrame?.metadata.readWidth === Math.min(640, track.settings.width) &&
        Number.isFinite(rQuality.metrics.breakdownMs?.readMs?.median),
      { frame: rFrame?.metadata, readMs: rQuality.metrics.breakdownMs?.readMs },
    );
    check(
      "R: without a face the face region is not measured and the assessment says why",
      rFace?.detected === false &&
        /no face/.test(rFace?.metadata?.reason ?? "") &&
        rLive.imageQuality.last?.image.state !== "ok",
      { face: rFace, assessment: rLive.imageQuality.last },
    );
    // NO_FACE's imageIssues is recorded, not checked: it is null when NO_FACE confirmed before
    // the first image-quality sample of the run.
    check(
      "R: no LIGHTING_ISSUE without a face (face checks undecided, frame luma normal)",
      qualityViolations.length === 0,
      { qualityViolations, noFaceImageIssues: rNoFace?.imageIssues },
    );
    check(
      "R: Image quality panel shows the lighting state",
      /undecided|issue|ok/.test(rPanel ?? ""),
      rPanel,
    );
    await page.locator("#engine-enabled-image-quality").uncheck();

    // M: face verifier (YuNet + SFace on ONNX Runtime Web) on the WASM provider, running alone.
    // The synthetic camera shows no face, so the centre-crop diagnostic embeds a square of every
    // frame: both models run on every frame, but nothing is aligned to a face. Detection was
    // stopped at the end of R.
    await waitForDetection(false);
    await page.locator("#engine-enabled-face-landmarker").uncheck();
    await waitFor(
      () =>
        window.__CV_LAB__.getSnapshot().engines.find((e) => e.id === "face-landmarker")?.client ===
        null,
    );
    const verifierLoadStartedAt = Date.now();
    await page.locator("#engine-enabled-face-verifier").check();
    await waitForEngineReady("face-verifier", 90_000);
    const verifierLoadMs = Date.now() - verifierLoadStartedAt;
    await lab("configureEngine", "face-verifier", { embedWhenNoFace: true });
    await page.evaluate(() => {
      window.__verifierFrames = [];
      window.__stopVerifierRecorder?.();
      window.__stopVerifierRecorder = window.__CV_LAB__.subscribeResults((notice) => {
        if (notice.engineId !== "face-verifier") return;
        const { observations, payload, timings } = notice.result;
        const vector = payload?.embedding?.vector;
        window.__verifierFrames.push({
          faceCount: observations.find((o) => o.type === "FACE_COUNT")?.value ?? null,
          format: payload?.format ?? null,
          source: payload?.embedding?.source ?? null,
          dimensions: vector?.length ?? null,
          norm: vector ? Math.hypot(...vector) : null,
          breakdown: timings?.breakdownMs ?? null,
        });
      });
    });
    const takeVerifierFrames = () =>
      page.evaluate(() => {
        const frames = window.__verifierFrames ?? [];
        window.__verifierFrames = [];
        return frames;
      });
    await page.getByRole("button", { name: "Start detection" }).click();
    await waitForDetection(true);
    await takeVerifierFrames();
    const m = await measureWindow("M face verifier, WASM");
    const mFrames = await takeVerifierFrames();
    const mVerifier = engine(m.snap, "face-verifier");
    await lab("measureMemory");
    const mMemory = (await snapshot()).monitor.memory;
    const verifierSummary = (snap, frames, extra) => {
      const v = engine(snap, "face-verifier");
      return {
        executionProvider: v.client.executionProvider,
        details: {
          ...v.client.details,
          selfCheck: v.client.details?.selfCheck ? "recorded" : null,
        },
        model: v.client.model,
        engine: engineSummary(v),
        breakdownMs: v.metrics.breakdownMs,
        frames: {
          n: frames.length,
          faceCounts: [...new Set(frames.map((f) => f.faceCount))],
          sources: [...new Set(frames.map((f) => f.source))],
        },
        health: healthSummary(snap),
        ...extra,
      };
    };
    const wasmSelfCheck = mVerifier.client.details?.selfCheck?.embedding ?? null;
    scenarios.M_verifierWasm = verifierSummary(m.snap, mFrames, {
      machineCpuBusyPercent: m.machineCpuBusyPercent,
      enableToReadyMs: verifierLoadMs,
      memory: mMemory,
    });
    check(
      "M: face verifier ready on the ONNX Runtime WASM provider",
      mVerifier.client.executionProvider === "ort-wasm",
      { provider: mVerifier.client.executionProvider, init: mVerifier.client.initTimings },
    );
    check(
      "M: both models verified at load (pinned SHA-256)",
      ["ocv-yunet-2026may", RECOGNIZER].every(
        (id) =>
          mVerifier.client.model?.components?.find((c) => c.id === id)?.sha256 ===
          MODEL_ASSETS[id].sha256,
      ),
      mVerifier.client.model?.components,
    );
    check(
      "M: int8bq recognizer loaded with its 29 unread graph inputs dropped",
      RECOGNIZER !== "ocv-sface-int8bq" ||
        mVerifier.client.model?.components?.find((c) => c.id === RECOGNIZER)?.prunedGraphInputs ===
          29,
      mVerifier.client.model?.components?.find((c) => c.id === RECOGNIZER),
    );
    check(
      "M: worker is cross-origin isolated (WASM threads possible)",
      mVerifier.client.details?.environment?.crossOriginIsolated === true,
      mVerifier.client.details?.environment,
    );
    check(
      "M: ONNX Runtime uses more than one WASM thread",
      (mVerifier.client.details?.environment?.numThreads ?? 0) > 1,
      mVerifier.client.details?.environment?.numThreads,
      PERFORMANCE,
    );
    check(
      "M: results without failures, FACE_COUNT 0 on every frame",
      mVerifier.metrics.counters.results > 0 &&
        mVerifier.metrics.counters.failures === 0 &&
        mFrames.length > 0 &&
        mFrames.every((f) => f.faceCount === 0),
      {
        counters: mVerifier.metrics.counters,
        faceCounts: scenarios.M_verifierWasm.frames.faceCounts,
      },
    );
    check(
      "M: every frame embedded as a centre crop: 128 values, unit length",
      mFrames.length > 0 &&
        mFrames.every(
          (f) =>
            f.format === "face-verifier" &&
            f.source === "center-crop" &&
            f.dimensions === 128 &&
            Math.abs(f.norm - 1) < 1e-4,
        ),
      mFrames[0],
    );
    check(
      "M: detector, alignment, and recognizer timed separately",
      ["detectorMs", "alignMs", "recognizerMs"].every(
        (part) => (mVerifier.metrics.breakdownMs?.[part]?.count ?? 0) > 0,
      ),
      Object.keys(mVerifier.metrics.breakdownMs ?? {}),
    );
    check(
      "M: self-check embedding recorded at warm-up",
      Array.isArray(wasmSelfCheck) && wasmSelfCheck.length === 128,
    );
    check(
      "M: average FPS within 10% of the 2 FPS target",
      within(mVerifier.metrics.averageFps, 2, 0.1),
      round(mVerifier.metrics.averageFps),
      PERFORMANCE,
    );

    // N: live switch to the WebGPU provider. The same synthetic self-check input must give the
    // same embedding on both providers.
    const providerSwitchStartedAt = Date.now();
    await lab("configureEngine", "face-verifier", { executionProvider: "webgpu" });
    const providerSwitchMs = Date.now() - providerSwitchStartedAt;
    await takeVerifierFrames();
    const n = await measureWindow("N face verifier, WebGPU (switched live)");
    const nFrames = await takeVerifierFrames();
    const nVerifier = engine(n.snap, "face-verifier");
    const webgpuSelfCheck = nVerifier.client.details?.selfCheck?.embedding ?? null;
    const selfCheckCosine =
      wasmSelfCheck && webgpuSelfCheck
        ? wasmSelfCheck.reduce((sum, value, index) => sum + value * webgpuSelfCheck[index], 0)
        : null;
    const onWebGpu = nVerifier.client.executionProvider === "ort-webgpu";
    scenarios.N_verifierWebGpu = verifierSummary(n.snap, nFrames, {
      machineCpuBusyPercent: n.machineCpuBusyPercent,
      switchMs: providerSwitchMs,
      selfCheckCosineToWasm: round(selfCheckCosine, 6),
    });
    check(
      "N: WebGPU provider used, or the fallback reason reported",
      onWebGpu || Boolean(nVerifier.client.details?.fallbackReason),
      {
        provider: nVerifier.client.executionProvider,
        fallback: nVerifier.client.details?.fallbackReason,
      },
    );
    check("N: WebGPU provider in use", onWebGpu, nVerifier.client.executionProvider, PERFORMANCE);
    check(
      "N: results without failures after the live switch (same worker)",
      nVerifier.metrics.counters.results > 0 &&
        nVerifier.metrics.counters.failures === 0 &&
        nVerifier.client.restarts === 0,
      { counters: nVerifier.metrics.counters, switchMs: providerSwitchMs },
    );
    if (onWebGpu) {
      check(
        "N: WebGPU and WASM give the same self-check embedding (cosine ≥ 0.999)",
        selfCheckCosine !== null && selfCheckCosine >= 0.999,
        round(selfCheckCosine, 6),
      );
    }
    for (const [label, data] of [
      ["WASM", scenarios.M_verifierWasm],
      ["WebGPU", scenarios.N_verifierWebGpu],
    ]) {
      const part = (name) => data.breakdownMs?.[name];
      console.log(
        `    verifier ${label} (${data.executionProvider}): engine p50 ${round(data.engine.latencyMs.engine.p50)} ms, ` +
          `detector p50 ${round(part("detectorMs")?.median)}, align p50 ${round(part("alignMs")?.median)}, ` +
          `recognizer p50 ${round(part("recognizerMs")?.median)} ms`,
      );
    }
    await lab("configureEngine", "face-verifier", { executionProvider: "wasm" });

    // O: identity. Without a reference, FACE_MISMATCH is never evaluated; enrollment refuses
    // frames without a face (the centre-crop diagnostic never enrolls); identity storage works and
    // "Delete all identity data" removes the database. Inside the verifier worker the CSP and the
    // egress guard apply as in the face worker.
    const databaseNames = () =>
      page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));
    const storageTest = await lab("testIdentityStorage");
    await page.locator("#identity-enroll").click();
    await page.waitForTimeout(3000);
    const oEnrolling = await snapshot();
    const enrollment = oEnrolling.identity.enrollment;
    await page.getByRole("button", { name: "Cancel enrollment" }).click();
    const mismatchRule = oEnrolling.violations.rules.find((r) => r.type === "FACE_MISMATCH");
    const databasesBefore = await databaseNames();
    await page.locator("#identity-delete-all").click();
    await page.locator("#identity-delete-all").click();
    await page.waitForFunction(
      () =>
        window.__CV_LAB__
          .getSnapshot()
          .log.some(
            (entry) =>
              entry.source === "identity" && /All identity data deleted/.test(entry.message),
          ),
      null,
      { timeout: 10_000 },
    );
    const databasesAfter = await databaseNames();
    const verifierWorker = page
      .workers()
      .find((worker) => /verification\.worker/.test(worker.url()));
    if (!verifierWorker) throw new Error("O: the verification worker was not found");
    const verifierEgress = await verifierWorker.evaluate(async (url) => {
      try {
        await fetch(url);
        return { blocked: false };
      } catch (error) {
        return { blocked: true, message: String(error?.message ?? error) };
      }
    }, "https://example.com/cv-lab-smoke-egress-probe");
    const verifierScriptCsp = (await fetch(verifierWorker.url())).headers.get(
      "content-security-policy",
    );
    const ortWasm = await fetch(
      new URL(`${ORT_WASM_DIR}/ort-wasm-simd-threaded.asyncify.wasm`, baseUrl),
      { method: "HEAD" },
    );
    const ortNotice = await fetch(new URL(`${ORT_WASM_DIR}/LICENSE-NOTICE.txt`, baseUrl));
    const ortNoticeText = ortNotice.ok ? await ortNotice.text() : null;
    scenarios.O_identity = {
      storageTest,
      storageKind: oEnrolling.identity.storage.kind,
      enrollment,
      faceMismatch: { stats: mismatchRule.stats, state: mismatchRule.condition.state },
      identityFramesEvaluated: oEnrolling.violations.identityFramesEvaluated,
      comparisons: oEnrolling.identity.verification.counts,
      databasesBefore,
      databasesAfter,
      verifierWorker: {
        url: new URL(verifierWorker.url()).pathname,
        egress: verifierEgress,
        scriptCsp: verifierScriptCsp,
      },
      ortWasm: { status: ortWasm.status, contentType: ortWasm.headers.get("content-type") },
      ortLicenseNotice: ortNoticeText?.split("\n")[0] ?? null,
    };
    check(
      "O: identity data stored in IndexedDB; write, read, delete round trip works",
      oEnrolling.identity.storage.kind === "indexeddb" && storageTest.ok === true,
      storageTest,
    );
    check(
      "O: without a reference no frame is compared and FACE_MISMATCH does not fire",
      oEnrolling.identity.reference === null &&
        oEnrolling.violations.identityFramesEvaluated === 0 &&
        mismatchRule.stats.violations === 0 &&
        oEnrolling.identity.verification.counts.compared === 0,
      scenarios.O_identity.faceMismatch,
    );
    check(
      "O: enrollment refuses frames without a face (centre-crop embeddings never enroll)",
      enrollment.status === "collecting" &&
        enrollment.accepted === 0 &&
        enrollment.framesRejected >= 3 &&
        enrollment.mostFrequentFailure?.label === "Face embedded",
      {
        status: enrollment.status,
        accepted: enrollment.accepted,
        rejected: enrollment.framesRejected,
        mostFrequentFailure: enrollment.mostFrequentFailure,
      },
    );
    check(
      "O: 'Delete all identity data' removes the identity database",
      databasesBefore.includes(IDENTITY_DATABASE) && !databasesAfter.includes(IDENTITY_DATABASE),
      { before: databasesBefore, after: databasesAfter },
    );
    check(
      "O: egress guard refuses another origin inside the verification worker",
      verifierEgress.blocked && /egress guard/.test(verifierEgress.message ?? ""),
      verifierEgress,
    );
    check(
      "O: ONNX Runtime WASM, glue, and ONNX models loaded from the app's origin",
      ortWasm.status === 200 &&
        /application\/wasm/.test(ortWasm.headers.get("content-type") ?? "") &&
        [...requests.workerAssets].some((p) => p.endsWith("ort-wasm-simd-threaded.asyncify.mjs")) &&
        [...requests.workerAssets].some((p) => p.endsWith(MODEL_ASSETS[RECOGNIZER].file)),
      [...requests.workerAssets].filter((p) => p.includes(ORT_WASM_DIR) || p.endsWith(".onnx")),
    );
    if (!args.dev) {
      check(
        "O: verification worker script served with the CSP header",
        /connect-src 'self'/.test(verifierScriptCsp ?? ""),
        verifierScriptCsp,
      );
      check(
        "O: license notice emitted next to the ONNX Runtime WASM",
        /^onnxruntime-web 1\.31\.1/.test(ortNoticeText ?? "") && /MIT/.test(ortNoticeText ?? ""),
        scenarios.O_identity.ortLicenseNotice,
      );
    }

    // S: object detectors. Detection keeps running from O; the verifier is unloaded so the four
    // object engines run alone, together, at their default 1 FPS. The synthetic camera shows a
    // test pattern, so PHONE_DETECTED must not fire.
    await page.locator("#engine-enabled-face-verifier").uncheck();
    const OBJECT_ENGINES = [
      "objects-effdet-lite0",
      "objects-effdet-lite2",
      "objects-nanodet",
      "objects-yolox",
    ];
    for (const id of OBJECT_ENGINES) {
      await page.locator(`#engine-enabled-${id}`).check();
      await waitForEngineReady(id, 120_000);
    }
    const s = await measureWindow("S objects", Math.max(windowMs, 12_000));
    await lab("measureMemory");
    const sMemory = (await snapshot()).monitor.memory;
    const sRows = await page.getByTestId(/^objects-row-/).count();
    const sOverlays = await page.getByTestId(/^object-overlay-/).count();
    await page.getByTestId("object-source-objects-yolox").click();
    const sSwitched = await snapshot();
    await page.getByTestId("object-source-objects-effdet-lite2").click();
    const sEnd = await snapshot();
    const sEngines = Object.fromEntries(
      OBJECT_ENGINES.map((id) => {
        const e = engine(s.snap, id);
        return [
          id,
          {
            ...engineSummary(e),
            provider: e.client?.executionProvider ?? null,
            model: e.client?.model ?? null,
            objects: s.snap.objects.engines[id] ?? null,
          },
        ];
      }),
    );
    const phoneViolations = sEnd.violations.history.filter((v) => v.type === "PHONE_DETECTED");
    scenarios.S_objects = {
      machineCpuBusyPercent: s.machineCpuBusyPercent,
      engines: sEngines,
      objectFramesEvaluated: s.snap.violations.objectFramesEvaluated,
      phoneViolations,
      memory: sMemory?.contexts
        ? sMemory.contexts
            .filter((c) => /objects-/.test(c.url))
            .map((c) => ({ url: new URL(c.url).pathname, mb: round(c.bytes / 1048576, 1) }))
        : sMemory,
      panelRows: sRows,
      overlays: sOverlays,
      switchedSource: sSwitched.objects.sourceEngineId,
      switchedViolationsSource: sSwitched.violations.objectSourceEngineId,
      restoredSource: sEnd.objects.sourceEngineId,
    };
    for (const id of OBJECT_ENGINES) {
      const e = engine(s.snap, id);
      console.log(
        `  ${id}: ${e.client?.executionProvider} · ${e.metrics.counters.results} results · ` +
          `inference p50 ${round(e.metrics.latency.inferenceMs.median, 1)} ms · engine p95 ` +
          `${round(e.metrics.latency.engineMs.p95, 1)} ms · init ${round(e.metrics.init?.spawnToReadyMs, 0)} ms`,
      );
    }
    check(
      "S: four object engines ready, results without failures",
      OBJECT_ENGINES.every((id) => {
        const e = engine(s.snap, id);
        return (
          e.client?.state === "ready" &&
          e.metrics.counters.results >= 3 &&
          e.metrics.counters.failures === 0
        );
      }),
      Object.fromEntries(OBJECT_ENGINES.map((id) => [id, engine(s.snap, id).metrics.counters])),
    );
    check(
      "S: providers as configured (MediaPipe CPU delegate, ONNX Runtime WASM)",
      ["objects-effdet-lite0", "objects-effdet-lite2"].every(
        (id) => engine(s.snap, id).client?.executionProvider === "mediapipe-cpu",
      ) &&
        ["objects-nanodet", "objects-yolox"].every(
          (id) => engine(s.snap, id).client?.executionProvider === "ort-wasm",
        ),
      OBJECT_ENGINES.map((id) => engine(s.snap, id).client?.executionProvider),
    );
    check(
      "S: every result carries an OBJECTS summary and the rules read the default source",
      OBJECT_ENGINES.every((id) =>
        engine(s.snap, id).lastResult?.observations.some((o) => o.type === "OBJECTS"),
      ) &&
        s.snap.objects.sourceEngineId === "objects-effdet-lite2" &&
        s.snap.violations.objectFramesEvaluated > 0,
      {
        source: s.snap.objects.sourceEngineId,
        objectFramesEvaluated: s.snap.violations.objectFramesEvaluated,
      },
    );
    check(
      "S: no PHONE_DETECTED on the synthetic camera",
      phoneViolations.length === 0,
      phoneViolations,
    );
    check(
      "S: TFLite and ONNX object models loaded from the app's origin",
      OBJECT_ENGINES.every((id) => {
        const file = MODEL_ASSETS[engine(s.snap, id).engineConfig.model].file;
        return [...requests.workerAssets].some((p) => p.endsWith(`/${file}`));
      }),
      [...requests.workerAssets].filter((p) => p.endsWith(".tflite") || p.includes("object_")),
    );
    check(
      "S: Objects panel lists the four models, boxes overlay drawn per enabled model",
      sRows === 4 && sOverlays === 4,
      { rows: sRows, overlays: sOverlays },
    );
    check(
      "S: the panel switches the rules' source engine and back",
      sSwitched.objects.sourceEngineId === "objects-yolox" &&
        sSwitched.violations.objectSourceEngineId === "objects-yolox" &&
        sEnd.objects.sourceEngineId === "objects-effdet-lite2",
      {
        switched: sSwitched.objects.sourceEngineId,
        restored: sEnd.objects.sourceEngineId,
      },
    );
    for (const id of OBJECT_ENGINES) await page.locator(`#engine-enabled-${id}`).uncheck();

    finalReport = await lab("buildReport");
    const reportText = JSON.stringify(finalReport);
    check(
      "exported report contains no landmark coordinates or face embeddings",
      !reportText.includes('"landmarks"') && !reportText.includes('"vector"'),
    );

    // P: stopping the camera releases every track.
    await page.getByRole("button", { name: "Stop camera" }).click();
    await waitFor(() => window.__CV_LAB__.getSnapshot().camera.status === "idle");
    const stopped = await snapshot();
    const videoReleased = await page.evaluate(
      () => document.querySelector("video")?.srcObject === null,
    );
    scenarios.P_stop = {
      releasedTrackStates: stopped.camera.releasedTrackStates,
      videoSrcObjectCleared: videoReleased,
    };
    check(
      "P: camera tracks ended and preview detached",
      stopped.camera.releasedTrackStates?.every((state) => state === "ended") && videoReleased,
      stopped.camera.releasedTrackStates,
    );

    const cspViolations = await page.evaluate(() => window.__cspViolations);
    check("no CSP violations in the page", cspViolations.length === 0, cspViolations);
    check("no uncaught page errors", pageErrors.length === 0, pageErrors);
    check("no failed network requests", failedResponses.length === 0, failedResponses);
    check("no request left the app's origin (pages and workers)", requests.offOrigin.length === 0, {
      total: requests.total,
      offOrigin: requests.offOrigin.slice(0, 5),
    });
    const unexpected = consoleErrors.filter(
      (text) => !EXPECTED_CONSOLE_ERRORS.some((pattern) => pattern.test(text)),
    );
    check("no unexpected console errors", unexpected.length === 0, unexpected.slice(0, 5));
  } catch (error) {
    check("smoke run completed without exceptions", false, String(error?.stack ?? error));
    failureDiagnostics = await page
      ?.evaluate(() => {
        const snap = window.__CV_LAB__?.buildSnapshot();
        return snap ? { camera: snap.camera, log: snap.log } : null;
      })
      .catch((diagnosticError) => ({ error: String(diagnosticError) }));
    console.log("Lab log at failure:");
    for (const entry of failureDiagnostics?.log ?? []) {
      console.log(
        `  ${new Date(entry.at).toISOString()} ${entry.level} [${entry.source}] ${entry.message}`,
      );
    }
  } finally {
    const browserVersion = browser.version();
    await browser.close();
    await (typeof server.close === "function"
      ? server.close()
      : new Promise((resolve) => server.httpServer.close(resolve)));
    const functional = checks.filter((item) => item.kind === "functional");
    const performance = checks.filter((item) => item.kind === "performance");
    const report = {
      tool: "scripts/browser-smoke.mjs",
      phase: PHASE,
      startedAt,
      finishedAt: new Date().toISOString(),
      browser: { channel, version: browserVersion, headless: !args.headed },
      server: args.dev ? "vite dev server (no CSP)" : "vite preview of the production build",
      host: {
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        platform: `${os.platform()} ${os.release()}`,
      },
      measurementWindowMs: windowMs,
      passed: functional.every((item) => item.passed),
      functionalChecks: {
        passed: functional.filter((i) => i.passed).length,
        total: functional.length,
      },
      performanceChecks: {
        passed: performance.filter((i) => i.passed).length,
        total: performance.length,
      },
      checks,
      scenarios,
      requests: {
        total: requests.total,
        offOrigin: requests.offOrigin,
        workerAssetsSeen: [...requests.workerAssets],
      },
      consoleErrorCount: consoleErrors.length,
      consoleErrors: consoleErrors.slice(0, 50),
      failureDiagnostics,
      labReport: finalReport,
    };
    await mkdir("reports", { recursive: true });
    const file = `reports/phase${PHASE}-smoke-${channel}-${startedAt.replace(/[:.]/g, "-")}.json`;
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(
      `\nFunctional ${report.functionalChecks.passed}/${report.functionalChecks.total} · ` +
        `performance ${report.performanceChecks.passed}/${report.performanceChecks.total} · report: ${file}`,
    );
    process.exitCode = report.passed ? 0 : 1;
  }
}

await main();
