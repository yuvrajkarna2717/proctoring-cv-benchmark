import { MODEL_ASSETS } from "../../config/modelAssets.js";
import { LabError, describeError } from "../../utils/errors.js";
import { parseConfig } from "../../utils/validation.js";
import { BaseDetectionEngine } from "../BaseDetectionEngine.js";
import { FaceLandmarkerConfigSchema } from "./faceLandmarkerConfig.js";
import { blendshapeScore, eyeMeasures, gazeAngles, headPoseFromMatrix } from "./faceGeometry.js";

const MODEL = MODEL_ASSETS["mp-face-landmarker"];

/** Options MediaPipe applies with setOptions() without recreating the task. */
const LIVE_OPTIONS = /** @type {const} */ ([
  "numFaces",
  "minFaceDetectionConfidence",
  "minFacePresenceConfidence",
  "minTrackingConfidence",
  "outputFaceBlendshapes",
  "outputFacialTransformationMatrixes",
]);

/** Options that need a new task instance (and a new WebGL context for GPU). */
const RECREATE_OPTIONS = /** @type {const} */ (["delegate", "allowCpuFallback"]);

/**
 * Operations the engine needs from MediaPipe and the network. The worker injects the real
 * implementation (mediapipeRuntime.js); unit tests inject fakes.
 *
 * @typedef {Object} FaceLandmarkerRuntime
 * @property {string} version runtime identity, e.g. "@mediapipe/tasks-vision@1.2.2"
 * @property {(asset: import('../../config/modelAssets.js').ModelAsset) => Promise<Uint8Array>} loadModel
 * @property {(bytes: Uint8Array) => Promise<string>} sha256 lowercase hex digest
 * @property {(options: Record<string, unknown>) => Promise<FaceLandmarkerTask>} createFaceLandmarker
 * @property {(width: number, height: number) => unknown} createBlankImage image for warm-up
 *
 * @typedef {Object} FaceLandmarkerTask the subset of MediaPipe's FaceLandmarker that is used
 * @property {(image: unknown, timestampMs: number) => MediaPipeFaceResult} detectForVideo
 * @property {(options: Record<string, unknown>) => Promise<void>} setOptions
 * @property {() => void} close
 *
 * @typedef {{ x: number, y: number, z: number }} NormalizedLandmark
 * @typedef {Object} MediaPipeFaceResult
 * @property {NormalizedLandmark[][]} faceLandmarks
 * @property {Array<{ categories: Array<{ score: number, categoryName: string }> }>} [faceBlendshapes]
 * @property {Array<{ rows: number, columns: number, data: number[] }>} [facialTransformationMatrixes]
 *
 * @typedef {Object} FaceBox normalized to the transferred image, clamped to [0, 1]
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 *
 * @typedef {Object} FaceLandmarksPayload engine-specific payload of a face-landmarker result
 * @property {'mediapipe-face-landmarks'} format
 * @property {number} imageWidth width of the image the coordinates are normalized to
 * @property {number} imageHeight
 * @property {Array<{ box: FaceBox, truncated: boolean, landmarks: Float32Array | null }>} faces
 *   `landmarks` holds x, y, z per landmark (normalized x/y, relative depth z)
 * @property {Array<{ names: string[], scores: Float32Array }>=} blendshapes
 * @property {Array<{ rows: number, columns: number, data: Float32Array }>=} transformationMatrices
 */

/**
 * MediaPipe Face Landmarker (BlazeFace short-range detector, Face Mesh V2 with 478 landmarks)
 * in VIDEO mode.
 *
 * Observations per frame:
 * - `FACE_COUNT`: number of faces found, at most `numFaces`. MediaPipe reports no per-face score,
 *   so no confidence is attached.
 * - `FACE` per face: bounding box computed from the landmarks, and whether landmarks fell outside
 *   the image (face partly out of frame).
 *
 * The landmark coordinates travel in the result payload as Float32Arrays, transferred without a
 * copy, for the overlay and for later phases (head pose, gaze).
 */
export class FaceLandmarkerEngine extends BaseDetectionEngine {
  static kind = "face-landmarker";

  /** @type {import('./faceLandmarkerConfig.js').FaceLandmarkerConfig} */
  #options;
  /** @type {FaceLandmarkerRuntime} */
  #runtime;
  /** @type {FaceLandmarkerTask | null} */
  #task = null;
  /** @type {Uint8Array | null} kept so a delegate change does not download the model again */
  #modelBytes = null;
  /** @type {string | null} */
  #modelSha256 = null;
  /** @type {'GPU' | 'CPU' | null} delegate of the current task */
  #delegate = null;
  /** @type {string | null} why the requested GPU delegate was not used */
  #fallbackReason = null;
  /** @type {{ delegate: 'GPU' | 'CPU', createMs: number, warmupMs: number | null } | null} */
  #lastTaskCreation = null;
  #lastTimestamp = -Infinity;

  /**
   * @param {Record<string, unknown>} config
   * @param {{ now?: () => number, runtime?: FaceLandmarkerRuntime }} [dependencies]
   */
  constructor(config, { runtime, ...dependencies } = {}) {
    const options = parseConfig(
      FaceLandmarkerConfigSchema,
      config,
      "face landmarker configuration",
    );
    super(options, dependencies);
    if (!runtime) {
      throw new LabError("FaceLandmarkerEngine needs a MediaPipe runtime", {
        code: "RUNTIME_MISSING",
      });
    }
    this.#options = options;
    this.#runtime = runtime;
  }

  async onInitialize() {
    const fetchStartedAt = this.now();
    const bytes = await this.#runtime.loadModel(MODEL);
    const sha256 = await this.#runtime.sha256(bytes);
    if (bytes.byteLength !== MODEL.bytes || sha256 !== MODEL.sha256) {
      throw new LabError(
        `${MODEL.file} failed verification: ${bytes.byteLength} bytes, sha256 ${sha256}; ` +
          `expected ${MODEL.bytes} bytes, sha256 ${MODEL.sha256}. Run: npm run fetch-models`,
        { code: "MODEL_INTEGRITY" },
      );
    }
    this.#modelBytes = bytes;
    this.#modelSha256 = sha256;
    const modelFetchMs = this.now() - fetchStartedAt;

    const creation = await this.#createTask();
    this.#task = creation.task;
    return {
      modelFetchMs,
      modelInitMs: creation.createMs,
      ...(creation.warmupMs === null ? {} : { warmupMs: creation.warmupMs }),
    };
  }

  /**
   * @param {ImageBitmap | VideoFrame} frame
   * @param {import('../EngineContract.js').FrameMeta} meta
   * @param {import('../EngineContract.js').StageTimer} timer
   */
  async onDetect(frame, meta, timer) {
    const task = /** @type {FaceLandmarkerTask} */ (this.#task);
    const { numFaces, includeLandmarks } = this.#options;

    timer.start("preprocess");
    const timestamp = this.#nextTimestamp(meta.captureTime);

    // MediaPipe uploads, resizes, and runs both models inside this call.
    timer.start("inference");
    const result = task.detectForVideo(frame, timestamp);

    timer.start("postprocess");
    const faces = result.faceLandmarks.map((landmarks) =>
      summarizeFace(landmarks, includeLandmarks),
    );
    const primary = largestFaceIndex(faces);
    /** @type {import('../EngineContract.js').Observation[]} */
    const observations = [
      {
        type: "FACE_COUNT",
        detected: faces.length > 0,
        value: faces.length,
        metadata: { maxFaces: numFaces },
      },
      ...faces.map((face, index) => ({
        type: "FACE",
        detected: true,
        value: index,
        metadata: {
          box: face.box,
          truncated: face.truncated,
          landmarkCount: face.landmarkCount,
          primary: index === primary,
        },
      })),
      ...(primary === -1 ? [] : attentionObservations(result, primary, meta, this.#options)),
    ];
    /** @type {FaceLandmarksPayload} */
    const payload = {
      format: "mediapipe-face-landmarks",
      imageWidth: meta.width,
      imageHeight: meta.height,
      faces: faces.map(({ box, truncated, landmarks }) => ({ box, truncated, landmarks })),
    };
    if (this.#options.outputFaceBlendshapes && result.faceBlendshapes) {
      payload.blendshapes = result.faceBlendshapes.map(({ categories }) => ({
        names: categories.map((category) => category.categoryName),
        scores: Float32Array.from(categories, (category) => category.score),
      }));
    }
    if (this.#options.outputFacialTransformationMatrixes && result.facialTransformationMatrixes) {
      payload.transformationMatrices = result.facialTransformationMatrixes.map((matrix) => ({
        rows: matrix.rows,
        columns: matrix.columns,
        data: Float32Array.from(matrix.data),
      }));
    }
    return { observations, payload };
  }

  /** @param {Record<string, unknown>} patch */
  async onConfigure(patch) {
    const next = parseConfig(
      FaceLandmarkerConfigSchema,
      { ...this.#options, ...patch },
      "face landmarker configuration",
    );
    const previous = this.#options;
    const recreate = RECREATE_OPTIONS.some((key) => next[key] !== previous[key]);
    const live = LIVE_OPTIONS.some((key) => next[key] !== previous[key]);
    this.#options = next;
    try {
      if (recreate) {
        // Create the replacement first so a failure leaves the working task in place.
        const creation = await this.#createTask();
        this.#task?.close();
        this.#task = creation.task;
      } else if (live && this.#task) {
        await this.#task.setOptions(this.#liveOptions());
      }
    } catch (error) {
      this.#options = previous;
      throw error;
    }
    return { ...this.#options };
  }

  async onDispose() {
    this.#task?.close();
    this.#task = null;
    this.#modelBytes = null;
  }

  getModelInfo() {
    return {
      id: MODEL.id,
      version: MODEL.version,
      runtime: this.#runtime.version,
      file: MODEL.file,
      ...(this.#modelSha256 ? { sha256: this.#modelSha256 } : {}),
    };
  }

  getExecutionProvider() {
    return this.#delegate ? `mediapipe-${this.#delegate.toLowerCase()}` : null;
  }

  getStatusDetails() {
    return {
      requestedDelegate: this.#options.delegate,
      delegate: this.#delegate,
      fallbackReason: this.#fallbackReason,
      lastTaskCreation: this.#lastTaskCreation,
    };
  }

  /**
   * Creates a task with the requested delegate, falling back to CPU if allowed, and warms it up.
   * Does not replace the current task; the caller does.
   *
   * @returns {Promise<{ task: FaceLandmarkerTask, createMs: number, warmupMs: number | null }>}
   */
  async #createTask() {
    const requested = this.#options.delegate;
    const startedAt = this.now();
    /** @type {FaceLandmarkerTask} */
    let task;
    /** @type {'GPU' | 'CPU'} */
    let delegate = requested;
    /** @type {string | null} */
    let fallbackReason = null;
    try {
      task = await this.#runtime.createFaceLandmarker(this.#taskOptions(requested));
    } catch (error) {
      if (requested !== "GPU" || !this.#options.allowCpuFallback) throw error;
      fallbackReason = describeError(error);
      delegate = "CPU";
      task = await this.#runtime.createFaceLandmarker(this.#taskOptions("CPU"));
    }
    const createMs = this.now() - startedAt;
    let warmupMs = null;
    if (this.#options.warmup) {
      const warmupStartedAt = this.now();
      task.detectForVideo(this.#runtime.createBlankImage(64, 64), this.#nextTimestamp(this.now()));
      warmupMs = this.now() - warmupStartedAt;
    }
    this.#delegate = delegate;
    this.#fallbackReason = fallbackReason;
    this.#lastTaskCreation = { delegate, createMs, warmupMs };
    return { task, createMs, warmupMs };
  }

  /** @param {'GPU' | 'CPU'} delegate */
  #taskOptions(delegate) {
    return {
      baseOptions: { modelAssetBuffer: this.#modelBytes, delegate },
      runningMode: "VIDEO",
      ...this.#liveOptions(),
    };
  }

  #liveOptions() {
    return Object.fromEntries(LIVE_OPTIONS.map((key) => [key, this.#options[key]]));
  }

  /**
   * VIDEO mode requires strictly increasing timestamps. Camera capture times keep the real
   * spacing between frames, which the landmark tracking uses; a frame whose time is not later
   * than the previous one (possible with fallback-timer ticks) gets the previous time + 1 ms.
   *
   * @param {number} time epoch ms
   */
  #nextTimestamp(time) {
    const timestamp = Math.max(Math.round(time), this.#lastTimestamp + 1);
    this.#lastTimestamp = timestamp;
    return timestamp;
  }
}

/**
 * Bounding box and flat coordinate array of one face.
 *
 * @param {NormalizedLandmark[]} landmarks
 * @param {boolean} includeLandmarks
 */
export function summarizeFace(landmarks, includeLandmarks) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const coordinates = includeLandmarks ? new Float32Array(landmarks.length * 3) : null;
  for (let index = 0; index < landmarks.length; index += 1) {
    const { x, y, z } = landmarks[index];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (coordinates) {
      coordinates[index * 3] = x;
      coordinates[index * 3 + 1] = y;
      coordinates[index * 3 + 2] = z;
    }
  }
  const left = clamp01(minX);
  const top = clamp01(minY);
  return {
    box: { x: left, y: top, width: clamp01(maxX) - left, height: clamp01(maxY) - top },
    truncated: minX < 0 || minY < 0 || maxX > 1 || maxY > 1,
    landmarkCount: landmarks.length,
    landmarks: coordinates,
  };
}

/** @param {number} value */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * The face with the largest box, the one attention measurements describe; -1 without faces.
 *
 * @param {Array<{ box: FaceBox }>} faces
 */
export function largestFaceIndex(faces) {
  let best = -1;
  let bestArea = -1;
  faces.forEach(({ box }, index) => {
    const area = box.width * box.height;
    if (area > bestArea) {
      best = index;
      bestArea = area;
    }
  });
  return best;
}

/** A blink score above this makes that eye's iris position unreliable. */
const IRIS_BLINK_LIMIT = 0.5;

/**
 * HEAD_POSE, EYE_GAZE, and EYE_STATE observations of one face (measurements only; whether they
 * mean "looking away" is decided on the main thread against the person's calibration).
 *
 * - HEAD_POSE needs the transformation matrix; `detected` is false without it.
 * - EYE_GAZE: gaze direction relative to the camera (head and eyes together) from the iris
 *   rings and the head pose, and the eyes' part of it. An eye whose blink score is above 0.5
 *   is left out; `detected` is false when no eye is usable.
 * - EYE_STATE: blink blendshapes (MediaPipe's names) and the eye aspect ratio of each eye.
 *
 * @param {MediaPipeFaceResult} result
 * @param {number} faceIndex
 * @param {{ width: number, height: number }} image
 * @param {import('./faceLandmarkerConfig.js').FaceLandmarkerConfig} options
 * @returns {import('../EngineContract.js').Observation[]}
 */
export function attentionObservations(result, faceIndex, image, options) {
  const landmarks = result.faceLandmarks[faceIndex];
  const flat = new Float32Array(landmarks.length * 3);
  landmarks.forEach(({ x, y, z }, index) => {
    flat[index * 3] = x;
    flat[index * 3 + 1] = y;
    flat[index * 3 + 2] = z;
  });
  const matrix = options.outputFacialTransformationMatrixes
    ? result.facialTransformationMatrixes?.[faceIndex]
    : undefined;
  const pose = matrix ? headPoseFromMatrix(matrix.data) : null;
  const categories = options.outputFaceBlendshapes
    ? result.faceBlendshapes?.[faceIndex]?.categories
    : undefined;
  const blendshapes = categories
    ? { names: categories.map((c) => c.categoryName), scores: categories.map((c) => c.score) }
    : undefined;
  const eyes = eyeMeasures(flat, image.width, image.height);

  const blinkLeft = blendshapeScore(blendshapes, "eyeBlinkLeft");
  const blinkRight = blendshapeScore(blendshapes, "eyeBlinkRight");
  /** @type {Array<'left' | 'right'>} */
  const skip = [];
  if (blinkLeft !== null && blinkLeft > IRIS_BLINK_LIMIT) skip.push("left");
  if (blinkRight !== null && blinkRight > IRIS_BLINK_LIMIT) skip.push("right");
  const gaze = eyes && pose ? gazeAngles(eyes, pose, { skip }) : null;

  return [
    {
      type: "HEAD_POSE",
      detected: pose !== null,
      value: faceIndex,
      metadata: pose
        ? {
            yawDeg: round(pose.yawDeg, 2),
            pitchDeg: round(pose.pitchDeg, 2),
            rollDeg: round(pose.rollDeg, 2),
            distanceCm: pose.distanceCm === null ? null : round(pose.distanceCm, 1),
            layout: pose.layout,
          }
        : { reason: matrix ? "malformed matrix" : "transformation matrix not requested" },
    },
    {
      type: "EYE_GAZE",
      detected: gaze !== null,
      value: faceIndex,
      metadata: gaze
        ? {
            yawDeg: round(gaze.yawDeg, 2),
            pitchDeg: round(gaze.pitchDeg, 2),
            eyeYawDeg: round(gaze.eyeYawDeg, 2),
            eyePitchDeg: round(gaze.eyePitchDeg, 2),
            irisX: round(gaze.irisX, 4),
            irisY: round(gaze.irisY, 4),
            eyes: 2 - skip.length,
            eyeWidthPx: eyes ? round(Math.min(eyes.left.widthPx, eyes.right.widthPx), 1) : null,
          }
        : {
            reason: !pose
              ? "no head pose"
              : !eyes
                ? "no eye landmarks"
                : skip.length === 2
                  ? "both eyes closing"
                  : "no iris landmarks",
          },
    },
    {
      type: "EYE_STATE",
      detected: eyes !== null,
      value: faceIndex,
      metadata: {
        blinkLeft: blinkLeft === null ? null : round(blinkLeft, 3),
        blinkRight: blinkRight === null ? null : round(blinkRight, 3),
        earLeft: eyes ? round(eyes.left.ear, 4) : null,
        earRight: eyes ? round(eyes.right.ear, 4) : null,
        interocularPx: eyes ? round(eyes.interocularPx, 1) : null,
      },
    },
  ];
}

/**
 * @param {number} value
 * @param {number} digits
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
