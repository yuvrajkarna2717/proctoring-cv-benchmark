import { describe, expect, it, vi } from "vitest";
import { CameraManager } from "../../src/capture/CameraManager.js";
import { CameraError } from "../../src/utils/errors.js";

function createTrack() {
  const listeners = new Map();
  return {
    kind: "video",
    label: "Fake camera",
    readyState: "live",
    muted: false,
    stop: vi.fn(function stop() {
      this.readyState = "ended";
    }),
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30, deviceId: "cam-1" }),
    getCapabilities: () => ({ width: { min: 1, max: 1920 } }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type) => listeners.get(type)?.(),
    listeners,
  };
}

function createMediaDevices({ error } = {}) {
  const track = createTrack();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  return {
    track,
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        if (error) throw error;
        return stream;
      }),
      enumerateDevices: vi.fn(async () => [
        { kind: "videoinput", deviceId: "cam-1", label: "Fake camera", groupId: "g" },
        { kind: "audioinput", deviceId: "mic-1", label: "Mic", groupId: "g" },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  };
}

const OPTIONS = { width: 1280, height: 720, frameRate: 30 };

describe("CameraManager", () => {
  it("requests ideal constraints and an exact device id", async () => {
    const { mediaDevices } = createMediaDevices();
    const camera = new CameraManager({ mediaDevices });
    const { track } = await camera.start({ ...OPTIONS, deviceId: "cam-1" });
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        deviceId: { exact: "cam-1" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
    expect(track).toMatchObject({
      label: "Fake camera",
      readyState: "live",
      settings: { width: 1280 },
    });
    expect(camera.isActive).toBe(true);
  });

  it("stops every track and reports them as ended", async () => {
    const { mediaDevices, track } = createMediaDevices();
    const camera = new CameraManager({ mediaDevices });
    await camera.start(OPTIONS);
    expect(camera.stop()).toEqual(["ended"]);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(track.listeners.size).toBe(0);
    expect(camera.isActive).toBe(false);
    expect(camera.stop()).toEqual([]);
  });

  it("maps getUserMedia errors to stable codes and keeps the cause", async () => {
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const { mediaDevices } = createMediaDevices({ error: denied });
    const camera = new CameraManager({ mediaDevices });
    const error = await camera.start(OPTIONS).catch((e) => e);
    expect(error).toBeInstanceOf(CameraError);
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.cause).toBe(denied);
  });

  it("reports busy devices", async () => {
    const busy = Object.assign(new Error("Could not start video source"), {
      name: "NotReadableError",
    });
    const camera = new CameraManager(createMediaDevices({ error: busy }));
    await expect(camera.start(OPTIONS)).rejects.toMatchObject({ code: "DEVICE_BUSY" });
  });

  it("is unsupported without mediaDevices", async () => {
    const camera = new CameraManager({ mediaDevices: undefined });
    expect(camera.isSupported).toBe(false);
    await expect(camera.start(OPTIONS)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("lists only video inputs", async () => {
    const camera = new CameraManager(createMediaDevices());
    expect(await camera.listVideoInputs()).toEqual([
      { deviceId: "cam-1", label: "Fake camera", groupId: "g" },
    ]);
  });

  it("emits track ended events", async () => {
    const { mediaDevices, track } = createMediaDevices();
    const camera = new CameraManager({ mediaDevices });
    const events = [];
    camera.onEvent((event) => events.push(event.type));
    await camera.start(OPTIONS);
    track.fire("ended");
    expect(events).toEqual(["ended"]);
  });
});
