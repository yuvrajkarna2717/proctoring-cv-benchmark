import { LabError } from "../utils/errors.js";

/**
 * Local storage of violation snapshots: a JPEG of the camera image when a violation started, a
 * small thumbnail, and the violation's details. Records stay in this browser's IndexedDB for this
 * origin until they expire (see SnapshotManager) or are deleted. They are never uploaded and never
 * part of exported reports.
 *
 * @typedef {import('../pipeline/ViolationEngine.js').Violation} Violation
 *
 * @typedef {Object} SnapshotMeta everything about a snapshot except the image data
 * @property {string} id
 * @property {string} sessionId page session (one LabController) that took it
 * @property {string} violationId id of the violation within that session
 * @property {string} type violation type
 * @property {number} capturedAt epoch ms
 * @property {number} expiresAt epoch ms
 * @property {Violation} violation as it was when it started; updated when it escalates or ends
 * @property {{ label: string, width: number, height: number } | null} camera
 * @property {{ width: number, height: number, bytes: number, mimeType: string }} image
 *
 * @typedef {SnapshotMeta & { blobs: { image: Blob, thumbnail: Blob } }} SnapshotRecord
 *
 * @typedef {Object} SnapshotStore
 * @property {'indexeddb' | 'memory'} kind memory: nothing survives a reload
 * @property {() => Promise<SnapshotMeta[]>} list every stored snapshot, without image data
 * @property {(record: SnapshotRecord) => Promise<void>} put
 * @property {(id: string, kind: 'image' | 'thumbnail') => Promise<Blob | null>} getBlob
 * @property {(id: string, patch: Partial<SnapshotMeta>) => Promise<boolean>} update changes
 *   metadata; false when the snapshot no longer exists
 * @property {(ids: string[]) => Promise<void>} delete
 * @property {() => Promise<void>} clear
 */

const DATABASE = "proctoring-cv-lab-snapshots";
const VERSION = 1;
const STORE = "snapshots";

/**
 * IndexedDB when available, otherwise memory (for example in unit tests).
 *
 * @param {{ indexedDB?: IDBFactory | undefined }} [environment]
 * @returns {SnapshotStore}
 */
export function createSnapshotStore({ indexedDB = globalThis.indexedDB } = {}) {
  return indexedDB ? createIndexedDbStore(indexedDB) : createMemorySnapshotStore();
}

/** @param {SnapshotRecord} record @returns {SnapshotMeta} */
function metaOf(record) {
  const { blobs: _blobs, ...meta } = record;
  return meta;
}

/** @returns {SnapshotStore} */
export function createMemorySnapshotStore() {
  /** @type {Map<string, SnapshotRecord>} */
  const records = new Map();
  return {
    kind: "memory",
    async list() {
      return [...records.values()].map((record) => structuredClone(metaOf(record)));
    },
    async put(record) {
      records.set(record.id, { ...record });
    },
    async getBlob(id, kind) {
      return records.get(id)?.blobs[kind] ?? null;
    },
    async update(id, patch) {
      const record = records.get(id);
      if (!record) return false;
      records.set(id, { ...record, ...structuredClone(patch) });
      return true;
    },
    async delete(ids) {
      for (const id of ids) records.delete(id);
    },
    async clear() {
      records.clear();
    },
  };
}

/**
 * @param {IDBFactory} factory
 * @returns {SnapshotStore}
 */
function createIndexedDbStore(factory) {
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null;

  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      const request = factory.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab deleting or upgrading the database must not be blocked by this one.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () =>
        reject(
          new LabError("Could not open the snapshot database (IndexedDB)", {
            code: "STORAGE_UNAVAILABLE",
            cause: request.error,
          }),
        );
      request.onblocked = () =>
        reject(
          new LabError("The snapshot database is blocked by another tab of this lab", {
            code: "STORAGE_BLOCKED",
          }),
        );
    }).catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  };

  /**
   * Runs `work` in one transaction and resolves with what it returns once the transaction
   * commits.
   *
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => () => T} work returns a getter for the result
   * @returns {Promise<T>}
   */
  const run = async (mode, work) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE], mode);
      const result = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(result());
      transaction.onabort = transaction.onerror = () =>
        reject(
          new LabError("A snapshot database operation failed", {
            code: "STORAGE_FAILED",
            cause: transaction.error,
          }),
        );
    });
  };

  return {
    kind: "indexeddb",
    async list() {
      return run("readonly", (store) => {
        /** @type {SnapshotMeta[]} */
        const metas = [];
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          metas.push(metaOf(/** @type {SnapshotRecord} */ (cursor.value)));
          cursor.continue();
        };
        return () => metas;
      });
    },
    async put(record) {
      await run("readwrite", (store) => {
        store.put(record);
        return () => undefined;
      });
    },
    async getBlob(id, kind) {
      return run("readonly", (store) => {
        const request = store.get(id);
        return () =>
          /** @type {SnapshotRecord | undefined} */ (request.result)?.blobs[kind] ?? null;
      });
    },
    async update(id, patch) {
      return run("readwrite", (store) => {
        let found = false;
        const request = store.get(id);
        request.onsuccess = () => {
          const record = /** @type {SnapshotRecord | undefined} */ (request.result);
          if (!record) return;
          found = true;
          store.put({ ...record, ...patch });
        };
        return () => found;
      });
    },
    async delete(ids) {
      if (ids.length === 0) return;
      await run("readwrite", (store) => {
        for (const id of ids) store.delete(id);
        return () => undefined;
      });
    },
    async clear() {
      await run("readwrite", (store) => {
        store.clear();
        return () => undefined;
      });
    },
  };
}
