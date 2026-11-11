import { LabError } from "../utils/errors.js";

/**
 * Local storage of identity data: the enrolled reference template and calibration samples.
 * Both are face templates (128 numbers computed from a face), never images. They stay in this
 * browser's IndexedDB for this origin until deleted; reports and exports never contain them.
 * Benchmark data does not live here.
 *
 * @typedef {Object} ReferenceRecord
 * @property {number} version record format
 * @property {string} createdAt ISO time
 * @property {{ id: string, sha256: string | null }} recognizer model the template belongs to;
 *   templates of different models cannot be compared
 * @property {{ id: string, sha256: string | null } | null} detector
 * @property {Float32Array} embedding L2-normalized template
 * @property {number} samples
 * @property {{ min: number, mean: number }} sampleSimilarity agreement of the samples with the
 *   template
 * @property {Record<string, number>} quality mean quality measurements of the samples
 * @property {{ label: string, width: number, height: number } | null} camera
 *
 * @typedef {Object} IdentityStore
 * @property {'indexeddb' | 'memory'} kind memory: nothing survives a reload
 * @property {() => Promise<ReferenceRecord | null>} getReference
 * @property {(record: ReferenceRecord) => Promise<void>} putReference
 * @property {() => Promise<void>} deleteReference
 * @property {() => Promise<import('./calibration.js').CalibrationSample[]>} listCalibrationSamples
 * @property {(samples: import('./calibration.js').CalibrationSample[]) => Promise<void>} addCalibrationSamples
 * @property {(captureId: string) => Promise<void>} deleteCalibrationCapture
 * @property {() => Promise<void>} clearCalibration
 * @property {() => Promise<void>} destroy deletes everything, including the database itself
 * @property {() => Promise<{ ok: boolean, ms: number, error?: string }>} selfTest writes,
 *   reads, and deletes a test record
 */

const DATABASE = "proctoring-cv-lab-identity";
const VERSION = 1;
const REFERENCE_KEY = "reference";
const STORES = Object.freeze({
  reference: "reference",
  calibration: "calibration",
  diagnostics: "diagnostics",
});

/**
 * IndexedDB when available, otherwise memory (for example in unit tests).
 *
 * @param {{ indexedDB?: IDBFactory | undefined }} [environment]
 * @returns {IdentityStore}
 */
export function createIdentityStore({ indexedDB = globalThis.indexedDB } = {}) {
  return indexedDB ? createIndexedDbStore(indexedDB) : createMemoryStore();
}

/** @returns {IdentityStore} */
export function createMemoryStore() {
  /** @type {ReferenceRecord | null} */
  let reference = null;
  /** @type {Map<string, import('./calibration.js').CalibrationSample>} */
  const calibration = new Map();
  return {
    kind: "memory",
    async getReference() {
      return reference ? structuredClone(reference) : null;
    },
    async putReference(record) {
      reference = structuredClone(record);
    },
    async deleteReference() {
      reference = null;
    },
    async listCalibrationSamples() {
      return [...calibration.values()].map((sample) => structuredClone(sample));
    },
    async addCalibrationSamples(samples) {
      for (const sample of samples) calibration.set(sample.id, structuredClone(sample));
    },
    async deleteCalibrationCapture(captureId) {
      for (const [id, sample] of calibration) {
        if (sample.captureId === captureId) calibration.delete(id);
      }
    },
    async clearCalibration() {
      calibration.clear();
    },
    async destroy() {
      reference = null;
      calibration.clear();
    },
    async selfTest() {
      return { ok: true, ms: 0 };
    },
  };
}

/**
 * @param {IDBFactory} factory
 * @returns {IdentityStore}
 */
function createIndexedDbStore(factory) {
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null;

  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      const request = factory.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.reference)) db.createObjectStore(STORES.reference);
        if (!db.objectStoreNames.contains(STORES.calibration)) {
          db.createObjectStore(STORES.calibration, { keyPath: "id" }).createIndex(
            "captureId",
            "captureId",
          );
        }
        if (!db.objectStoreNames.contains(STORES.diagnostics)) {
          db.createObjectStore(STORES.diagnostics);
        }
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
          new LabError("Could not open the identity database (IndexedDB)", {
            code: "STORAGE_UNAVAILABLE",
            cause: request.error,
          }),
        );
      request.onblocked = () =>
        reject(
          new LabError("The identity database is blocked by another tab of this lab", {
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
   * Runs `work` in one transaction and resolves with its result when the transaction commits.
   *
   * @template T
   * @param {string[]} stores
   * @param {IDBTransactionMode} mode
   * @param {(transaction: IDBTransaction) => IDBRequest<T> | void} work
   * @returns {Promise<T | undefined>}
   */
  const run = async (stores, mode, work) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(stores, mode);
      const request = work(transaction);
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onabort = transaction.onerror = () =>
        reject(
          new LabError("An identity database operation failed", {
            code: "STORAGE_FAILED",
            cause: transaction.error,
          }),
        );
    });
  };

  return {
    kind: "indexeddb",
    async getReference() {
      const record = await run([STORES.reference], "readonly", (t) =>
        t.objectStore(STORES.reference).get(REFERENCE_KEY),
      );
      return /** @type {ReferenceRecord | undefined} */ (record) ?? null;
    },
    async putReference(record) {
      await run([STORES.reference], "readwrite", (t) =>
        t.objectStore(STORES.reference).put(record, REFERENCE_KEY),
      );
    },
    async deleteReference() {
      await run([STORES.reference], "readwrite", (t) =>
        t.objectStore(STORES.reference).delete(REFERENCE_KEY),
      );
    },
    async listCalibrationSamples() {
      const samples = await run([STORES.calibration], "readonly", (t) =>
        t.objectStore(STORES.calibration).getAll(),
      );
      return /** @type {import('./calibration.js').CalibrationSample[]} */ (samples ?? []);
    },
    async addCalibrationSamples(samples) {
      await run([STORES.calibration], "readwrite", (t) => {
        const store = t.objectStore(STORES.calibration);
        for (const sample of samples) store.put(sample);
      });
    },
    async deleteCalibrationCapture(captureId) {
      await run([STORES.calibration], "readwrite", (t) => {
        const store = t.objectStore(STORES.calibration);
        const request = store.index("captureId").getAllKeys(captureId);
        request.onsuccess = () => {
          for (const key of request.result) store.delete(key);
        };
      });
    },
    async clearCalibration() {
      await run([STORES.calibration], "readwrite", (t) =>
        t.objectStore(STORES.calibration).clear(),
      );
    },
    async destroy() {
      const pending = opening;
      opening = null;
      if (pending) (await pending.catch(() => null))?.close();
      await new Promise((resolve, reject) => {
        const request = factory.deleteDatabase(DATABASE);
        request.onsuccess = () => resolve(undefined);
        request.onerror = () =>
          reject(
            new LabError("Could not delete the identity database", {
              code: "STORAGE_FAILED",
              cause: request.error,
            }),
          );
        // Other tabs close their connection on versionchange, then deletion proceeds.
        request.onblocked = () => undefined;
      });
    },
    async selfTest() {
      const startedAt = performance.now();
      const probe = { at: Date.now(), vector: new Float32Array([0.6, 0.8]) };
      try {
        await run([STORES.diagnostics], "readwrite", (t) =>
          t.objectStore(STORES.diagnostics).put(probe, "self-test"),
        );
        const read = await run([STORES.diagnostics], "readonly", (t) =>
          t.objectStore(STORES.diagnostics).get("self-test"),
        );
        await run([STORES.diagnostics], "readwrite", (t) =>
          t.objectStore(STORES.diagnostics).delete("self-test"),
        );
        const value = /** @type {{ at: number, vector: Float32Array } | undefined} */ (read);
        const ok =
          value?.at === probe.at &&
          value.vector instanceof Float32Array &&
          value.vector[1] === probe.vector[1];
        return { ok, ms: performance.now() - startedAt };
      } catch (error) {
        return {
          ok: false,
          ms: performance.now() - startedAt,
          error: String(/** @type {Error} */ (error)?.message ?? error),
        };
      }
    },
  };
}
