import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LAB_CONFIG } from "../../src/config/detection.config.js";
import { IdentityManager } from "../../src/identity/IdentityManager.js";
import { createMemoryStore } from "../../src/identity/IdentityStore.js";
import { flush } from "../helpers/fakes.js";

const RECOGNIZER = { id: "ocv-sface", version: "2021dec", file: "f", sha256: "sface-hash" };
const GOOD_QUALITY = {
  score: 0.95,
  interEyePx: 80,
  rollDeg: 2,
  yawRatio: 0.02,
  brightness: 120,
  sharpness: 60,
  inFrame: true,
};

/** Unit vector at `degrees` in the first two of 128 dimensions. */
function vector(degrees) {
  const v = new Float32Array(128);
  v[0] = Math.cos((degrees * Math.PI) / 180);
  v[1] = Math.sin((degrees * Math.PI) / 180);
  return v;
}

/** A face-verifier result as the engine produces it. */
function result(
  at,
  { degrees = 0, faces = 1, quality = GOOD_QUALITY, source = "face", recognizer = RECOGNIZER } = {},
) {
  const embedded = faces > 0 || source === "center-crop";
  return {
    engine: "face-verifier",
    kind: "face-verifier",
    frameCaptureTime: at,
    observations: [
      { type: "FACE_COUNT", detected: faces > 0, value: faces },
      ...(embedded
        ? [
            {
              type: "FACE_EMBEDDING",
              detected: true,
              value: 0,
              metadata: { source, recognizer: recognizer.id, quality },
            },
          ]
        : []),
    ],
    model: {
      id: `ocv-yunet-2026may+${recognizer.id}`,
      components: [
        { id: "ocv-yunet-2026may", version: "v", file: "y", sha256: "yunet-hash" },
        recognizer,
      ],
    },
    payload: {
      format: "face-verifier",
      imageWidth: 1280,
      imageHeight: 720,
      faces: [],
      embedding: embedded
        ? { faceIndex: 0, source, recognizer: recognizer.id, vector: vector(degrees) }
        : null,
    },
  };
}

function createManager(overrides = {}) {
  const config = structuredClone(DEFAULT_LAB_CONFIG.identity);
  Object.assign(config.enrollment, overrides.enrollment);
  Object.assign(config.calibration, overrides.calibration);
  let now = 0;
  const store = overrides.store ?? createMemoryStore();
  const manager = new IdentityManager({
    config,
    store,
    now: () => now,
    getCamera: () => ({ label: "Cam", width: 1280, height: 720 }),
  });
  const events = [];
  manager.onEvent((event) => events.push(event));
  return { manager, store, events, setNow: (value) => (now = value) };
}

/** Feeds results every 500 ms (beyond minIntervalMs 400). */
function feed(manager, from, count, options) {
  const samples = [];
  for (let i = 0; i < count; i += 1) samples.push(manager.observe(result(from + i * 500, options)));
  return samples;
}

async function enroll(manager, options = {}) {
  manager.startEnrollment();
  feed(manager, 1000, 5, options);
  await flush();
}

describe("IdentityManager enrollment", () => {
  it("averages accepted samples into a stored template, without embeddings in the snapshot", async () => {
    const { manager, store, events } = createManager();
    await manager.load();
    await enroll(manager, { degrees: 3 });
    const reference = await store.getReference();
    expect(reference).toMatchObject({
      samples: 5,
      recognizer: { id: "ocv-sface", sha256: "sface-hash" },
      detector: { id: "ocv-yunet-2026may", sha256: "yunet-hash" },
      quality: { interEyePx: 80 },
      camera: { label: "Cam" },
    });
    expect(reference.embedding).toBeInstanceOf(Float32Array);
    expect(reference.sampleSimilarity.min).toBeCloseTo(1, 5);
    const snapshot = manager.getSnapshot();
    expect(snapshot.enrollment).toMatchObject({ status: "done", accepted: 5 });
    expect(snapshot.reference).toMatchObject({ samples: 5 });
    expect(JSON.stringify(snapshot)).not.toContain("embedding");
    expect(events).toContainEqual({ type: "reference-changed", reason: "enrolled" });
  });

  it("accepts only frames that pass the gate and are spaced by minIntervalMs", async () => {
    const { manager } = createManager();
    manager.startEnrollment();
    manager.observe(result(0, { faces: 2 })); // two faces
    manager.observe(result(100, { quality: { ...GOOD_QUALITY, yawRatio: 0.5 } })); // turned
    manager.observe(result(200)); // accepted
    manager.observe(result(300)); // within 400 ms
    const snapshot = manager.getSnapshot().enrollment;
    expect(snapshot).toMatchObject({
      status: "collecting",
      accepted: 1,
      framesOffered: 4,
      framesRejected: 2,
      framesSkipped: 1,
    });
    expect(snapshot.mostFrequentFailure).not.toBeNull();
  });

  it("refuses an enrollment whose samples disagree (another person in view)", async () => {
    const { manager, store } = createManager();
    manager.startEnrollment();
    feed(manager, 0, 4, { degrees: 0 });
    manager.observe(result(3000, { degrees: 80 }));
    await flush();
    expect(manager.getSnapshot().enrollment).toMatchObject({
      status: "failed",
      failure: expect.stringContaining("samples disagree"),
    });
    expect(await store.getReference()).toBeNull();
  });

  it("times out with the most frequent failed check", () => {
    const { manager, setNow } = createManager();
    manager.startEnrollment();
    feed(manager, 0, 3, { quality: { ...GOOD_QUALITY, brightness: 20 } });
    setNow(30_001);
    manager.tick(30_001);
    expect(manager.getSnapshot().enrollment.failure).toMatch(
      /timed out .* 0 of 5 samples; most frequent failed check: Brightness/,
    );
  });

  it("allows one enrollment or capture at a time", () => {
    const { manager } = createManager();
    manager.startEnrollment();
    expect(() => manager.startCalibrationCapture({ person: "P1" })).toThrow(
      expect.objectContaining({ code: "BUSY" }),
    );
    manager.cancelEnrollment();
    expect(manager.getSnapshot().enrollment.status).toBe("cancelled");
    expect(() => manager.startCalibrationCapture({ person: "P1" })).not.toThrow();
  });
});

describe("IdentityManager verification", () => {
  it("compares gated frames with the reference and reports why others were not compared", async () => {
    const { manager } = createManager();
    expect(manager.observe(result(0))).toBeNull(); // no reference yet
    await enroll(manager, { degrees: 0 });
    expect(manager.observe(result(10_000, { degrees: 60 }))).toEqual({
      at: 10_000,
      similarity: expect.closeTo(0.5, 5),
    });
    expect(manager.observe(result(10_500, { faces: 0 }))).toBeNull();
    expect(
      manager.observe(result(11_000, { quality: { ...GOOD_QUALITY, sharpness: 1 } })),
    ).toBeNull();
    const other = { id: "ocv-sface-int8", version: "v", file: "f", sha256: "int8" };
    expect(manager.observe(result(11_500, { recognizer: other }))).toBeNull();
    const { verification } = manager.getSnapshot();
    expect(verification.counts).toEqual({
      compared: 1,
      "no-face": 1,
      "gate-failed": 1,
      "model-mismatch": 1,
    });
    expect(verification.recent.map((entry) => entry.status)).toEqual([
      "compared",
      "no-face",
      "gate-failed",
      "model-mismatch",
    ]);
    expect(verification.recentSimilarity).toMatchObject({ n: 1, mean: expect.closeTo(0.5, 5) });
  });

  it("does not compare the center-crop diagnostic", async () => {
    const { manager } = createManager();
    await enroll(manager);
    expect(manager.observe(result(10_000, { faces: 0, source: "center-crop" }))).toBeNull();
    expect(manager.getSnapshot().verification.last.status).toBe("no-face");
  });

  it("deletes the reference and stops comparing", async () => {
    const { manager, store, events } = createManager();
    await enroll(manager);
    await manager.deleteReference();
    expect(await store.getReference()).toBeNull();
    expect(manager.observe(result(10_000))).toBeNull();
    expect(events).toContainEqual({ type: "reference-changed", reason: "deleted" });
  });

  it("loads a stored reference", async () => {
    const first = createManager();
    await enroll(first.manager);
    const second = createManager({ store: first.store });
    await second.manager.load();
    expect(second.manager.hasReference).toBe(true);
    expect(second.manager.observe(result(10_000))).toMatchObject({
      similarity: expect.closeTo(1, 5),
    });
  });

  it("reports storage that cannot be opened instead of failing", async () => {
    const store = {
      ...createMemoryStore(),
      getReference: vi.fn(async () => {
        throw new Error("denied");
      }),
    };
    const { manager, events } = createManager({ store });
    await manager.load();
    expect(manager.getSnapshot().storage).toMatchObject({
      loadState: "error",
      error: expect.stringContaining("denied"),
    });
    expect(events.some((event) => event.type === "log" && event.level === "error")).toBe(true);
  });
});

describe("IdentityManager calibration", () => {
  async function capture(manager, person, degrees, from) {
    manager.startCalibrationCapture({ person, conditions: { lighting: "office", pose: "" } });
    feed(manager, from, 5, { degrees });
    await flush();
  }

  it("stores labelled captures and computes rates for the current recognizer", async () => {
    const { manager, store } = createManager();
    await capture(manager, "P1", 0, 0);
    await capture(manager, "P1", 4, 10_000);
    // cos 86° = 0.07 and cos 90° = 0: impostors well below 0.363; genuine cos 4° = 0.998.
    await capture(manager, "P2", 90, 20_000);
    expect(await store.listCalibrationSamples()).toHaveLength(15);
    const { captures } = manager.getSnapshot().calibration;
    expect(captures.map((c) => [c.person, c.samples])).toEqual([
      ["P2", 5],
      ["P1", 5],
      ["P1", 5],
    ]);
    expect(captures[0].conditions).toEqual({ lighting: "office" });

    const results = manager.calibrationResults(0.363, "ocv-sface");
    expect(results.ready).toBe(true);
    expect(results.metrics).toMatchObject({ genuineCount: 10, impostorCount: 20 });
    expect(results.metrics.atThreshold).toMatchObject({ far: 0, frr: 0 });
    expect(results.composition).toMatchObject({ personCount: 2, captureCount: 3 });
    expect(manager.calibrationResults(0.363, "ocv-sface")).toBe(results); // cached
    expect(manager.calibrationResults(0.363, "ocv-sface-int8")).toMatchObject({
      ready: false,
      excludedOtherModel: 15,
    });

    const exported = manager.exportCalibration(0.363, "ocv-sface");
    expect(exported.pairs).toHaveLength(30);
    expect(JSON.stringify(exported)).not.toContain("embedding");
  });

  it("says what is missing before rates can be computed", async () => {
    const { manager } = createManager();
    await capture(manager, "P1", 0, 0);
    expect(manager.calibrationResults(0.4, "ocv-sface")).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/two captures/),
    });
    await capture(manager, "P2", 90, 10_000);
    expect(manager.calibrationResults(0.4, "ocv-sface")).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/No genuine pairs/),
    });
  });

  it("validates person labels and deletes captures and all data", async () => {
    const { manager, store } = createManager();
    expect(() => manager.startCalibrationCapture({ person: "  " })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    await capture(manager, "P1", 0, 0);
    const [{ id }] = manager.getSnapshot().calibration.captures;
    await manager.deleteCalibrationCapture(id);
    expect(await store.listCalibrationSamples()).toEqual([]);
    await enroll(manager);
    await capture(manager, "P1", 0, 20_000);
    await manager.deleteAll();
    expect(await store.getReference()).toBeNull();
    expect(manager.getSnapshot().calibration.sampleCount).toBe(0);
  });
});
