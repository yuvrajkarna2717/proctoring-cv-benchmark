/**
 * Downloads the model files listed in src/config/modelAssets.js into public/models/ and keeps a
 * file only if its size and SHA-256 match the pinned values. Files that are already present with
 * the right hash are not downloaded again.
 *
 * Usage:
 *   node scripts/fetch-models.mjs            download missing or mismatching files
 *   node scripts/fetch-models.mjs --check    verify only; exit code 1 if a file is missing or wrong
 *   node scripts/fetch-models.mjs --force    download every file again
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL_ASSETS, modelAssetPath } from "../src/config/modelAssets.js";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "..", "public");

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * @param {string} file
 * @returns {Promise<{ bytes: number, sha256: string } | null>} null when the file does not exist
 */
async function inspectFile(file) {
  try {
    const bytes = await readFile(file);
    return { bytes: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * @param {{ checkOnly?: boolean, force?: boolean, log?: (line: string) => void }} [options]
 * @returns {Promise<{ ok: boolean, results: Array<{ id: string, status: string, file: string }> }>}
 */
export async function ensureModels({ checkOnly = false, force = false, log = console.log } = {}) {
  const results = [];
  for (const asset of Object.values(MODEL_ASSETS)) {
    const file = path.join(PUBLIC_DIR, modelAssetPath(asset));
    const relative = path.relative(process.cwd(), file);
    const existing = force ? null : await inspectFile(file);
    if (existing && existing.bytes === asset.bytes && existing.sha256 === asset.sha256) {
      log(`ok        ${asset.id} ${relative}`);
      results.push({ id: asset.id, status: "ok", file });
      continue;
    }
    if (checkOnly) {
      const status = existing ? "mismatch" : "missing";
      log(
        `${status.toUpperCase().padEnd(9)} ${asset.id} ${relative}` +
          (existing ? ` (sha256 ${existing.sha256}, ${existing.bytes} bytes)` : ""),
      );
      results.push({ id: asset.id, status, file });
      continue;
    }
    log(`download  ${asset.id} ${asset.url}`);
    const response = await fetch(asset.url);
    if (!response.ok) {
      log(`FAILED    ${asset.id}: HTTP ${response.status}`);
      results.push({ id: asset.id, status: "download-failed", file });
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = sha256(bytes);
    if (bytes.length !== asset.bytes || hash !== asset.sha256) {
      log(
        `REJECTED  ${asset.id}: got ${bytes.length} bytes, sha256 ${hash}; ` +
          `expected ${asset.bytes} bytes, sha256 ${asset.sha256}`,
      );
      results.push({ id: asset.id, status: "rejected", file });
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.partial`;
    try {
      await writeFile(partial, bytes);
      await rename(partial, file);
    } finally {
      await rm(partial, { force: true });
    }
    log(`saved     ${asset.id} ${relative} (${bytes.length} bytes, sha256 verified)`);
    results.push({ id: asset.id, status: "downloaded", file });
  }
  return { ok: results.every((r) => r.status === "ok" || r.status === "downloaded"), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  const { ok } = await ensureModels({ checkOnly: args.has("--check"), force: args.has("--force") });
  if (!ok) {
    console.error(
      args.has("--check")
        ? "Model files are missing or wrong. Run: npm run fetch-models"
        : "Some model files could not be downloaded or failed verification.",
    );
  }
  process.exitCode = ok ? 0 : 1;
}
