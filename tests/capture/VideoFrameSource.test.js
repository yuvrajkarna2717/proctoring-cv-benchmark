import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoFrameSource } from "../../src/capture/VideoFrameSource.js";

/**
 * Minimal HTMLVideoElement stand-in with a controllable compositor.
 * `reportsDecodedFrames: false` mimics Firefox, whose getVideoPlaybackQuality() reports 0
 * frames for camera streams.
 */
function createFakeVideo({ reportsDecodedFrames = true } = {}) {
  let nextHandle = 1;
  const callbacks = new Map();
  return {
    videoWidth: 640,
    videoHeight: 480,
    readyState: 4,
    paused: false,
    ended: false,
    currentTime: 0,
    decoded: 0,
    requestVideoFrameCallback(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback(handle) {
      callbacks.delete(handle);
    },
    getVideoPlaybackQuality() {
      return { totalVideoFrames: reportsDecodedFrames ? this.decoded : 0, droppedVideoFrames: 0 };
    },
    /** A frame is decoded and presented: pending callbacks fire. */
    present(nowMs) {
      this.decodeOnly();
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) {
        callback(nowMs, {
          presentationTime: nowMs,
          expectedDisplayTime: nowMs,
          width: 640,
          height: 480,
          mediaTime: this.currentTime,
          presentedFrames: this.decoded,
          processingDuration: 0,
        });
      }
    },
    /** A frame is decoded but never presented (stalled compositor). */
    decodeOnly() {
      this.currentTime += 1 / 30;
      this.decoded += 1;
    },
    get pendingCallbacks() {
      return callbacks.size;
    },
  };
}

describe("VideoFrameSource", () => {
  let clock;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advances fake time and the injected clock together. */
  const step = (ms) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  it("emits one tick per presented frame with rVFC timestamps", () => {
    const video = createFakeVideo();
    const source = new VideoFrameSource(video, { now: () => clock });
    const ticks = [];
    source.subscribe((tick) => ticks.push(tick));
    source.start();
    for (let i = 0; i < 10; i += 1) {
      step(33);
      video.present(clock);
    }
    expect(ticks).toHaveLength(10);
    expect(ticks.every((tick) => tick.clock === "requestVideoFrameCallback")).toBe(true);
    expect(ticks[0].captureTimeSource).toBe("presentationTime");
    expect(ticks.map((tick) => tick.frameId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(source.getStats()).toMatchObject({ ticks: 10, stalls: 0, fallbackTicks: 0 });
    source.stop();
    expect(video.pendingCallbacks).toBe(0);
  });

  it("falls back to timer ticks when frame callbacks stall, and recovers", () => {
    const video = createFakeVideo();
    const source = new VideoFrameSource(video, { stallTimeoutMs: 500, now: () => clock });
    const ticks = [];
    source.subscribe((tick) => ticks.push(tick));
    source.start();
    for (let i = 0; i < 10; i += 1) {
      step(33);
      video.present(clock);
    }
    // Frames keep decoding but are never presented: rVFC stops firing.
    for (let i = 0; i < 60; i += 1) {
      step(33);
      video.decodeOnly();
    }
    const stalled = source.getStats();
    expect(stalled.stalls).toBe(1);
    expect(stalled.clock).toBe("fallback-timer");
    expect(stalled.fallbackTicks).toBeGreaterThan(20);
    expect(ticks.at(-1).clock).toBe("fallback-timer");
    expect(video.pendingCallbacks).toBe(1); // re-armed, exactly one pending callback

    // Presentation resumes: rVFC takes over again and the fallback timer stops.
    step(33);
    video.present(clock);
    expect(source.getStats().clock).toBe("requestVideoFrameCallback");
    const fallbackTicks = source.getStats().fallbackTicks;
    for (let i = 0; i < 5; i += 1) step(33);
    expect(source.getStats().fallbackTicks).toBe(fallbackTicks);
    source.stop();
  });

  it("emits no fallback ticks when no new frames are decoded", () => {
    const video = createFakeVideo();
    const source = new VideoFrameSource(video, { stallTimeoutMs: 500, now: () => clock });
    source.start();
    step(33);
    video.present(clock);
    // currentTime keeps advancing (as it does for a live MediaStream) but nothing is decoded.
    for (let i = 0; i < 60; i += 1) {
      step(33);
      video.currentTime += 1 / 30;
    }
    expect(source.getStats()).toMatchObject({ stalls: 1, fallbackTicks: 0 });
    source.stop();
  });

  it("falls back to currentTime when the browser reports no decoded frames (Firefox)", () => {
    const video = createFakeVideo({ reportsDecodedFrames: false });
    const source = new VideoFrameSource(video, { stallTimeoutMs: 500, now: () => clock });
    source.start();
    for (let i = 0; i < 10; i += 1) {
      step(33);
      video.present(clock);
    }
    expect(source.getStats().playbackQuality).toBeNull();
    // rVFC stalls; frames keep arriving (currentTime advances) but the counter stays at 0.
    for (let i = 0; i < 60; i += 1) {
      step(33);
      video.decodeOnly();
    }
    const stats = source.getStats();
    expect(stats.stalls).toBe(1);
    expect(stats.fallbackTicks).toBeGreaterThan(20);
    expect(stats.playbackQuality).toBeNull();
    source.stop();
  });

  it("reports playback quality once the browser counts frames", () => {
    const video = createFakeVideo();
    const source = new VideoFrameSource(video, { now: () => clock });
    expect(source.getStats().playbackQuality).toBeNull(); // nothing decoded yet
    source.start();
    step(33);
    video.present(clock);
    expect(source.getStats().playbackQuality).toEqual({
      totalVideoFrames: 1,
      droppedVideoFrames: 0,
    });
    source.stop();
  });

  it("treats a stream whose video track ended as not playing", () => {
    const video = createFakeVideo();
    video.srcObject = { getVideoTracks: () => [{ readyState: "ended" }] };
    const source = new VideoFrameSource(video, { stallTimeoutMs: 500, now: () => clock });
    source.start();
    for (let i = 0; i < 60; i += 1) {
      step(33);
      video.decodeOnly();
    }
    expect(source.getStats()).toMatchObject({ stalls: 0, fallbackTicks: 0 });
    source.stop();
  });

  it("does not report a stall while the video is paused", () => {
    const video = createFakeVideo();
    const source = new VideoFrameSource(video, { stallTimeoutMs: 500, now: () => clock });
    source.start();
    video.paused = true;
    for (let i = 0; i < 60; i += 1) step(33);
    expect(source.getStats()).toMatchObject({ stalls: 0, fallbackTicks: 0, ticks: 0 });
    source.stop();
  });

  it("refuses to capture before a frame is decoded", async () => {
    const video = createFakeVideo();
    video.readyState = 1;
    const source = new VideoFrameSource(video, { now: () => clock });
    await expect(source.captureBitmap()).rejects.toMatchObject({ code: "NO_FRAME" });
  });
});
