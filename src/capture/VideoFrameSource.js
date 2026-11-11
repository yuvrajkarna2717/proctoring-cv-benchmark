import { IntervalEstimator } from "../benchmark/stats.js";
import { toEpoch } from "../utils/clock.js";
import { LabError } from "../utils/errors.js";

/**
 * @typedef {'requestVideoFrameCallback'|'requestAnimationFrame'|'fallback-timer'} FrameClock
 *
 * @typedef {Object} FrameTick
 * @property {number} frameId increasing id of the tick
 * @property {FrameClock} clock what produced the tick
 * @property {number} callbackTime epoch ms at which the tick was produced
 * @property {number} captureTime epoch ms of the best available capture timestamp
 * @property {'captureTime'|'presentationTime'|'callbackTime'} captureTimeSource
 * @property {number | null} mediaTime media timeline position in seconds
 * @property {number | null} presentedFrames browser counter of composited frames (rVFC only)
 * @property {number} width native frame width
 * @property {number} height native frame height
 *
 * @typedef {Object} CapturedFrame
 * @property {ImageBitmap} bitmap caller owns it and must transfer or close it
 * @property {number} width
 * @property {number} height
 * @property {number} sourceWidth
 * @property {number} sourceHeight
 * @property {number} captureMs time spent in createImageBitmap
 */

const HAVE_CURRENT_DATA = 2;

/**
 * Turns a playing <video> element (live camera or, later, a recorded session) into a stream of
 * frame ticks and captures ImageBitmaps on demand.
 *
 * Frame clock:
 * - `requestVideoFrameCallback` (rVFC) fires once per presented frame and exposes the camera
 *   capture timestamp. It is preferred.
 * - Without rVFC (older Firefox), `requestAnimationFrame` is polled and a tick is emitted when
 *   `currentTime` changes; timestamps fall back to callback time.
 * - Watchdog: rVFC depends on the compositor presenting frames. If no callback arrives for
 *   `stallTimeoutMs` while the video is playing, the callback is re-armed and ticks are driven
 *   by a timer until callbacks resume. Fallback ticks are counted separately so measurements
 *   taken during a stall can be identified.
 *
 * The source never copies pixels on its own. Pixels are copied only when a scheduler asks for a
 * frame via captureBitmap(), at most once per dispatched engine request.
 */
export class VideoFrameSource {
  #video;
  /** @type {'requestVideoFrameCallback'|'requestAnimationFrame'} */
  #mode;
  #stallTimeoutMs;
  #now;
  #running = false;
  /** @type {number | null} */
  #handle = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  #watchdog = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  #fallbackTimer = null;
  #lastCallbackAt = 0;
  #frameId = 0;
  #lastMediaTime = -1;
  #lastDecodedFrames = -1;
  /** Becomes true once getVideoPlaybackQuality() has counted at least one frame. */
  #decodedCounterReported = false;
  /** @type {Set<(tick: FrameTick) => void>} */
  #listeners = new Set();
  #intervalEstimator = new IntervalEstimator(0.1);
  #ticks = 0;
  #fallbackTicks = 0;
  #stalls = 0;
  /** Ticks per timestamp source; captureTime is the most precise (camera capture time). */
  #timestampSources = { captureTime: 0, presentationTime: 0, callbackTime: 0 };
  /** @type {number | null} */
  #firstPresentedFrames = null;
  /** @type {number | null} */
  #lastPresentedFrames = null;
  #missedCallbacks = 0;

  /**
   * @param {HTMLVideoElement} video
   * @param {{ preferVideoFrameCallback?: boolean, stallTimeoutMs?: number, now?: () => number }} [options]
   *   `now` is a monotonic millisecond clock used for stall detection (injectable for tests).
   */
  constructor(
    video,
    { preferVideoFrameCallback = true, stallTimeoutMs = 500, now = () => performance.now() } = {},
  ) {
    this.#video = video;
    this.#mode =
      preferVideoFrameCallback && typeof video.requestVideoFrameCallback === "function"
        ? "requestVideoFrameCallback"
        : "requestAnimationFrame";
    this.#stallTimeoutMs = stallTimeoutMs;
    this.#now = now;
  }

  /** @returns {'requestVideoFrameCallback'|'requestAnimationFrame'} */
  get mode() {
    return this.#mode;
  }

  /** @returns {number | null} smoothed interval between ticks in ms */
  get frameIntervalMs() {
    return this.#intervalEstimator.value;
  }

  /**
   * @param {(tick: FrameTick) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#intervalEstimator.reset();
    this.#lastCallbackAt = this.#now();
    this.#schedule();
    if (this.#mode === "requestVideoFrameCallback") {
      this.#watchdog = setInterval(() => this.#checkForStall(), this.#stallTimeoutMs / 2);
    }
  }

  stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#cancelCallback();
    if (this.#watchdog !== null) clearInterval(this.#watchdog);
    this.#watchdog = null;
    this.#stopFallback();
  }

  /**
   * Copies the current video frame into an ImageBitmap, optionally downscaled during the copy.
   *
   * @param {{ maxWidth?: number | null }} [options]
   * @returns {Promise<CapturedFrame>}
   */
  async captureBitmap({ maxWidth = null } = {}) {
    const video = this.#video;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (video.readyState < HAVE_CURRENT_DATA || sourceWidth === 0 || sourceHeight === 0) {
      throw new LabError("The video element has no decoded frame to capture", { code: "NO_FRAME" });
    }
    const startedAt = performance.now();
    let bitmap;
    if (maxWidth && sourceWidth > maxWidth) {
      bitmap = await createImageBitmap(video, {
        resizeWidth: maxWidth,
        resizeHeight: Math.max(1, Math.round((sourceHeight * maxWidth) / sourceWidth)),
        resizeQuality: "medium",
      });
    } else {
      bitmap = await createImageBitmap(video);
    }
    return {
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      sourceWidth,
      sourceHeight,
      captureMs: performance.now() - startedAt,
    };
  }

  getStats() {
    const quality = this.#playbackQuality();
    return {
      mode: this.#mode,
      /** @type {FrameClock} */
      clock: this.#fallbackTimer !== null ? "fallback-timer" : this.#mode,
      ticks: this.#ticks,
      fallbackTicks: this.#fallbackTicks,
      stalls: this.#stalls,
      timestampSources: { ...this.#timestampSources },
      frameIntervalMs: this.#intervalEstimator.value,
      presentedFrames:
        this.#lastPresentedFrames === null || this.#firstPresentedFrames === null
          ? null
          : this.#lastPresentedFrames - this.#firstPresentedFrames,
      missedCallbacks: this.#missedCallbacks,
      /** null when the browser does not report decoded/dropped frames for this source */
      playbackQuality: quality,
    };
  }

  resetStats() {
    this.#ticks = 0;
    this.#fallbackTicks = 0;
    this.#stalls = 0;
    this.#timestampSources = { captureTime: 0, presentationTime: 0, callbackTime: 0 };
    this.#firstPresentedFrames = this.#lastPresentedFrames;
    this.#missedCallbacks = 0;
  }

  #schedule() {
    if (!this.#running) return;
    if (this.#mode === "requestVideoFrameCallback") {
      this.#handle = this.#video.requestVideoFrameCallback((now, metadata) => {
        this.#handle = null;
        this.#onVideoFrame(now, metadata);
        this.#schedule();
      });
    } else {
      this.#handle = requestAnimationFrame((now) => {
        this.#handle = null;
        this.#onAnimationFrame(now);
        this.#schedule();
      });
    }
  }

  #cancelCallback() {
    if (this.#handle === null) return;
    if (this.#mode === "requestVideoFrameCallback") {
      this.#video.cancelVideoFrameCallback(this.#handle);
    } else {
      cancelAnimationFrame(this.#handle);
    }
    this.#handle = null;
  }

  #checkForStall() {
    if (!this.#running || this.#fallbackTimer !== null) return;
    if (this.#now() - this.#lastCallbackAt < this.#stallTimeoutMs) return;
    if (!this.#isPlaying()) return; // paused or no data: no frames are expected
    this.#stalls += 1;
    // The pending callback may have been lost; re-arm it, then keep the schedulers fed.
    this.#cancelCallback();
    this.#schedule();
    const intervalMs = Math.min(100, Math.max(10, this.#intervalEstimator.value ?? 1000 / 30));
    this.#fallbackTimer = setInterval(() => this.#onFallbackTick(), intervalMs);
  }

  #stopFallback() {
    if (this.#fallbackTimer !== null) clearInterval(this.#fallbackTimer);
    this.#fallbackTimer = null;
  }

  #isPlaying() {
    const video = this.#video;
    if (video.paused || video.ended || video.readyState < HAVE_CURRENT_DATA) return false;
    // A live camera whose track has ended keeps "playing" its last frame; no new frames come.
    const stream = /** @type {MediaStream | null | undefined} */ (video.srcObject);
    if (stream && typeof stream.getVideoTracks === "function") {
      const [track] = stream.getVideoTracks();
      if (!track || track.readyState === "ended") return false;
    }
    return true;
  }

  /**
   * Decoded/dropped frame counters, or null when the browser does not report them for this
   * source. Firefox implements getVideoPlaybackQuality() but reports 0 frames for camera
   * (MediaStream) sources, so the counter is trusted only after it has counted a frame.
   *
   * @returns {{ totalVideoFrames: number, droppedVideoFrames: number } | null}
   */
  #playbackQuality() {
    if (typeof this.#video.getVideoPlaybackQuality !== "function") return null;
    const quality = this.#video.getVideoPlaybackQuality();
    if (quality.totalVideoFrames > 0) this.#decodedCounterReported = true;
    if (!this.#decodedCounterReported) return null;
    return {
      totalVideoFrames: quality.totalVideoFrames,
      droppedVideoFrames: quality.droppedVideoFrames,
    };
  }

  /**
   * @param {DOMHighResTimeStamp} now
   * @param {VideoFrameCallbackMetadata} metadata
   */
  #onVideoFrame(now, metadata) {
    this.#lastCallbackAt = this.#now();
    this.#stopFallback();
    this.#lastMediaTime = metadata.mediaTime;
    this.#lastDecodedFrames = this.#playbackQuality()?.totalVideoFrames ?? -1;
    const callbackTime = toEpoch(now);
    /** @type {FrameTick['captureTimeSource']} */
    let captureTimeSource = "callbackTime";
    let captureTime = callbackTime;
    if (Number.isFinite(metadata.captureTime)) {
      captureTime = toEpoch(/** @type {number} */ (metadata.captureTime));
      captureTimeSource = "captureTime";
    } else if (Number.isFinite(metadata.presentationTime)) {
      captureTime = toEpoch(metadata.presentationTime);
      captureTimeSource = "presentationTime";
    }
    if (
      this.#lastPresentedFrames !== null &&
      metadata.presentedFrames > this.#lastPresentedFrames + 1
    ) {
      // Frames were composited without a callback. In Chromium this means the main thread
      // could not keep up; Firefox also skips callbacks on its own (Mozilla bug 1935256).
      this.#missedCallbacks += metadata.presentedFrames - this.#lastPresentedFrames - 1;
    }
    if (this.#firstPresentedFrames === null) this.#firstPresentedFrames = metadata.presentedFrames;
    this.#lastPresentedFrames = metadata.presentedFrames;
    this.#emitTick({
      frameId: ++this.#frameId,
      clock: "requestVideoFrameCallback",
      callbackTime,
      captureTime,
      captureTimeSource,
      mediaTime: metadata.mediaTime,
      presentedFrames: metadata.presentedFrames,
      width: metadata.width,
      height: metadata.height,
    });
  }

  /** @param {DOMHighResTimeStamp} now */
  #onAnimationFrame(now) {
    const video = this.#video;
    if (video.readyState < HAVE_CURRENT_DATA || video.currentTime === this.#lastMediaTime) return;
    this.#lastMediaTime = video.currentTime;
    this.#lastCallbackAt = this.#now();
    this.#emitTimedTick(toEpoch(now), "requestAnimationFrame");
  }

  #onFallbackTick() {
    if (!this.#running || !this.#isPlaying()) return;
    const video = this.#video;
    // The decoded-frame counter is the reliable "new frame" signal: for MediaStream sources
    // currentTime advances with wall time even when no new frame arrives. currentTime is used
    // only when the browser does not report the counter (Firefox camera streams); a stream
    // whose track ended is already excluded by #isPlaying().
    const quality = this.#playbackQuality();
    const newFrame = quality
      ? quality.totalVideoFrames !== this.#lastDecodedFrames
      : video.currentTime !== this.#lastMediaTime;
    if (quality) this.#lastDecodedFrames = quality.totalVideoFrames;
    this.#lastMediaTime = video.currentTime;
    if (!newFrame) return;
    this.#fallbackTicks += 1;
    this.#emitTimedTick(toEpoch(performance.now()), "fallback-timer");
  }

  /**
   * @param {number} callbackTime epoch ms
   * @param {FrameClock} clock
   */
  #emitTimedTick(callbackTime, clock) {
    const video = this.#video;
    this.#emitTick({
      frameId: ++this.#frameId,
      clock,
      callbackTime,
      captureTime: callbackTime,
      captureTimeSource: "callbackTime",
      mediaTime: video.currentTime,
      presentedFrames: null,
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }

  /** @param {FrameTick} tick */
  #emitTick(tick) {
    this.#ticks += 1;
    this.#timestampSources[tick.captureTimeSource] += 1;
    this.#intervalEstimator.push(tick.callbackTime);
    for (const listener of this.#listeners) {
      try {
        listener(tick);
      } catch (error) {
        console.error("Frame tick listener failed", error);
      }
    }
  }
}
