import { CameraError } from "../utils/errors.js";

/**
 * @typedef {Object} VideoInputDevice
 * @property {string} deviceId
 * @property {string} label empty until camera permission has been granted once
 * @property {string} groupId
 *
 * @typedef {Object} CameraTrackInfo
 * @property {string} label
 * @property {'live'|'ended'} readyState
 * @property {boolean} muted
 * @property {MediaTrackSettings} settings what the browser actually delivers
 * @property {MediaTrackCapabilities | null} capabilities null where getCapabilities() is unsupported
 *
 * @typedef {{ type: 'ended' | 'mute' | 'unmute' | 'devicechange', track?: CameraTrackInfo }} CameraEvent
 */

/** Maps getUserMedia DOMException names to stable reason codes. */
const ERROR_CODES = {
  NotAllowedError: "PERMISSION_DENIED",
  PermissionDeniedError: "PERMISSION_DENIED",
  SecurityError: "PERMISSION_DENIED",
  NotFoundError: "DEVICE_NOT_FOUND",
  DevicesNotFoundError: "DEVICE_NOT_FOUND",
  NotReadableError: "DEVICE_BUSY",
  TrackStartError: "DEVICE_BUSY",
  OverconstrainedError: "CONSTRAINTS_NOT_SATISFIABLE",
  AbortError: "ABORTED",
  TypeError: "INVALID_CONSTRAINTS",
};

const ERROR_HINTS = {
  PERMISSION_DENIED: "Camera permission was denied. Allow camera access for this site and retry.",
  DEVICE_NOT_FOUND: "No camera matching the selection was found.",
  DEVICE_BUSY: "The camera could not be started. Another application may be using it.",
  CONSTRAINTS_NOT_SATISFIABLE: "The selected camera does not support the requested settings.",
  ABORTED: "Camera start was aborted by the browser or operating system.",
  INVALID_CONSTRAINTS: "The camera constraints are invalid.",
};

/**
 * Owns the camera MediaStream: device enumeration, start/stop, and track lifecycle events.
 * It does not touch the DOM; attaching the stream to a <video> element is the caller's job.
 */
export class CameraManager {
  /** @type {MediaDevices | undefined} */
  #mediaDevices;
  /** @type {MediaStream | null} */
  #stream = null;
  /** @type {Set<(event: CameraEvent) => void>} */
  #listeners = new Set();
  /** @type {(() => void) | null} */
  #detachTrackListeners = null;
  #onDeviceChange = () => this.#emit({ type: "devicechange" });

  /** @param {{ mediaDevices?: MediaDevices }} [options] */
  constructor({ mediaDevices = globalThis.navigator?.mediaDevices } = {}) {
    this.#mediaDevices = mediaDevices;
    this.#mediaDevices?.addEventListener?.("devicechange", this.#onDeviceChange);
  }

  /** @returns {boolean} false outside secure contexts or in browsers without getUserMedia */
  get isSupported() {
    return typeof this.#mediaDevices?.getUserMedia === "function";
  }

  /** @returns {boolean} */
  get isActive() {
    return this.#stream?.getVideoTracks().some((track) => track.readyState === "live") ?? false;
  }

  /** @returns {MediaStream | null} */
  get stream() {
    return this.#stream;
  }

  /**
   * @param {(event: CameraEvent) => void} listener
   * @returns {() => void} unsubscribe
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @returns {Promise<VideoInputDevice[]>} */
  async listVideoInputs() {
    this.#assertSupported();
    const devices = await this.#mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "videoinput")
      .map(({ deviceId, label, groupId }) => ({ deviceId, label, groupId }));
  }

  /**
   * Starts (or restarts) the camera. Resolution and frame rate are `ideal` constraints, so the
   * browser picks the closest supported mode; read the actual mode from the returned settings.
   *
   * @param {{ deviceId?: string | null, width: number, height: number, frameRate: number }} options
   * @returns {Promise<{ stream: MediaStream, track: CameraTrackInfo }>}
   */
  async start({ deviceId = null, width, height, frameRate }) {
    this.#assertSupported();
    this.stop();
    /** @type {MediaStreamConstraints} */
    const constraints = {
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: frameRate },
      },
    };
    let stream;
    try {
      stream = await this.#mediaDevices.getUserMedia(constraints);
    } catch (error) {
      throw toCameraError(error);
    }
    const [track] = stream.getVideoTracks();
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new CameraError("The camera stream contains no video track", {
        code: "NO_VIDEO_TRACK",
      });
    }
    this.#stream = stream;
    this.#attachTrackListeners(track);
    return { stream, track: /** @type {CameraTrackInfo} */ (this.getTrackInfo()) };
  }

  /**
   * Stops every track and releases the stream. Safe to call when already stopped.
   *
   * @returns {Array<'live'|'ended'>} final readyState of each released track (all "ended")
   */
  stop() {
    if (!this.#stream) return [];
    this.#detachTrackListeners?.();
    this.#detachTrackListeners = null;
    const tracks = this.#stream.getTracks();
    tracks.forEach((track) => track.stop());
    this.#stream = null;
    return tracks.map((track) => track.readyState);
  }

  /** @returns {CameraTrackInfo | null} */
  getTrackInfo() {
    const track = this.#stream?.getVideoTracks()[0];
    if (!track) return null;
    return {
      label: track.label,
      readyState: track.readyState,
      muted: track.muted,
      settings: track.getSettings(),
      capabilities: typeof track.getCapabilities === "function" ? track.getCapabilities() : null,
    };
  }

  /** Stops the camera and removes global listeners. */
  dispose() {
    this.stop();
    this.#mediaDevices?.removeEventListener?.("devicechange", this.#onDeviceChange);
    this.#listeners.clear();
  }

  #assertSupported() {
    if (!this.isSupported) {
      throw new CameraError(
        "Camera capture is unavailable. getUserMedia requires a secure context (https or localhost).",
        { code: "UNSUPPORTED" },
      );
    }
  }

  /** @param {MediaStreamTrack} track */
  #attachTrackListeners(track) {
    const onEnded = () => this.#emit({ type: "ended", track: this.getTrackInfo() ?? undefined });
    const onMute = () => this.#emit({ type: "mute", track: this.getTrackInfo() ?? undefined });
    const onUnmute = () => this.#emit({ type: "unmute", track: this.getTrackInfo() ?? undefined });
    track.addEventListener("ended", onEnded);
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    this.#detachTrackListeners = () => {
      track.removeEventListener("ended", onEnded);
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
    };
  }

  /** @param {CameraEvent} event */
  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Camera event listener failed", error);
      }
    }
  }
}

/**
 * @param {unknown} error
 * @returns {CameraError}
 */
function toCameraError(error) {
  const name = /** @type {{ name?: string }} */ (error)?.name ?? "Error";
  const code = ERROR_CODES[/** @type {keyof typeof ERROR_CODES} */ (name)] ?? "CAMERA_START_FAILED";
  const hint =
    ERROR_HINTS[/** @type {keyof typeof ERROR_HINTS} */ (code)] ?? "The camera failed to start.";
  const detail = /** @type {{ message?: string }} */ (error)?.message;
  return new CameraError(detail ? `${hint} (${name}: ${detail})` : `${hint} (${name})`, {
    code,
    cause: error,
  });
}
