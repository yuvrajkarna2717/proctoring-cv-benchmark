import { modelAssetPath } from "../config/modelAssets.js";
import { LabError } from "../utils/errors.js";

/**
 * Loading and verifying the model files listed in src/config/modelAssets.js, shared by the
 * engine runtimes. Worker-side code: URLs resolve against the site's origin.
 */

/**
 * Absolute URL of a path below the site's base URL. Works in workers, where relative URLs
 * resolve against the worker script.
 *
 * @param {string} relativePath
 */
export function siteUrl(relativePath) {
  return new URL(`${import.meta.env.BASE_URL}${relativePath}`, self.location.origin).href;
}

/**
 * Fetches a model file from the app's own origin (`public/models/`).
 *
 * @param {import('../config/modelAssets.js').ModelAsset} asset
 * @returns {Promise<Uint8Array>}
 */
export async function fetchModelBytes(asset) {
  const url = siteUrl(modelAssetPath(asset));
  /** @type {Response} */
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new LabError(`Could not fetch the model file ${url}`, {
      code: "MODEL_FETCH_FAILED",
      cause: error,
    });
  }
  if (!response.ok) {
    throw new LabError(
      `The model file ${url} returned HTTP ${response.status}. Run: npm run fetch-models`,
      { code: "MODEL_MISSING" },
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Rejects model bytes whose size or SHA-256 differ from the pinned values.
 *
 * @param {import('../config/modelAssets.js').ModelAsset} asset
 * @param {Uint8Array} bytes
 * @param {string} sha256 hex digest of `bytes`
 * @throws {LabError} code MODEL_INTEGRITY
 */
export function assertModelIntegrity(asset, bytes, sha256) {
  if (bytes.byteLength !== asset.bytes || sha256 !== asset.sha256) {
    throw new LabError(
      `${asset.file} failed verification: ${bytes.byteLength} bytes, sha256 ${sha256}; ` +
        `expected ${asset.bytes} bytes, sha256 ${asset.sha256}. Run: npm run fetch-models`,
      { code: "MODEL_INTEGRITY" },
    );
  }
}
