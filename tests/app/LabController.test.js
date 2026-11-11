import { afterEach, describe, expect, it, vi } from "vitest";
import { LabController, faceHintFrom } from "../../src/app/LabController.js";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import {
  FakeEngine,
  createFakeFrame,
  createFakeWorkerFactory,
  deferred,
  flush,
} from "../helpers/fakes.js";
import { attentionResult, frame } from "../helpers/attention.js";

const TRACK = {
  label: "Fake camera",
  readyState: "live",
  muted: false,
  settings: { width: 640, height: 480, frameRate: 30, deviceId: "cam-1" },
  capabilities: null,
};

/** CameraManager stand-in. `endDuring` makes the track end while the controller is starting. */
function createFakeCamera({ endDuring = null } = {}) {
  const listeners = new Set();
  let active = false;
  const emit = (event) => listeners.forEach((listener) => listener(event));
  const camera = {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async listVideoInputs() {
      return [{ deviceId: "cam-1", label: "Fake camera", groupId: "g" }];
    },
    async start() {
      active = true;
      if (endDuring === "getUserMedia") {
        queueMicrotask(() => {
          active = false;
          emit({ type: "ended" });
        });
      }
      return { stream: { getVideoTracks: () => [{ readyState: "live" }] }, track: TRACK };
    },
    stop() {
      const wasActive = active;
      active = false;
      return wasActive ? ["ended"] : [];
    },
    get isActive() {
      return active;
    },
    getTrackInfo() {
      return active ? TRACK : null;
    },
    dispose() {},
    endTrack() {
      active = false;
      emit({ type: "ended" });
    },
  };
  return camera;
}

/** `deliverFrame()` runs the pending requestVideoFrameCallback callback, like a new frame. */
function createFakeVideo({ onPlay } = {}) {
  /** @type {((now: number, metadata: object) => void) | null} */
  let pendingCallback = null;
  let presentedFrames = 0;
  return {
    srcObject: null,
    muted: false,
    playsInline: false,
    paused: true,
    ended: false,
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    currentTime: 0,
    async play() {
      await onPlay?.();
      this.paused = false;
    },
    pause() {
      this.paused = true;
    },
    requestVideoFrameCallback(callback) {
      pendingCallback = callback;
      return 1;
    },
    cancelVideoFrameCallback() {
      pendingCallback = null;
    },
    deliverFrame() {
      const callback = pendingCallback;
      pendingCallback = null;
      const now = performance.now();
      presentedFrames += 1;
      callback?.(now, {
        captureTime: now,
        mediaTime: presentedFrames / 30,
        presentedFrames,
        width: 640,
        height: 480,
      });
    },
  };
}

/** Face-landmarker stand-in: no face on any frame, 30 ms per frame. */
class NoFaceEngine extends FakeEngine {
  /** Resolves when the next detect() call starts (the frame has reached the "worker"). */
  static nextDetect = deferred();

  async onDetect(_frame, _meta, timer) {
    NoFaceEngine.nextDetect.resolve();
    NoFaceEngine.nextDetect = deferred();
    timer.start("inference");
    await flush(30);
    return {
      observations: [{ type: "FACE_COUNT", detected: false, value: 0, metadata: { maxFaces: 3 } }],
    };
  }
}

/** Face-verifier stand-in: one good frontal face whose embedding points at `degrees`. */
class FakeVerifierEngine extends FakeEngine {
  static degrees = 0;

  async onDetect(_frame, meta, timer) {
    timer.start("inference");
    const radians = (FakeVerifierEngine.degrees * Math.PI) / 180;
    const vector = new Float32Array(128);
    vector[0] = Math.cos(radians);
    vector[1] = Math.sin(radians);
    const quality = {
      score: 0.95,
      interEyePx: 80,
      rollDeg: 1,
      yawRatio: 0.02,
      brightness: 120,
      sharpness: 60,
      inFrame: true,
    };
    return {
      observations: [
        { type: "FACE_COUNT", detected: true, value: 1 },
        {
          type: "FACE_EMBEDDING",
          detected: true,
          value: 0,
          metadata: { source: "face", recognizer: "ocv-sface", quality },
        },
      ],
      payload: {
        format: "face-verifier",
        imageWidth: meta.width,
        imageHeight: meta.height,
        faces: [],
        embedding: { faceIndex: 0, source: "face", recognizer: "ocv-sface", vector },
      },
    };
  }

  getModelInfo() {
    return {
      id: "ocv-yunet-2026may+ocv-sface",
      version: "test",
      runtime: "fake",
      components: [
        { id: "ocv-yunet-2026may", version: "test", file: "yunet.onnx" },
        { id: "ocv-sface", version: "test", file: "sface.onnx" },
      ],
    };
  }
}

let controllers = [];

/** Every engine kind is served by FakeEngine; configuration is still validated per kind. */
const FAKE_LOADERS = {
  diagnostic: async () => FakeEngine,
  "face-landmarker": async () => FakeEngine,
  "face-verifier": async () => FakeEngine,
  "image-quality": async () => FakeEngine,
};

function createController(camera, options = {}) {
  const { factory } = createFakeWorkerFactory(FAKE_LOADERS);
  const controller = new LabController({
    cameraManager: camera,
    createWorker: factory,
    ...options,
  });
  controllers.push(controller);
  controller.recordConsent();
  return controller;
}

afterEach(async () => {
  await Promise.all(controllers.map((controller) => controller.dispose()));
  controllers = [];
});

describe("LabController camera lifecycle", () => {
  it("requires consent before starting the camera", async () => {
    const { factory } = createFakeWorkerFactory(FAKE_LOADERS);
    const controller = new LabController({
      cameraManager: createFakeCamera(),
      createWorker: factory,
    });
    controllers.push(controller);
    await expect(controller.startCamera(createFakeVideo())).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
    });
  });

  it("starts, loads enabled engines, and releases everything on stop", async () => {
    const camera = createFakeCamera();
    const controller = createController(camera);
    const video = createFakeVideo();
    expect(await controller.startCamera(video)).toBe(true);
    let snapshot = controller.getSnapshot();
    expect(snapshot.camera.status).toBe("active");
    expect(video.srcObject).not.toBeNull();
    expect(snapshot.engines.find((e) => e.id === "face-landmarker").client.state).toBe("ready");
    expect(snapshot.engines.find((e) => e.id === "probe-high").client).toBeNull();
    expect(snapshot.engines.find((e) => e.id === "probe-low").client).toBeNull();

    controller.stopCamera();
    snapshot = controller.getSnapshot();
    expect(snapshot.camera).toMatchObject({ status: "idle", releasedTrackStates: ["ended"] });
    expect(video.srcObject).toBeNull();
  });

  it("does not report a camera as active when its track ends during startup", async () => {
    const camera = createFakeCamera({ endDuring: "getUserMedia" });
    const controller = createController(camera);
    const video = createFakeVideo();
    expect(await controller.startCamera(video)).toBe(false);
    const { camera: state } = controller.getSnapshot();
    expect(state.status).toBe("error");
    expect(state.error.code).toBe("TRACK_ENDED");
    expect(state.frameSource).toBeNull();
    expect(video.srcObject).toBeNull();
  });

  it("aborts startup when the track ends while the preview starts playing", async () => {
    const camera = createFakeCamera();
    const controller = createController(camera);
    const video = createFakeVideo({
      onPlay: async () => {
        await flush();
        camera.endTrack();
      },
    });
    expect(await controller.startCamera(video)).toBe(false);
    expect(controller.getSnapshot().camera).toMatchObject({
      status: "error",
      error: { code: "TRACK_ENDED" },
      frameSource: null,
    });
  });

  it("moves to error when the track ends while running, and stop still works", async () => {
    const camera = createFakeCamera();
    const controller = createController(camera);
    await controller.startCamera(createFakeVideo());
    controller.startDetection();
    camera.endTrack();
    let snapshot = controller.getSnapshot();
    expect(snapshot.camera.status).toBe("error");
    expect(snapshot.detection.running).toBe(false);
    controller.stopCamera();
    snapshot = controller.getSnapshot();
    expect(snapshot.camera.status).toBe("error");
    expect(() => controller.startDetection()).toThrow(/Start the camera/);
  });
});

describe("LabController engines", () => {
  it("validates engine configuration on the main thread", async () => {
    const controller = createController(createFakeCamera());
    await expect(
      controller.configureEngine("probe-high", { simulatedWorkMs: -5 }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      controller.configureEngine("probe-high", { simulatedWorkMs: 20 }),
    ).resolves.toMatchObject({
      simulatedWorkMs: 20,
    });
  });

  it("loads and unloads an engine when it is enabled and disabled", async () => {
    const controller = createController(createFakeCamera());
    await controller.setEngineEnabled("probe-low", true);
    expect(controller.getSnapshot().engines.find((e) => e.id === "probe-low").client.state).toBe(
      "ready",
    );
    await controller.setEngineEnabled("probe-low", false);
    expect(controller.getSnapshot().engines.find((e) => e.id === "probe-low").client).toBeNull();
  });

  it("shows a loaded engine as configuring while its configuration changes", async () => {
    const controller = createController(createFakeCamera());
    await controller.setEngineEnabled("probe-high", true);
    const probeState = () =>
      controller.getSnapshot().engines.find((e) => e.id === "probe-high").busyAction;
    const seen = [];
    controller.subscribe(() => seen.push(probeState()));
    await controller.configureEngine("probe-high", { simulatedWorkMs: 5 });
    expect(seen).toContain("configuring");
    expect(probeState()).toBeNull();
  });

  it("builds a report with configuration and no image data", async () => {
    const controller = createController(createFakeCamera());
    const report = controller.buildReport();
    expect(report.schema).toBe("proctoring-cv-lab/report@1");
    expect(report.config.engines.map((engine) => engine.id)).toEqual([
      "face-landmarker",
      "face-verifier",
      "image-quality",
      "probe-high",
      "probe-low",
    ]);
    expect(report.config.imageQuality).toMatchObject({ sourceEngineId: "image-quality" });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("LabController violations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("evaluates violations only while detection runs", async () => {
    const capture = vi.fn(async () => createFakeFrame());
    vi.stubGlobal("createImageBitmap", capture);
    const { factory } = createFakeWorkerFactory({
      ...FAKE_LOADERS,
      "face-landmarker": async () => NoFaceEngine,
    });
    const controller = createController(createFakeCamera(), { createWorker: factory });
    // Only the violation source engine runs, so frames and captures can be counted exactly.
    await controller.setEngineEnabled("face-verifier", false);
    await controller.setEngineEnabled("image-quality", false);
    const results = [];
    controller.subscribeResults((notice) => results.push(notice));
    const video = createFakeVideo();
    await controller.startCamera(video);
    controller.updateViolationRule("NO_FACE", { minDurationMs: 0 });
    controller.startDetection();

    video.deliverFrame();
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(controller.buildSnapshot().violations).toMatchObject({
      framesEvaluated: 1,
      active: [{ type: "NO_FACE", status: "active" }],
    });

    await flush(250); // the face engine is due again (5 FPS)
    const secondFrameInWorker = NoFaceEngine.nextDetect.promise;
    video.deliverFrame();
    await secondFrameInWorker;
    controller.stopDetection(); // the result of the second frame arrives afterwards
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(capture).toHaveBeenCalledTimes(2);

    const { violations } = controller.buildSnapshot();
    expect(violations.framesEvaluated).toBe(1);
    expect(violations.active).toEqual([]);
    expect(violations.history).toMatchObject([
      { type: "NO_FACE", status: "ended", endReason: "stopped" },
    ]);
  });
});

/** Face-landmarker stand-in with attention observations; the gaze yaw is set per test. */
class FakeAttentionEngine extends FakeEngine {
  static gazeYaw = 0;

  async onDetect(_frame, meta, timer) {
    timer.start("inference");
    return {
      observations: attentionResult(
        frame({ at: meta.captureTime, gazeYaw: FakeAttentionEngine.gazeYaw }),
      ).observations,
    };
  }
}

describe("LabController attention", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAttentionEngine.gazeYaw = 0;
  });

  it("learns a baseline, raises GAZE_AWAY against it, applies presets, and ends violations on a baseline reset", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => createFakeFrame()),
    );
    const config = structuredClone(DEFAULT_LAB_CONFIG);
    config.engines.find((engine) => engine.id === "face-verifier").scheduler.enabled = false;
    config.engines.find((engine) => engine.id === "image-quality").scheduler.enabled = false;
    config.attention.baseline = { learnMs: 1000, minSamples: 3 };
    config.violations.rules.GAZE_AWAY = { ...config.violations.rules.GAZE_AWAY, minDurationMs: 0 };
    const { factory } = createFakeWorkerFactory({
      ...FAKE_LOADERS,
      "face-landmarker": async () => FakeAttentionEngine,
    });
    const controller = createController(createFakeCamera(), { createWorker: factory, config });
    const results = [];
    controller.subscribeResults((notice) => results.push(notice));
    const video = createFakeVideo();
    await controller.startCamera(video);
    expect(() =>
      controller.startAttentionCalibration({ width: 100, height: 100, fullscreen: false }),
    ).toThrow(expect.objectContaining({ code: "DETECTION_NOT_RUNNING" }));
    controller.startDetection();
    const nextFrame = async () => {
      const count = results.length;
      await flush(220); // the face engine is due again (5 FPS)
      video.deliverFrame();
      await vi.waitFor(() => expect(results).toHaveLength(count + 1));
    };

    while (!controller.buildSnapshot().attention.profile) await nextFrame();
    expect(controller.buildSnapshot().attention.profile.source).toBe("learned");
    expect(controller.buildSnapshot().violations.active).toEqual([]);

    FakeAttentionEngine.gazeYaw = 40; // far to the person's right
    await nextFrame();
    let snapshot = controller.buildSnapshot();
    expect(snapshot.attention.last.gaze).toMatchObject({ state: "away", direction: "right" });
    expect(snapshot.violations.active).toMatchObject([
      {
        type: "GAZE_AWAY",
        direction: "right",
        baseline: "learned",
        sourceEngineId: "face-landmarker",
      },
    ]);
    expect(
      snapshot.log.some((entry) =>
        /GAZE_AWAY started \(gaze up to [\d.]+° outside the screen area toward the right for [\d.]+ s, severity medium, uncalibrated\)$/.test(
          entry.message,
        ),
      ),
    ).toBe(true);

    controller.applyAttentionPreset("strict");
    snapshot = controller.buildSnapshot();
    expect(snapshot.attention.config).toMatchObject({ preset: "strict", marginDeg: 3 });
    expect(snapshot.violations.rules.find((r) => r.type === "GAZE_AWAY").config).toMatchObject({
      minDurationMs: 300,
      enabled: true,
    });
    controller.updateViolationRule("GAZE_AWAY", { severity: "high" });
    expect(controller.buildSnapshot().attention.config.preset).toBe("strict");
    controller.updateViolationRule("GAZE_AWAY", { minDurationMs: 0 });
    expect(controller.buildSnapshot().attention.config.preset).toBe("custom");

    await nextFrame();
    expect(controller.buildSnapshot().violations.active).toMatchObject([{ type: "GAZE_AWAY" }]);
    controller.resetAttentionBaseline();
    snapshot = controller.buildSnapshot();
    expect(snapshot.violations.active).toEqual([]);
    expect(snapshot.violations.history.at(-1)).toMatchObject({
      type: "GAZE_AWAY",
      endReason: "baseline-changed",
    });
    expect(controller.buildReport().config.attention).toMatchObject({ preset: "custom" });
  });
});

/** Face-landmarker stand-in: one face whose box is set per test. */
class FakeBoxFaceEngine extends FakeEngine {
  static box = { x: 0.3, y: 0.2, width: 0.25, height: 0.5 };

  async onDetect(_frame, _meta, timer) {
    timer.start("inference");
    return {
      observations: [
        { type: "FACE_COUNT", detected: true, value: 1 },
        {
          type: "FACE",
          detected: true,
          value: 0,
          metadata: { box: FakeBoxFaceEngine.box, truncated: false, primary: true },
        },
      ],
    };
  }
}

/** Image-quality stand-in: reports a dark face when it got a face hint, records the hints. */
class FakeQualityEngine extends FakeEngine {
  static hints = [];

  async onDetect(_frame, meta, timer) {
    timer.start("inference");
    FakeQualityEngine.hints.push(meta.hints ?? null);
    const box = meta.hints?.face?.box;
    return {
      observations: [
        {
          type: "FRAME_QUALITY",
          detected: true,
          metadata: { meanLuma: 40, stdLuma: 20, sourceWidth: 1280 },
        },
        box
          ? {
              type: "FACE_QUALITY",
              detected: true,
              metadata: {
                meanLuma: 30,
                stdLuma: 15,
                darkFraction: 0.2,
                brightFraction: 0,
                backgroundMeanLuma: 40,
                sharpness: 0.2,
                faceWidthPx: box.width * 1280,
                faceWidthRatio: box.width,
              },
            }
          : { type: "FACE_QUALITY", detected: false, metadata: { reason: "no face hint" } },
      ],
    };
  }
}

describe("LabController image quality", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeQualityEngine.hints = [];
  });

  it("passes the face engine's latest face box to the image-quality engine and assesses its result", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => createFakeFrame()),
    );
    const config = structuredClone(DEFAULT_LAB_CONFIG);
    config.engines.find((engine) => engine.id === "face-verifier").scheduler.enabled = false;
    const quality = config.engines.find((engine) => engine.id === "image-quality");
    quality.scheduler = { ...quality.scheduler, targetFps: 5, yieldToHigherPriority: false };
    const { factory } = createFakeWorkerFactory({
      ...FAKE_LOADERS,
      "face-landmarker": async () => FakeBoxFaceEngine,
      "image-quality": async () => FakeQualityEngine,
    });
    const controller = createController(createFakeCamera(), { createWorker: factory, config });
    const results = [];
    controller.subscribeResults((notice) => results.push(notice));
    const video = createFakeVideo();
    await controller.startCamera(video);
    controller.startDetection();
    for (let n = 0; n < 3; n += 1) {
      await flush(220);
      video.deliverFrame();
    }
    await vi.waitFor(() =>
      expect(results.filter((r) => r.engineId === "image-quality").length).toBeGreaterThanOrEqual(
        2,
      ),
    );
    // The first quality frame may go out before any face result; later ones carry the box.
    const withFace = FakeQualityEngine.hints.filter((hint) => hint?.face?.box);
    expect(withFace.length).toBeGreaterThan(0);
    expect(withFace[0].face).toMatchObject({
      box: FakeBoxFaceEngine.box,
      sourceEngineId: "face-landmarker",
      at: expect.any(Number),
    });
    const snapshot = controller.buildSnapshot();
    expect(snapshot.imageQuality.last.lighting).toMatchObject({
      state: "issue",
      reasons: ["dark"],
    });
    expect(snapshot.violations.qualityFramesEvaluated).toBeGreaterThan(0);
  });
});

describe("faceHintFrom", () => {
  it("takes the primary face's box and the frame time; null box without a face", () => {
    const result = (observations) => ({
      engine: "face-landmarker",
      frameCaptureTime: 42,
      observations,
    });
    const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.3 };
    expect(
      faceHintFrom(
        result([
          { type: "FACE_COUNT", detected: true, value: 2 },
          {
            type: "FACE",
            detected: true,
            value: 0,
            metadata: { box: { x: 0, y: 0, width: 0.1, height: 0.1 }, primary: false },
          },
          { type: "FACE", detected: true, value: 1, metadata: { box, primary: true } },
        ]),
      ),
    ).toEqual({ box, at: 42, sourceEngineId: "face-landmarker" });
    expect(faceHintFrom(result([{ type: "FACE_COUNT", detected: false, value: 0 }]))).toEqual({
      box: null,
      at: 42,
      sourceEngineId: "face-landmarker",
    });
    expect(faceHintFrom(result([]))).toBeNull();
  });
});

describe("LabController identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeVerifierEngine.degrees = 0;
  });

  it("enrolls through the pipeline, raises FACE_MISMATCH for another face, and ends it when the reference is deleted", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => createFakeFrame()),
    );
    const config = structuredClone(DEFAULT_LAB_CONFIG);
    config.engines.find((engine) => engine.id === "face-landmarker").scheduler.enabled = false;
    config.engines.find((engine) => engine.id === "image-quality").scheduler.enabled = false;
    const verifier = config.engines.find((engine) => engine.id === "face-verifier");
    verifier.scheduler = { ...verifier.scheduler, targetFps: 10, yieldToHigherPriority: false };
    config.identity.enrollment = { ...config.identity.enrollment, samples: 2, minIntervalMs: 0 };
    config.violations.rules.FACE_MISMATCH = {
      ...config.violations.rules.FACE_MISMATCH,
      minDurationMs: 0,
    };
    const { factory } = createFakeWorkerFactory({
      ...FAKE_LOADERS,
      "face-verifier": async () => FakeVerifierEngine,
    });
    const controller = createController(createFakeCamera(), { createWorker: factory, config });
    const results = [];
    controller.subscribeResults((notice) => results.push(notice));
    const video = createFakeVideo();
    await controller.startCamera(video);
    expect(() => controller.startEnrollment()).toThrow(
      expect.objectContaining({ code: "DETECTION_NOT_RUNNING" }),
    );
    controller.startDetection();
    const nextFrame = async () => {
      const count = results.length;
      await flush(120); // the verifier is due again (10 FPS)
      video.deliverFrame();
      await vi.waitFor(() => expect(results).toHaveLength(count + 1));
    };

    controller.startEnrollment();
    await nextFrame();
    await nextFrame();
    await vi.waitFor(() => expect(controller.buildSnapshot().identity.reference).not.toBeNull());
    expect(controller.buildSnapshot().identity.enrollment.status).toBe("done");

    await nextFrame(); // same person: compared, no mismatch
    expect(controller.buildSnapshot().identity.verification.last).toMatchObject({
      status: "compared",
      similarity: expect.closeTo(1, 5),
    });
    expect(controller.buildSnapshot().violations.active).toEqual([]);

    FakeVerifierEngine.degrees = 90; // another face: similarity 0
    await nextFrame();
    let snapshot = controller.buildSnapshot();
    expect(snapshot.violations.active).toMatchObject([
      {
        type: "FACE_MISMATCH",
        minSimilarity: expect.closeTo(0, 5),
        sourceEngineId: "face-verifier",
      },
    ]);
    expect(snapshot.log.some((entry) => /FACE_MISMATCH started/.test(entry.message))).toBe(true);

    const report = JSON.stringify(controller.buildReport());
    expect(report).not.toContain('"embedding"');
    expect(report).not.toContain('"vector"');

    await controller.deleteReference();
    snapshot = controller.buildSnapshot();
    expect(snapshot.identity.reference).toBeNull();
    expect(snapshot.violations.active).toEqual([]);
    expect(snapshot.violations.history.at(-1)).toMatchObject({
      type: "FACE_MISMATCH",
      endReason: "reference-changed",
    });
  });
});

describe("LabController page events", () => {
  it("logs page visibility and focus changes while the camera runs", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const win = new EventTarget();
    const controller = createController(createFakeCamera(), {
      pageEnvironment: { document: doc, window: win },
      // The real event-loop probe runs during this test; a slow test machine must not add a
      // stall entry to the log.
      config: {
        ...DEFAULT_LAB_CONFIG,
        monitor: { ...DEFAULT_LAB_CONFIG.monitor, stallThresholdMs: 60_000 },
      },
    });
    const monitorLog = () =>
      controller
        .buildSnapshot()
        .log.filter((entry) => entry.source === "monitor")
        .map((entry) => entry.message);

    win.dispatchEvent(new Event("blur")); // camera not started: not watched yet
    await controller.startCamera(createFakeVideo());
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("blur"));
    win.dispatchEvent(new Event("focus"));
    expect(monitorLog()).toEqual([
      expect.stringMatching(/^Page hidden: /),
      "Page visible again",
      "Window lost focus",
      "Window regained focus",
    ]);
    expect(controller.buildSnapshot().monitor.mainThread.pageEvents.counts).toEqual({
      hidden: 1,
      visible: 1,
      blur: 1,
      focus: 1,
    });

    controller.stopCamera();
    win.dispatchEvent(new Event("blur"));
    expect(monitorLog()).toHaveLength(4);
  });
});
