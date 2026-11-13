import { describeError } from "../utils/errors.js";
import { createSerialQueue } from "../utils/serialQueue.js";
import { captureVideoFrame } from "./captureFrame.js";

/**
 * Violation snapshots: when a violation starts, the camera image is saved with the violation's
 * details (SnapshotStore), and the details are updated when the violation escalates or ends.
 * Snapshots are deleted `maxAgeMs` after they were taken: by a timer while the page is open, and
 * when the page loads for those that expired while it was closed. Beyond `maxCount`, the oldest
 * are deleted. Images are read on request only; snapshots carry metadata.
 *
 * Store writes run one at a time in call order, so a violation's update never overtakes its
 * snapshot and a deletion never interleaves with a write.
 *
 * @typedef {import('./SnapshotStore.js').SnapshotMeta} SnapshotMeta
 * @typedef {import('../pipeline/ViolationEngine.js').Violation} Violation
 * @typedef {{ type: 'log', level: 'info' | 'warn' | 'error', message: string }
 *   | { type: 'changed' }} SnapshotEvent
 */
export class SnapshotManager {
  /** @type {import('../config/schema.js').SnapshotsConfig} */
  #config;
  /** @type {import('./SnapshotStore.js').SnapshotStore} */
  #store;
  #now;
  #getCamera;
  /** @type {import('./captureFrame.js').CaptureFrame} */
  #capture;
  #write = createSerialQueue();
  #sessionId = crypto.randomUUID();
  /** @type {readonly SnapshotMeta[]} newest first; replaced, never mutated */
  #items = Object.freeze([]);
  /** @type {'loading' | 'ready' | 'error'} */
  #loadState = "loading";
  /** @type {string | null} */
  #error = null;
  /** @type {Promise<void>} */
  #loaded;
  /** @type {Map<string, Promise<void>>} captures in progress, by violation id */
  #pending = new Map();
  /** @type {ReturnType<typeof setTimeout> | null} */
  #expiryTimer = null;
  #disposed = false;
  /** @type {Set<(event: SnapshotEvent) => void>} */
  #listeners = new Set();

  /**
   * @param {Object} options
   * @param {import('../config/schema.js').SnapshotsConfig} options.config validated
   * @param {import('./SnapshotStore.js').SnapshotStore} options.store
   * @param {() => number} options.now epoch ms
   * @param {() => ({ label: string, width: number, height: number } | null)} [options.getCamera]
   * @param {import('./captureFrame.js').CaptureFrame} [options.capture] injected in tests
   */
  constructor({ config, store, now, getCamera = () => null, capture = captureVideoFrame }) {
    this.#config = { ...config };
    this.#store = store;
    this.#now = now;
    this.#getCamera = getCamera;
    this.#capture = capture;
    this.#loaded = this.#write(() => this.#load());
  }

  /** Page session id; snapshots of this session match violations by `violationId`. */
  get sessionId() {
    return this.#sessionId;
  }

  /** Resolves once stored snapshots were read and the expired ones deleted. */
  get loaded() {
    return this.#loaded;
  }

  /**
   * @param {(event: SnapshotEvent) => void} listener
   * @returns {() => void}
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Saves a snapshot for a violation that just started. The frame is drawn after the current
   * task, so it does not delay the evaluation of the frame. Failures are logged, never thrown.
   *
   * @param {HTMLVideoElement | null} video
   * @param {Violation} violation
   */
  capture(video, violation) {
    if (!this.#config.enabled || !video || this.#disposed) return;
    const work = this.#captureAndStore(video, structuredClone(violation)).finally(() =>
      this.#pending.delete(violation.id),
    );
    this.#pending.set(violation.id, work);
  }

  /**
   * Records the later state of a violation (escalated, ended) with its snapshot, if it has one.
   *
   * @param {Violation} violation
   */
  async updateViolation(violation) {
    await this.#pending.get(violation.id);
    const details = structuredClone(violation);
    await this.#write(async () => {
      const item = this.#items.find(
        (candidate) =>
          candidate.sessionId === this.#sessionId && candidate.violationId === violation.id,
      );
      if (!item || this.#disposed) return;
      try {
        if (!(await this.#store.update(item.id, { violation: details }))) return;
        this.#setItems(
          this.#items.map((candidate) =>
            candidate.id === item.id ? { ...candidate, violation: details } : candidate,
          ),
        );
        this.#emit({ type: "changed" });
      } catch (error) {
        this.#log("warn", `Snapshot of ${violation.id} not updated: ${describeError(error)}`);
      }
    });
  }

  /**
   * @param {string} id
   * @param {'image' | 'thumbnail'} kind
   * @returns {Promise<Blob | null>} null once deleted or expired
   */
  async getBlob(id, kind) {
    await this.#loaded;
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item || item.expiresAt <= this.#now()) return null;
    return this.#store.getBlob(id, kind);
  }

  /** @param {string} id */
  async delete(id) {
    await this.#write(async () => {
      await this.#store.delete([id]);
      this.#setItems(this.#items.filter((item) => item.id !== id));
      this.#scheduleExpiry();
      this.#log("info", "Snapshot deleted");
      this.#emit({ type: "changed" });
    });
  }

  /** Deletes every stored snapshot, of this and earlier sessions. */
  async deleteAll() {
    // Captures being encoded would otherwise be stored after the deletion.
    await Promise.allSettled([...this.#pending.values()]);
    await this.#write(async () => {
      const count = this.#items.length;
      await this.#store.clear();
      this.#setItems([]);
      this.#scheduleExpiry();
      this.#log("info", `All snapshots deleted (${count})`);
      this.#emit({ type: "changed" });
    });
  }

  getSnapshot() {
    return {
      enabled: this.#config.enabled,
      maxAgeMs: this.#config.maxAgeMs,
      maxCount: this.#config.maxCount,
      storage: { kind: this.#store.kind, loadState: this.#loadState, error: this.#error },
      sessionId: this.#sessionId,
      count: this.#items.length,
      /** Newest first, metadata only. */
      items: this.#items,
    };
  }

  dispose() {
    this.#disposed = true;
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
    this.#listeners.clear();
  }

  async #load() {
    try {
      const stored = await this.#store.list();
      const now = this.#now();
      const expired = stored.filter((item) => item.expiresAt <= now);
      const kept = stored
        .filter((item) => item.expiresAt > now)
        .sort((a, b) => b.capturedAt - a.capturedAt);
      const excess = kept.slice(this.#config.maxCount);
      await this.#store.delete([...expired, ...excess].map((item) => item.id));
      this.#setItems(kept.slice(0, this.#config.maxCount));
      this.#loadState = "ready";
      if (expired.length > 0) this.#log("info", `${expired.length} expired snapshots deleted`);
    } catch (error) {
      this.#loadState = "error";
      this.#error = describeError(error);
      this.#log("error", `Snapshot storage unavailable: ${this.#error}`);
    }
    this.#scheduleExpiry();
    this.#emit({ type: "changed" });
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {Violation} violation
   */
  async #captureAndStore(video, violation) {
    await Promise.resolve();
    try {
      const capturedAt = this.#now();
      const frame = await this.#capture(video, {
        maxWidth: this.#config.maxWidth,
        jpegQuality: this.#config.jpegQuality,
      });
      if (!frame) return;
      await this.#write(async () => {
        if (this.#disposed || this.#loadState !== "ready") return;
        /** @type {SnapshotMeta} */
        const meta = {
          id: crypto.randomUUID(),
          sessionId: this.#sessionId,
          violationId: violation.id,
          type: violation.type,
          capturedAt,
          expiresAt: capturedAt + this.#config.maxAgeMs,
          violation,
          camera: this.#getCamera(),
          image: {
            width: frame.width,
            height: frame.height,
            bytes: frame.image.size,
            mimeType: frame.image.type,
          },
        };
        await this.#store.put({
          ...meta,
          blobs: { image: frame.image, thumbnail: frame.thumbnail },
        });
        const items = [meta, ...this.#items];
        const excess = items.slice(this.#config.maxCount);
        if (excess.length > 0) await this.#store.delete(excess.map((item) => item.id));
        this.#setItems(items.slice(0, this.#config.maxCount));
        this.#scheduleExpiry();
        this.#emit({ type: "changed" });
      });
    } catch (error) {
      this.#log("warn", `Snapshot of ${violation.id} not saved: ${describeError(error)}`);
    }
  }

  /** Sets a timer for the next expiry. */
  #scheduleExpiry() {
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
    if (this.#disposed || this.#items.length === 0) return;
    const next = Math.min(...this.#items.map((item) => item.expiresAt));
    // Delays above 2^31 - 1 ms overflow, and the timer would fire at once.
    const delay = Math.min(Math.max(50, next - this.#now()), 2 ** 31 - 1);
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      void this.#write(() => this.#deleteExpired());
    }, delay);
  }

  /** Hides expired snapshots at once; if deleting them fails, the next page load retries. */
  async #deleteExpired() {
    if (this.#disposed) return;
    const now = this.#now();
    const expired = this.#items.filter((item) => item.expiresAt <= now);
    if (expired.length > 0) {
      this.#setItems(this.#items.filter((item) => item.expiresAt > now));
      try {
        await this.#store.delete(expired.map((item) => item.id));
      } catch (error) {
        this.#log("warn", `Expired snapshots not deleted: ${describeError(error)}`);
      }
      this.#emit({ type: "changed" });
    }
    this.#scheduleExpiry();
  }

  /** @param {SnapshotMeta[]} items newest first */
  #setItems(items) {
    this.#items = Object.freeze(items);
  }

  /**
   * @param {'info' | 'warn' | 'error'} level
   * @param {string} message
   */
  #log(level, message) {
    this.#emit({ type: "log", level, message });
  }

  /** @param {SnapshotEvent} event */
  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Snapshot listener failed", error);
      }
    }
  }
}
