import { collectDeviceProfile } from "../benchmark/DeviceProfiler.js";
import { PerformanceMonitor } from "../benchmark/PerformanceMonitor.js";
import { CameraManager } from "../capture/CameraManager.js";
import { FrameScheduler } from "../capture/FrameScheduler.js";
import { VideoFrameSource } from "../capture/VideoFrameSource.js";
import { DEFAULT_LAB_CONFIG } from "../config/detection.config.js";
import { validateImageQualityConfig, validateLabConfig } from "../config/schema.js";
import { closeFrame } from "../engines/EngineContract.js";
import { ENGINE_CONFIG_SCHEMAS } from "../engines/engineKinds.js";
import { DEFAULT_FACE_VERIFIER_CONFIG } from "../engines/verification/faceVerifierConfig.js";
import { AttentionManager } from "../attention/AttentionManager.js";
import { PRESET_RULE_TYPES, attentionPreset } from "../attention/presets.js";
import { IdentityManager } from "../identity/IdentityManager.js";
import { OBJECT_ENGINE_KINDS, ObjectMonitor } from "../objects/objectMonitor.js";
import { QualityMonitor } from "../quality/qualityModel.js";
import { createIdentityStore } from "../identity/IdentityStore.js";
import { DetectionPipeline } from "../pipeline/DetectionPipeline.js";
import { ViolationEngine } from "../pipeline/ViolationEngine.js";
import { SnapshotManager } from "../snapshots/SnapshotManager.js";
import { createSnapshotStore } from "../snapshots/SnapshotStore.js";
import { epochNow } from "../utils/clock.js";
import {
  CameraError,
  EngineStateError,
  LabError,
  describeError,
  serializeError,
} from "../utils/errors.js";
import { parseConfig } from "../utils/validation.js";
import { WorkerEngineClient } from "../workers/WorkerEngineClient.js";
import { WORKER_FACTORIES } from "../workers/workerFactories.js";

export const REPORT_SCHEMA = "proctoring-cv-lab/report@1";
const LAB_PHASE = 6;
const MAX_LOG_ENTRIES = 200;
const LOG_THROTTLE_MS = 2000;

/** Outbound requests that engine runtimes are known to attempt; workers refuse all of them. */
const KNOWN_OUTBOUND_ENDPOINTS = Object.freeze([
  {
    prefix: "https://odml.pa.googleapis.com/",
    description: "MediaPipe usage statistics (task type, platform, version, call counts, latency)",
  },
]);

/** @type {Record<import('../benchmark/PerformanceMonitor.js').PageEventType, string>} */
const PAGE_EVENT_MESSAGES = {
  hidden:
    "Page hidden: the browser throttles timers and frame callbacks, so metrics from this period are not representative",
  visible: "Page visible again",
  blur: "Window lost focus",
  focus: "Window regained focus",
};

/**
 * @typedef {Object} LogEntry
 * @property {number} at epoch ms
 * @property {'info'|'warn'|'error'} level
 * @property {string} source engine id, "camera", "pipeline" or "monitor"
 * @property {string} message
 *
 * @typedef {Object} EngineSlot
 * @property {import('../config/schema.js').EngineInstanceConfig} definition
 * @property {FrameScheduler} scheduler
 * @property {Record<string, unknown>} engineConfig
 * @property {WorkerEngineClient | null} client null while the engine is not loaded
 * @property {(() => void) | null} unsubscribeClient
 * @property {'loading'|'unloading'|'restarting'|'configuring'|null} busyAction
 * @property {{ at: number, frameId: number, processingTimeMs: number,
 *   observations: import('../engines/EngineContract.js').Observation[],
 *   timing: import('../pipeline/DetectionPipeline.js').ResultTiming } | null} lastResult
 *   latest result without its payload (snapshots and reports stay small)
 *
 * @typedef {{ engineId: string, result: import('../engines/EngineContract.js').DetectionResult,
 *   receivedAt: number }} ResultNotice every result including its payload, for overlays
 */

/**
 * Main-thread composition root and the only object the UI talks to.
 *
 * It wires camera → frame source → pipeline → workers → monitor and exposes a snapshot for
 * React's useSyncExternalStore. No detection logic lives in React components; components call
 * methods here and render the snapshot.
 */
export class LabController {
  #config;
  #camera;
  #monitor;
  #now;
  #createWorker;
  /** @type {Map<string, EngineSlot>} */
  #slots = new Map();
  /** @type {VideoFrameSource | null} */
  #frameSource = null;
  /** @type {DetectionPipeline | null} */
  #pipeline = null;
  /** @type {(() => void) | null} */
  #unsubscribePipeline = null;
  /** @type {HTMLVideoElement | null} */
  #video = null;
  #detectionRunning = false;
  /** Incremented by every camera start/stop; lets an in-progress start detect cancellation. */
  #cameraSession = 0;
  /** @type {string | null} */
  #consentAt = null;
  /** @type {Record<string, unknown> | null} */
  #deviceProfile = null;
  #memoryPending = false;
  #cameraState = {
    /** @type {'idle'|'starting'|'active'|'error'} */
    status: "idle",
    /** @type {import('../utils/errors.js').SerializedError | null} */
    error: null,
    /** @type {import('../capture/CameraManager.js').VideoInputDevice[]} */
    devices: [],
    /** @type {string | null} */
    selectedDeviceId: null,
    /** @type {import('../capture/CameraManager.js').CameraTrackInfo | null} */
    track: null,
    /** @type {string[] | null} readyState of each track after the last stop */
    releasedTrackStates: null,
  };
  /** @type {LogEntry[]} */
  #logEntries = [];
  /** @type {Map<string, { at: number, suppressed: number }>} */
  #logThrottle = new Map();
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {Set<(notice: ResultNotice) => void>} */
  #resultListeners = new Set();
  /** @type {ViolationEngine} */
  #violations;
  /** @type {IdentityManager} */
  #identity;
  /** @type {AttentionManager} */
  #attention;
  /** @type {SnapshotManager} */
  #snapshots;
  /** status, target, and attempt of the calibration last published */
  #calibrationKey = "";
  /** @type {QualityMonitor} */
  #quality;
  /** @type {ObjectMonitor} */
  #objects;
  /**
   * Primary face of the face source engine's latest result, passed to image-quality engines.
   * @type {import('../engines/quality/ImageQualityEngine.js').FaceHint | null}
   */
  #faceHint = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  #refreshTimer = null;
  #dirty = false;
  /** @type {ReturnType<LabController['buildSnapshot']>} */
  #snapshot;

  /**
   * @param {Object} [options]
   * @param {import('../config/schema.js').LabConfig} [options.config]
   * @param {CameraManager} [options.cameraManager]
   * @param {(kind: string) => Worker} [options.createWorker]
   * @param {() => number} [options.now]
   * @param {{ document?: Document, window?: Window }} [options.pageEnvironment] document and
   *   window watched for visibility and focus changes (defaults to the current page)
   * @param {import('../identity/IdentityStore.js').IdentityStore} [options.identityStore]
   *   defaults to IndexedDB, or memory where IndexedDB is missing
   * @param {import('../snapshots/SnapshotStore.js').SnapshotStore} [options.snapshotStore]
   *   violation snapshots; defaults to IndexedDB, or memory where IndexedDB is missing
   */
  constructor({
    config = DEFAULT_LAB_CONFIG,
    cameraManager = new CameraManager(),
    createWorker = (kind) =>
      WORKER_FACTORIES[/** @type {keyof typeof WORKER_FACTORIES} */ (kind)](),
    now = epochNow,
    pageEnvironment = { document: globalThis.document, window: globalThis.window },
    identityStore = createIdentityStore(),
    snapshotStore = createSnapshotStore(),
  } = {}) {
    this.#config = validateLabConfig(structuredClone(config));
    this.#camera = cameraManager;
    this.#createWorker = createWorker;
    this.#now = now;
    this.#monitor = new PerformanceMonitor(this.#config.monitor, {
      now,
      environment: pageEnvironment,
    });
    this.#monitor.onMainThreadEvent((event) => this.#onMainThreadEvent(event));
    this.#violations = new ViolationEngine(this.#config.violations, {
      identitySourceEngineId: this.#config.identity.sourceEngineId,
      attentionSourceEngineId: this.#config.attention.sourceEngineId,
      qualitySourceEngineId: this.#config.imageQuality.sourceEngineId,
      objectSourceEngineId: this.#config.objects.sourceEngineId,
    });
    this.#quality = new QualityMonitor(this.#config.imageQuality);
    this.#objects = new ObjectMonitor(this.#config.objects);
    this.#violations.onEvent((event) => this.#onViolationEvent(event));
    this.#identity = new IdentityManager({
      config: this.#config.identity,
      store: identityStore,
      now,
      getCamera: () => this.#cameraInfo(),
    });
    this.#identity.onEvent((event) => this.#onIdentityEvent(event));
    void this.#identity.load();
    this.#snapshots = new SnapshotManager({
      config: this.#config.snapshots,
      store: snapshotStore,
      now,
      getCamera: () => this.#cameraInfo(),
    });
    this.#snapshots.onEvent((event) => this.#onSnapshotEvent(event));
    this.#attention = new AttentionManager({ config: this.#config.attention, now });
    this.#attention.onEvent((event) => this.#onAttentionEvent(event));
    for (const definition of this.#config.engines) {
      this.#slots.set(definition.id, {
        definition,
        scheduler: new FrameScheduler(definition.scheduler),
        engineConfig: { ...definition.engineConfig },
        client: null,
        unsubscribeClient: null,
        busyAction: null,
        lastResult: null,
      });
      this.#monitor.registerEngine(definition.id, {
        label: definition.label,
        kind: definition.kind,
      });
    }
    this.#camera.onEvent((event) => this.#onCameraEvent(event));
    this.#snapshot = this.buildSnapshot();
  }

  // ---- useSyncExternalStore -------------------------------------------------------------

  /** @param {() => void} listener */
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#snapshot;

  /**
   * Every detection result as it arrives, including the engine payload (face landmarks), for
   * overlays that must not wait for the next snapshot.
   *
   * @param {(notice: ResultNotice) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribeResults = (listener) => {
    this.#resultListeners.add(listener);
    return () => this.#resultListeners.delete(listener);
  };

  // ---- consent and camera ---------------------------------------------------------------

  recordConsent() {
    this.#consentAt = new Date().toISOString();
    this.#log("info", "camera", "Consent to camera capture recorded for this session");
    this.#publish();
  }

  async refreshDevices() {
    try {
      this.#cameraState = { ...this.#cameraState, devices: await this.#camera.listVideoInputs() };
    } catch (error) {
      this.#log("error", "camera", `Could not list cameras: ${describeError(error)}`);
    }
    this.#publish();
  }

  /**
   * Starts the camera on `video` and creates the frame source and pipeline. Failures are
   * recorded in the snapshot (camera.error) rather than thrown.
   *
   * @param {HTMLVideoElement} video
   * @param {string | null} [deviceId]
   * @returns {Promise<boolean>} true when the camera is running
   */
  async startCamera(video, deviceId = null) {
    if (!this.#consentAt) {
      throw new LabError("Consent is required before camera capture", { code: "CONSENT_REQUIRED" });
    }
    if (this.#cameraState.status === "starting") return false;
    this.stopCamera();
    // Any stopCamera() call (user action or a track "ended" event) bumps the session and makes
    // this start abort at its next await instead of reporting a dead stream as active.
    const session = ++this.#cameraSession;
    this.#video = video;
    this.#cameraState = {
      ...this.#cameraState,
      status: "starting",
      error: null,
      releasedTrackStates: null,
    };
    this.#publish();
    try {
      const { stream, track } = await this.#camera.start({ deviceId, ...this.#config.camera });
      this.#assertCameraSession(session);
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      this.#assertCameraSession(session);
      if (!this.#camera.isActive) {
        throw new CameraError("The camera track ended while the camera was starting", {
          code: "TRACK_ENDED",
        });
      }
      this.#frameSource = new VideoFrameSource(video);
      this.#frameSource.start();
      this.#pipeline = new DetectionPipeline({
        frameSource: this.#frameSource,
        monitor: this.#monitor,
        now: this.#now,
      });
      this.#unsubscribePipeline = this.#pipeline.onEvent((event) => this.#onPipelineEvent(event));
      for (const slot of this.#slots.values()) this.#pipeline.addEngine(this.#pipelineEntry(slot));
      this.#monitor.startMainThreadProbes();
      this.#startRefreshTimer();
      this.#cameraState = {
        ...this.#cameraState,
        status: "active",
        track,
        selectedDeviceId: track.settings.deviceId ?? deviceId,
      };
      const { width, height, frameRate } = track.settings;
      this.#log(
        "info",
        "camera",
        `Camera started: "${track.label}" ${width}x${height} @ ${frameRate} fps`,
      );
      await this.refreshDevices();
      await Promise.all(
        [...this.#slots.values()]
          .filter((slot) => slot.scheduler.config.enabled && !slot.client)
          .map((slot) => this.#loadEngine(slot)),
      );
      return true;
    } catch (error) {
      // A superseded start was cancelled by stopCamera(), which already owns the state.
      if (session !== this.#cameraSession) return false;
      this.#cameraSession += 1;
      this.#teardownCapture();
      this.#monitor.stopMainThreadProbes();
      this.#stopRefreshTimer();
      this.#camera.stop();
      video.srcObject = null;
      this.#video = null;
      this.#cameraState = { ...this.#cameraState, status: "error", error: serializeError(error) };
      this.#log("error", "camera", describeError(error));
      return false;
    } finally {
      this.#publish();
    }
  }

  /**
   * Stops detection and the camera, releases every camera track, and cancels a camera start
   * that is still in progress.
   */
  stopCamera() {
    this.#cameraSession += 1;
    if (this.#detectionRunning) this.stopDetection();
    this.#teardownCapture();
    const releasedStates = this.#camera.stop();
    if (this.#video) {
      this.#video.pause();
      this.#video.srcObject = null;
      this.#video = null;
    }
    this.#monitor.stopMainThreadProbes();
    this.#stopRefreshTimer();
    const { status } = this.#cameraState;
    if (releasedStates.length > 0 || status === "active" || status === "starting") {
      this.#cameraState = {
        ...this.#cameraState,
        status: "idle",
        track: null,
        releasedTrackStates:
          releasedStates.length > 0 ? releasedStates : this.#cameraState.releasedTrackStates,
      };
      this.#log(
        "info",
        "camera",
        `Camera stopped; released track states: ${releasedStates.join(", ") || "none left to release"}`,
      );
    }
    this.#publish();
  }

  /** @param {number} session */
  #assertCameraSession(session) {
    if (session !== this.#cameraSession) {
      throw new LabError("Camera start was cancelled", { code: "CAMERA_START_CANCELLED" });
    }
  }

  // ---- engines -------------------------------------------------------------------------

  /**
   * Enabling loads the engine in a new worker; disabling stops scheduling and terminates the
   * worker so a disabled engine holds no memory.
   *
   * @param {string} engineId
   * @param {boolean} enabled
   */
  async setEngineEnabled(engineId, enabled) {
    const slot = this.#slot(engineId);
    slot.scheduler.updateConfig({ enabled });
    if (enabled && !slot.client) await this.#loadEngine(slot);
    if (!enabled) await this.#unloadEngine(slot);
    this.#publish();
  }

  /**
   * @param {string} engineId
   * @param {Partial<Omit<import('../config/schema.js').SchedulerConfig, 'enabled'>>} patch
   * @throws {import('../utils/errors.js').ConfigValidationError}
   */
  updateScheduler(engineId, patch) {
    const { enabled: _ignored, ...rest } = /** @type {Record<string, unknown>} */ (patch);
    this.#slot(engineId).scheduler.updateConfig(rest);
    this.#log("info", engineId, `Scheduler updated: ${JSON.stringify(rest)}`);
    this.#publish();
  }

  /**
   * Validates on the main thread, then applies live when the engine is loaded.
   *
   * @param {string} engineId
   * @param {Record<string, unknown>} patch
   * @throws {import('../utils/errors.js').ConfigValidationError}
   */
  async configureEngine(engineId, patch) {
    const slot = this.#slot(engineId);
    const schema =
      ENGINE_CONFIG_SCHEMAS[
        /** @type {keyof typeof ENGINE_CONFIG_SCHEMAS} */ (slot.definition.kind)
      ];
    const validated = parseConfig(
      schema,
      { ...slot.engineConfig, ...patch },
      `${engineId} engine configuration`,
    );
    if (!slot.client) {
      slot.engineConfig = validated;
    } else {
      // Changes such as a delegate switch take seconds; the old model keeps serving frames
      // meanwhile, and the UI shows the engine as busy.
      const markBusy = slot.busyAction === null;
      if (markBusy) {
        slot.busyAction = "configuring";
        this.#publish();
      }
      try {
        slot.engineConfig = await slot.client.configure(patch);
      } finally {
        if (markBusy) slot.busyAction = null;
        this.#publish();
      }
    }
    this.#log("info", engineId, `Engine configuration updated: ${JSON.stringify(patch)}`);
    this.#publish();
    return { ...slot.engineConfig };
  }

  /** @param {string} engineId */
  async restartEngine(engineId) {
    const slot = this.#slot(engineId);
    if (!slot.client) {
      await this.setEngineEnabled(engineId, true);
      return;
    }
    slot.busyAction = "restarting";
    this.#monitor.recordRestart(engineId);
    if (engineId === this.#violations.sourceEngineId) this.#violations.interrupt("data-gap");
    if (engineId === this.#objects.sourceEngineId) {
      this.#violations.interruptObjectRules("data-gap");
    }
    this.#log("warn", engineId, "Restarting worker");
    this.#publish();
    try {
      const status = await slot.client.restart();
      this.#monitor.recordInit(engineId, status);
      this.#log(
        "info",
        engineId,
        `Worker restarted; ready after ${formatMs(status.spawnToReadyMs)}`,
      );
    } catch (error) {
      this.#log("error", engineId, `Restart failed: ${describeError(error)}`);
    } finally {
      slot.busyAction = null;
      this.#publish();
    }
  }

  // ---- detection and measurement ---------------------------------------------------------

  startDetection() {
    if (!this.#pipeline) {
      throw new LabError("Start the camera before starting detection", {
        code: "CAMERA_NOT_ACTIVE",
      });
    }
    this.resetMetrics();
    this.#violations.clear();
    this.#identity.clearComparisons();
    this.#attention.startSession();
    this.#quality.clear();
    this.#objects.clear();
    this.#faceHint = null;
    this.#pipeline.start();
    this.#detectionRunning = true;
    this.#log("info", "pipeline", "Detection started; metrics and violations reset");
    this.#publish();
  }

  stopDetection() {
    this.#pipeline?.stop();
    this.#violations.interrupt("stopped");
    this.#attention.cancelCalibration();
    if (this.#detectionRunning) this.#log("info", "pipeline", "Detection stopped");
    this.#detectionRunning = false;
    this.#publish();
  }

  /**
   * Changes a violation rule from the next frame on.
   *
   * @param {import('../config/schema.js').ViolationType} type
   * @param {Record<string, unknown>} patch
   * @throws {import('../utils/errors.js').ConfigValidationError}
   */
  updateViolationRule(type, patch) {
    const rule = this.#violations.updateRule(type, patch);
    // A hand-tuned attention rule no longer matches the preset it came from. Switching a rule
    // on or off or changing its severity keeps the preset.
    const tuned = Object.keys(patch).some((key) => key !== "enabled" && key !== "severity");
    if (PRESET_RULE_TYPES.includes(/** @type {any} */ (type)) && tuned) {
      this.#attention.updateConfig({ preset: "custom" });
    }
    this.#log("info", "violations", `${type} rule updated: ${JSON.stringify(patch)}`);
    this.#publish();
    return rule;
  }

  // ---- attention: head pose, gaze, eye state ---------------------------------------------

  /**
   * Starts the guided calibration: the UI shows a dot at `snapshot.attention.calibration.target`
   * and the person follows it with their eyes.
   *
   * @param {{ width: number, height: number, fullscreen: boolean }} viewport
   */
  startAttentionCalibration(viewport) {
    const slot = this.#slots.get(this.#attention.sourceEngineId);
    if (!slot?.client?.isReady || !slot.scheduler.config.enabled) {
      throw new LabError(
        `Load the ${slot?.definition.label ?? "face landmarker"} engine to calibrate attention`,
        { code: "ENGINE_NOT_READY" },
      );
    }
    if (!this.#detectionRunning) {
      throw new LabError("Start detection to calibrate attention", {
        code: "DETECTION_NOT_RUNNING",
      });
    }
    this.#attention.startCalibration(viewport);
  }

  cancelAttentionCalibration() {
    this.#attention.cancelCalibration();
    this.#publish();
  }

  /** Drops the calibration or learned baseline; a new one is learned from the next frames. */
  resetAttentionBaseline() {
    this.#attention.resetBaseline();
    this.#publish();
  }

  /**
   * Applies a strictness preset: the attention tolerances and the three attention rules'
   * timings and counts. Rules keep their on/off state and severity.
   *
   * @param {import('../attention/presets.js').PresetName} name
   */
  applyAttentionPreset(name) {
    const preset = attentionPreset(name);
    this.#attention.updateConfig({ ...preset.attention, preset: name });
    for (const type of PRESET_RULE_TYPES) {
      this.#violations.updateRule(type, preset.rules[type]);
    }
    this.#log("info", "attention", `Attention preset "${name}" applied`);
    this.#publish();
  }

  /**
   * Changes image-quality limits from the next sample on. Nested objects (`lighting`, `image`)
   * are merged one level deep.
   *
   * @param {Record<string, any>} patch
   */
  updateImageQualityConfig(patch) {
    const current = this.#quality.config;
    /** @type {Record<string, any>} */
    const merged = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      merged[key] =
        value && typeof value === "object" && !Array.isArray(value)
          ? { .../** @type {Record<string, any>} */ (current[key] ?? {}), ...value }
          : value;
    }
    const config = validateImageQualityConfig(merged);
    this.#quality.setConfig(config);
    this.#log("info", "image-quality", `Image quality limits updated: ${JSON.stringify(patch)}`);
    this.#publish();
    return config;
  }

  /**
   * Changes attention tolerances (margins, head limits, eye thresholds). Marks the preset as
   * custom unless the patch names one.
   *
   * @param {Record<string, any>} patch
   */
  updateAttentionConfig(patch) {
    const config = this.#attention.updateConfig({ preset: "custom", ...patch });
    this.#log("info", "attention", `Attention settings updated: ${JSON.stringify(patch)}`);
    this.#publish();
    return config;
  }

  /**
   * Makes `engineId` the object detector that PHONE_DETECTED reads. Active
   * object violations end with "source-changed"; the other object engines keep running for
   * comparison.
   *
   * @param {string} engineId
   */
  setObjectSource(engineId) {
    const slot = this.#slot(engineId);
    if (!OBJECT_ENGINE_KINDS.includes(slot.definition.kind)) {
      throw new LabError(`${engineId} is not an object detector`, { code: "NOT_OBJECT_ENGINE" });
    }
    if (engineId === this.#objects.sourceEngineId) return;
    this.#objects.setSourceEngine(engineId);
    this.#violations.setObjectSource(engineId);
    this.#log("info", "objects", `Object rules now read ${slot.definition.label} (${engineId})`);
    this.#publish();
  }

  /** Clears the violation history and statistics. Snapshots are kept until they expire. */
  clearViolations() {
    this.#violations.clear();
    this.#log("info", "violations", "Violation history cleared");
    this.#publish();
  }

  // ---- violation snapshots ----------------------------------------------------------------

  /**
   * Image of a stored snapshot, for display (`URL.createObjectURL`).
   *
   * @param {string} id
   * @param {'image' | 'thumbnail'} [kind]
   * @returns {Promise<Blob | null>} null once deleted or expired
   */
  getSnapshotImage(id, kind = "image") {
    return this.#snapshots.getBlob(id, kind);
  }

  /** @param {string} id */
  async deleteSnapshot(id) {
    await this.#snapshots.delete(id);
  }

  /** Deletes every stored snapshot, including those of earlier page sessions. */
  async deleteAllSnapshots() {
    await this.#snapshots.deleteAll();
  }

  // ---- identity: enrollment, verification, calibration -----------------------------------

  /** Collects embeddings that pass the enrollment gate and stores their template. */
  startEnrollment() {
    this.#assertIdentitySourceRunning("enroll");
    this.#identity.startEnrollment();
  }

  cancelEnrollment() {
    this.#identity.cancelEnrollment();
  }

  async deleteReference() {
    await this.#identity.deleteReference();
  }

  /**
   * One burst of embeddings of a labelled person for threshold calibration.
   *
   * @param {{ person: string, conditions?: Record<string, string> }} options use pseudonyms
   *   such as "P1" for persons
   */
  startCalibrationCapture(options) {
    this.#assertIdentitySourceRunning("capture calibration samples");
    this.#identity.startCalibrationCapture(options);
  }

  cancelCalibrationCapture() {
    this.#identity.cancelCalibrationCapture();
  }

  /** @param {string} captureId */
  async deleteCalibrationCapture(captureId) {
    await this.#identity.deleteCalibrationCapture(captureId);
  }

  async clearCalibration() {
    await this.#identity.clearCalibration();
  }

  /** Deletes the reference and every calibration sample, and the database itself. */
  async deleteAllIdentityData() {
    await this.#identity.deleteAll();
  }

  /** Writes, reads, and deletes a test record in the identity database. */
  async testIdentityStorage() {
    const result = await this.#identity.testStorage();
    this.#log(
      result.ok ? "info" : "error",
      "identity",
      `Storage test ${result.ok ? "passed" : `failed: ${result.error ?? "read-back mismatch"}`} (${result.ms.toFixed(1)} ms)`,
    );
    this.#publish();
    return result;
  }

  /**
   * @param {'enrollment' | 'verification'} kind
   * @param {Record<string, unknown>} patch
   * @throws {import('../utils/errors.js').ConfigValidationError}
   */
  updateQualityGate(kind, patch) {
    const gate = this.#identity.updateGate(kind, patch);
    this.#log("info", "identity", `${kind} gate updated: ${JSON.stringify(patch)}`);
    this.#publish();
    return gate;
  }

  /** Calibration export for the current recognizer and FACE_MISMATCH threshold; no embeddings. */
  exportCalibration() {
    const { threshold, recognizer } = this.#identityContext();
    return {
      schema: "proctoring-cv-lab/calibration@1",
      exportedAt: new Date().toISOString(),
      ...this.#identity.exportCalibration(threshold, recognizer),
    };
  }

  /** Starts a new measurement window: clears latency samples, rates, and counters. */
  resetMetrics() {
    this.#monitor.reset(this.#now());
    for (const slot of this.#slots.values()) slot.scheduler.reset();
    this.#frameSource?.resetStats();
    this.#publish();
  }

  async measureMemory() {
    this.#memoryPending = true;
    this.#publish();
    try {
      const sample = await this.#monitor.measureMemory();
      this.#log("info", "monitor", `Memory measured with ${sample.method}`);
    } catch (error) {
      this.#log("error", "monitor", `Memory measurement failed: ${describeError(error)}`);
    } finally {
      this.#memoryPending = false;
      this.#publish();
    }
  }

  async loadDeviceProfile() {
    try {
      this.#deviceProfile = await collectDeviceProfile();
    } catch (error) {
      this.#log("error", "monitor", `Device profiling failed: ${describeError(error)}`);
    }
    this.#publish();
  }

  /**
   * Everything needed to interpret a measurement run: configuration, versions, device, and
   * measured metrics. Contains no image data.
   */
  buildReport() {
    const snapshot = this.buildSnapshot();
    return {
      schema: REPORT_SCHEMA,
      exportedAt: new Date().toISOString(),
      app: {
        name: "proctoring-cv-benchmark",
        phase: LAB_PHASE,
        mode: import.meta.env?.MODE ?? "unknown",
      },
      consentAt: this.#consentAt,
      config: {
        camera: this.#config.camera,
        monitor: this.#config.monitor,
        engines: [...this.#slots.values()].map((slot) => ({
          ...slot.definition,
          scheduler: slot.scheduler.config,
          engineConfig: slot.engineConfig,
        })),
        violations: {
          ...this.#config.violations,
          rules: Object.fromEntries(
            snapshot.violations.rules.map((rule) => [rule.type, rule.config]),
          ),
        },
        // Effective gates (they can be edited live). No reference or calibration embeddings.
        identity: snapshot.identity.config,
        attention: snapshot.attention.config,
        imageQuality: snapshot.imageQuality.config,
        objects: snapshot.objects.config,
        snapshots: this.#config.snapshots,
      },
      deviceProfile: this.#deviceProfile,
      // Violation snapshots stay in the browser: the report has their count, not their list.
      snapshot: { ...snapshot, snapshots: withoutItems(snapshot.snapshots) },
    };
  }

  async dispose() {
    this.stopCamera();
    this.#snapshots.dispose();
    await Promise.allSettled([...this.#slots.values()].map((slot) => this.#unloadEngine(slot)));
    this.#camera.dispose();
    this.#listeners.clear();
    this.#resultListeners.clear();
  }

  /** Builds an immutable view of the lab state. Prefer getSnapshot() in UI code. */
  buildSnapshot() {
    const monitor = this.#monitor.getSnapshot(this.#now());
    return {
      builtAt: monitor.capturedAt,
      consentAt: this.#consentAt,
      camera: {
        ...this.#cameraState,
        frameSource: this.#frameSource ? this.#frameSource.getStats() : null,
      },
      detection: { running: this.#detectionRunning },
      engines: [...this.#slots.values()].map((slot) => ({
        id: slot.definition.id,
        kind: slot.definition.kind,
        label: slot.definition.label,
        description: slot.definition.description ?? "",
        capture: slot.definition.capture,
        scheduler: slot.scheduler.config,
        schedulerCounters: slot.scheduler.getCounters(),
        inFlight: slot.scheduler.inFlight,
        engineConfig: { ...slot.engineConfig },
        client: slot.client ? slot.client.getStatus() : null,
        busyAction: slot.busyAction,
        lastResult: slot.lastResult,
        metrics: /** @type {Record<string, any>} */ (monitor.engines)[slot.definition.id],
      })),
      monitor: {
        startedAt: monitor.startedAt,
        elapsedMs: monitor.elapsedMs,
        mainThread: monitor.mainThread,
        memory: monitor.memory,
        memoryPending: this.#memoryPending,
      },
      violations: this.#violations.getSnapshot(),
      identity: this.#identitySnapshot(),
      attention: this.#attention.getSnapshot(),
      imageQuality: this.#quality.getSnapshot(),
      objects: this.#objects.getSnapshot(),
      snapshots: this.#snapshots.getSnapshot(),
      deviceProfile: this.#deviceProfile,
      log: [...this.#logEntries],
    };
  }

  /** Identity state plus calibration results for the current threshold and recognizer. */
  #identitySnapshot() {
    const { threshold, recognizer } = this.#identityContext();
    return {
      ...this.#identity.getSnapshot(),
      calibrationResults: this.#identity.calibrationResults(threshold, recognizer),
    };
  }

  // ---- internals ------------------------------------------------------------------------

  /** @param {string} engineId */
  #slot(engineId) {
    const slot = this.#slots.get(engineId);
    if (!slot) throw new LabError(`Unknown engine "${engineId}"`, { code: "UNKNOWN_ENGINE" });
    return slot;
  }

  /**
   * Stable pipeline entry whose client delegates to whatever worker client the slot currently
   * holds, so loading, unloading, and restarting never re-register the engine.
   *
   * @param {EngineSlot} slot
   * @returns {import('../pipeline/DetectionPipeline.js').PipelineEntry}
   */
  #pipelineEntry(slot) {
    return {
      id: slot.definition.id,
      scheduler: slot.scheduler,
      capture: slot.definition.capture,
      // Image-quality engines measure the face region the face engine found last.
      ...(slot.definition.kind === "image-quality"
        ? { hints: () => ({ face: this.#faceHint }) }
        : {}),
      client: {
        get isReady() {
          return slot.client?.isReady ?? false;
        },
        detect(frame, meta) {
          if (!slot.client) {
            closeFrame(frame);
            return Promise.reject(
              new EngineStateError(`${slot.definition.id} was unloaded`, { code: "DISPOSED" }),
            );
          }
          return slot.client.detect(frame, meta);
        },
      },
    };
  }

  /** @param {EngineSlot} slot */
  async #loadEngine(slot) {
    const { definition } = slot;
    const client = new WorkerEngineClient({
      instanceId: definition.id,
      kind: definition.kind,
      engineConfig: slot.engineConfig,
      createWorker: () => this.#createWorker(definition.kind),
      initTimeoutMs: definition.initTimeoutMs,
      requestTimeoutMs: definition.requestTimeoutMs,
      now: this.#now,
    });
    slot.client = client;
    slot.busyAction = "loading";
    slot.unsubscribeClient = client.onEvent((event) => this.#onClientEvent(slot, event));
    this.#publish();
    try {
      const status = await client.initialize();
      this.#monitor.recordInit(definition.id, status);
      this.#log(
        "info",
        definition.id,
        `Engine ready after ${formatMs(status.spawnToReadyMs)} (provider: ${status.executionProvider ?? "unknown"})`,
      );
    } catch (error) {
      this.#log("error", definition.id, `Initialization failed: ${describeError(error)}`);
    } finally {
      slot.busyAction = null;
      this.#publish();
    }
  }

  /** @param {EngineSlot} slot */
  async #unloadEngine(slot) {
    const client = slot.client;
    if (!client) return;
    if (slot.definition.id === this.#violations.sourceEngineId) {
      this.#violations.interrupt("data-gap");
    }
    if (slot.definition.id === this.#objects.sourceEngineId) {
      this.#violations.interruptObjectRules("data-gap");
    }
    slot.client = null;
    slot.busyAction = "unloading";
    this.#publish();
    try {
      await client.dispose();
      this.#log("info", slot.definition.id, "Engine unloaded; worker terminated");
    } catch (error) {
      this.#log("error", slot.definition.id, `Unload failed: ${describeError(error)}`);
    } finally {
      slot.unsubscribeClient?.();
      slot.unsubscribeClient = null;
      slot.busyAction = null;
      this.#publish();
    }
  }

  /**
   * @param {EngineSlot} slot
   * @param {import('../workers/WorkerEngineClient.js').ClientEvent} event
   */
  #onClientEvent(slot, event) {
    if (event.type === "hang") {
      this.#log("error", slot.definition.id, `${describeError(event.error)}. Restart the engine.`);
    } else if (event.type === "worker-error") {
      this.#logThrottled("error", slot.definition.id, "worker-error", describeError(event.error));
    } else if (event.type === "egress-blocked") {
      const known = KNOWN_OUTBOUND_ENDPOINTS.find((entry) =>
        event.request.url.startsWith(entry.prefix),
      );
      this.#logThrottled(
        "warn",
        slot.definition.id,
        "egress-blocked",
        `Blocked a request from the worker to ${event.request.url} (${event.request.api})` +
          (known ? `: ${known.description}` : ""),
      );
    }
    this.#dirty = true;
  }

  /** @param {import('../pipeline/DetectionPipeline.js').PipelineEvent} event */
  #onPipelineEvent(event) {
    const slot = this.#slots.get(event.engineId);
    if (!slot) return;
    if (event.type === "result") {
      slot.lastResult = {
        at: event.receivedAt,
        frameId: event.result.frameId,
        processingTimeMs: event.result.processingTimeMs,
        observations: event.result.observations,
        timing: event.timing,
      };
      // Results of a frame dispatched before detection stopped can still arrive; violations
      // are only evaluated while detection runs.
      if (this.#detectionRunning) {
        this.#violations.observe(event.result);
        if (event.engineId === this.#identity.sourceEngineId) {
          const sample = this.#identity.observe(event.result);
          if (sample) this.#violations.observeIdentity(sample);
        }
        if (event.engineId === this.#attention.sourceEngineId) {
          const sample = this.#attention.observe(event.result);
          if (sample) this.#violations.observeAttention(sample);
        }
        if (event.engineId === this.#quality.faceSourceEngineId) {
          this.#faceHint = faceHintFrom(event.result);
        }
        if (event.engineId === this.#quality.sourceEngineId) {
          const sample = this.#quality.observe(event.result);
          if (sample) this.#violations.observeQuality(sample);
        }
        if (OBJECT_ENGINE_KINDS.includes(slot.definition.kind)) {
          const sample = this.#objects.observe(event.result, this.#violations.objectRuleLimits());
          if (sample) this.#violations.observeObjects(sample);
        }
      }
      const notice = {
        engineId: event.engineId,
        result: event.result,
        receivedAt: event.receivedAt,
      };
      for (const listener of this.#resultListeners) {
        try {
          listener(notice);
        } catch (error) {
          console.error("Result listener failed", error);
        }
      }
    } else if (event.type === "error") {
      this.#logThrottled(
        "error",
        event.engineId,
        "frame-error",
        `Frame ${event.frameId} failed: ${describeError(event.error)}`,
      );
    } else if (event.type === "dropped") {
      this.#logThrottled(
        "warn",
        event.engineId,
        `dropped-${event.reason}`,
        `Frame ${event.frameId} dropped (${event.reason})`,
      );
    }
    this.#dirty = true;
  }

  /** @param {import('../pipeline/ViolationEngine.js').ViolationEvent} event */
  #onViolationEvent({ type, violation }) {
    const seconds = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} s`;
    if (type === "violation-start") {
      const toward = violation.direction ? ` toward the ${violation.direction}` : "";
      // Angles measured against a learned baseline use the default screen size.
      const against = violation.baseline === "learned" ? ", uncalibrated" : "";
      /** @type {Record<string, string>} */
      const conditions = {
        NO_FACE: "no face",
        FACE_MISMATCH: `similarity to the reference down to ${violation.minSimilarity?.toFixed(3)}`,
        GAZE_AWAY: `gaze up to ${violation.maxExcessDeg}° outside the screen area${toward}`,
        HEAD_TURNED: `head up to ${violation.maxExcessDeg}° beyond the limit${toward}`,
        EYES_CLOSED: `eyes closed, blink score up to ${violation.maxClosure}`,
        LIGHTING_ISSUE: `lighting: ${(violation.reasons ?? []).join(", ")}`,
        PHONE_DETECTED: `${violation.label} at score up to ${violation.maxScore}`,
      };
      const condition = conditions[violation.type] ?? `${violation.maxFaceCount} faces`;
      this.#log(
        "warn",
        "violations",
        `${violation.type} started (${condition} for ${seconds(violation.confirmedAt - violation.startedAt)}, severity ${violation.severity}${against})`,
      );
      this.#snapshots.capture(this.#video, violation);
    } else if (type === "violation-escalated") {
      this.#log(
        "warn",
        "violations",
        `${violation.type} still active after ${seconds(violation.durationMs)}: severity raised to ${violation.severity}`,
      );
      void this.#snapshots.updateViolation(violation);
    } else {
      this.#log(
        "info",
        "violations",
        `${violation.type} ended after ${seconds(violation.durationMs)} (${violation.endReason})`,
      );
      void this.#snapshots.updateViolation(violation);
    }
    // Violations are rare (a few a minute), so each change is shown at once instead of waiting
    // up to uiRefreshIntervalMs for the next refresh.
    this.#publish();
  }

  /** @param {import('../snapshots/SnapshotManager.js').SnapshotEvent} event */
  #onSnapshotEvent(event) {
    if (event.type === "log") {
      this.#log(event.level, "snapshots", event.message);
      return;
    }
    // A snapshot was stored, updated, or deleted: at most a few a minute.
    this.#publish();
  }

  /** The running camera's label and resolution, or null. */
  #cameraInfo() {
    const track = this.#cameraState.track;
    return track
      ? { label: track.label, width: track.settings.width, height: track.settings.height }
      : null;
  }

  /** @param {import('../identity/IdentityManager.js').IdentityEvent} event */
  #onIdentityEvent(event) {
    if (event.type === "log") {
      this.#log(event.level, "identity", event.message);
    } else if (event.type === "reference-changed") {
      // A FACE_MISMATCH measured against the old reference says nothing about the new one.
      this.#violations.interruptRule("FACE_MISMATCH", "reference-changed");
    }
    // Identity changes come from user actions or accepted samples (at most a few per second).
    this.#publish();
  }

  /** @param {import('../attention/AttentionManager.js').AttentionEvent} event */
  #onAttentionEvent(event) {
    if (event.type === "log") {
      this.#log(event.level, "attention", event.message);
    } else if (event.type === "profile-changed") {
      // Angles measured against the old baseline say nothing about the new one.
      for (const type of PRESET_RULE_TYPES) {
        this.#violations.interruptRule(type, "baseline-changed");
      }
    }
    this.#dirty = true;
    if (event.type === "calibration") {
      // Publish at once when the dot moves or the run ends, so the settle time is not spent
      // waiting for the next UI refresh; phase changes within a target can wait.
      const { status, index, attempt } = event.state;
      const key = `${status}:${index}:${attempt}`;
      if (key === this.#calibrationKey) return;
      this.#calibrationKey = key;
    }
    this.#publish();
  }

  /** @param {string} action */
  #assertIdentitySourceRunning(action) {
    const slot = this.#slots.get(this.#identity.sourceEngineId);
    if (!slot?.client?.isReady || !slot.scheduler.config.enabled) {
      throw new LabError(
        `Load the ${slot?.definition.label ?? "face verification"} engine to ${action}`,
        {
          code: "ENGINE_NOT_READY",
        },
      );
    }
    if (!this.#detectionRunning) {
      throw new LabError(`Start detection to ${action}`, { code: "DETECTION_NOT_RUNNING" });
    }
  }

  /** Threshold and recognizer that calibration results refer to. */
  #identityContext() {
    const slot = this.#slots.get(this.#identity.sourceEngineId);
    const rule = this.#violations
      .getSnapshot()
      .rules.find((candidate) => candidate.type === "FACE_MISMATCH");
    return {
      threshold: /** @type {number} */ (rule?.config.similarityThreshold),
      recognizer: String(
        slot?.engineConfig.recognizerModel ?? DEFAULT_FACE_VERIFIER_CONFIG.recognizerModel,
      ),
    };
  }

  /** @param {import('../benchmark/PerformanceMonitor.js').MainThreadEvent} event */
  #onMainThreadEvent(event) {
    if (event.type === "page") {
      this.#log("info", "monitor", PAGE_EVENT_MESSAGES[event.event.type]);
      if (event.event.type === "hidden" || event.event.type === "visible") {
        this.#violations.setPageHidden(event.event.type === "hidden", event.event.at);
      }
      return;
    }
    const { stall } = event;
    const duration = `${Math.round(stall.durationMs)} ms`;
    if (stall.pageHiddenDuringGap) {
      this.#logThrottled(
        "info",
        "monitor",
        "hidden-page-gap",
        `Timers were delayed ${duration} while the page was hidden (browser throttling; not counted as a stall)`,
      );
    } else {
      this.#logThrottled(
        "warn",
        "monitor",
        "stall",
        `Main thread unavailable for ${duration}${stall.windowBlurredDuringGap ? " (window not focused)" : ""}`,
      );
    }
  }

  /** @param {import('../capture/CameraManager.js').CameraEvent} event */
  #onCameraEvent(event) {
    if (event.type === "devicechange") {
      if (this.#consentAt) void this.refreshDevices();
      return;
    }
    if (event.type === "ended") {
      this.#log(
        "error",
        "camera",
        "Camera track ended (device disconnected or permission revoked)",
      );
      this.stopCamera();
      this.#cameraState = {
        ...this.#cameraState,
        status: "error",
        error: serializeError(
          new LabError("The camera track ended unexpectedly", { code: "TRACK_ENDED" }),
        ),
      };
    } else {
      this.#log(event.type === "mute" ? "warn" : "info", "camera", `Camera track ${event.type}d`);
      this.#cameraState = { ...this.#cameraState, track: this.#camera.getTrackInfo() };
    }
    this.#publish();
  }

  #teardownCapture() {
    this.#pipeline?.stop();
    this.#unsubscribePipeline?.();
    this.#unsubscribePipeline = null;
    this.#pipeline = null;
    this.#frameSource?.stop();
    this.#frameSource = null;
  }

  #startRefreshTimer() {
    if (this.#refreshTimer !== null) return;
    this.#refreshTimer = setInterval(() => {
      // Ends violations whose source engine went silent (stalled, restarting, page hidden).
      if (this.#detectionRunning) this.#violations.tick(this.#now());
      this.#identity.tick(this.#now());
      this.#attention.tick();
      if (this.#dirty || this.#detectionRunning) this.#publish();
    }, this.#config.monitor.uiRefreshIntervalMs);
  }

  #stopRefreshTimer() {
    if (this.#refreshTimer !== null) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
  }

  /**
   * @param {LogEntry['level']} level
   * @param {string} source
   * @param {string} message
   */
  #log(level, source, message) {
    this.#logEntries.push({ at: this.#now(), level, source, message });
    if (this.#logEntries.length > MAX_LOG_ENTRIES) this.#logEntries.shift();
    if (level === "error") console.error(`[${source}] ${message}`);
    this.#dirty = true;
  }

  /**
   * Logs at most one message per (source, key) every LOG_THROTTLE_MS and reports how many
   * similar messages were suppressed, so a failing engine cannot flood the log.
   *
   * @param {LogEntry['level']} level
   * @param {string} source
   * @param {string} key
   * @param {string} message
   */
  #logThrottled(level, source, key, message) {
    const id = `${source}|${key}`;
    const now = this.#now();
    const state = this.#logThrottle.get(id);
    if (state && now - state.at < LOG_THROTTLE_MS) {
      state.suppressed += 1;
      return;
    }
    const suffix = state?.suppressed ? ` (+${state.suppressed} similar suppressed)` : "";
    this.#logThrottle.set(id, { at: now, suppressed: 0 });
    this.#log(level, source, `${message}${suffix}`);
  }

  #publish() {
    this.#dirty = false;
    this.#snapshot = this.buildSnapshot();
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Snapshot state without the list of snapshots.
 *
 * @param {ReturnType<SnapshotManager['getSnapshot']>} snapshots
 */
function withoutItems({ items: _items, ...rest }) {
  return rest;
}

/** @param {number | null | undefined} value */
function formatMs(value) {
  return Number.isFinite(value) ? `${/** @type {number} */ (value).toFixed(1)} ms` : "n/a";
}

/**
 * The primary face of a face-engine result as a hint for image-quality engines: its box
 * (normalized to the frame) and the frame's capture time. `box` is null when the result had no
 * face; null when the result has no FACE_COUNT.
 *
 * @param {import('../engines/EngineContract.js').DetectionResult} result
 * @returns {import('../engines/quality/ImageQualityEngine.js').FaceHint | null}
 */
export function faceHintFrom(result) {
  const count = result.observations.find((o) => o.type === "FACE_COUNT");
  if (typeof count?.value !== "number") return null;
  const faces = result.observations.filter((o) => o.type === "FACE");
  const primary = faces.find((o) => o.metadata?.primary === true) ?? faces[0];
  const box = /** @type {any} */ (primary?.metadata)?.box ?? null;
  return {
    box: box ? { ...box } : null,
    at: result.frameCaptureTime,
    sourceEngineId: result.engine,
  };
}
