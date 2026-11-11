import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * @typedef {Object} VendorPackage
 * @property {string} name npm package name
 * @property {string} version exact version the app code expects
 * @property {string} versionSource where that version is declared, for the error message
 * @property {string} dir directory below the site's base URL
 * @property {readonly string[]} files package export subpaths to serve, e.g. "x.wasm"
 * @property {string} bundledAs how the package's JavaScript reaches the build, for the notice
 */

/**
 * Serves (dev server) and emits (build) runtime files of npm packages, such as WASM binaries and
 * their loaders, under `<base>/<dir>/`. The app never loads them from a CDN, the files always
 * match the bundled JavaScript of the same package, and the build fails if the installed version
 * differs from the version the app code expects. Each directory gets a LICENSE-NOTICE.txt,
 * because Vite's license report covers only packages bundled into the main chunk.
 *
 * @param {readonly VendorPackage[]} packages
 * @param {{ headers?: Record<string, string> }} [options] extra headers for dev responses (the
 *   dev server applies `server.headers` to its own middlewares, not to this one)
 * @returns {import('vite').Plugin}
 */
export function vendorAssetsPlugin(packages, { headers = {} } = {}) {
  const require = createRequire(import.meta.url);
  let base = "/";
  /** @type {Map<VendorPackage, { files: Map<string, string>, info: PackageInfo }>} */
  const resolved = new Map();

  /** @param {VendorPackage} vendor */
  const resolveVendor = (vendor) => {
    const cached = resolved.get(vendor);
    if (cached) return cached;
    const files = new Map(
      vendor.files.map((name) => [name, require.resolve(`${vendor.name}/${name}`)]),
    );
    const info = readPackageInfo(/** @type {string} */ (files.values().next().value), vendor.name);
    if (info.version !== vendor.version) {
      throw new Error(
        `${vendor.name} ${info.version} is installed, but ${vendor.versionSource} expects ` +
          `${vendor.version}. Update the constant together with the package.`,
      );
    }
    const entry = { files, info };
    resolved.set(vendor, entry);
    return entry;
  };

  return {
    name: "cv-lab-vendor-assets",
    configResolved(config) {
      base = config.base;
      // Fail at startup, not on the first request, if a package is missing or has another version.
      for (const vendor of packages) resolveVendor(vendor);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        for (const vendor of packages) {
          const prefix = `${base}${vendor.dir}/`;
          if (!url.startsWith(prefix)) continue;
          const file = resolveVendor(vendor).files.get(url.slice(prefix.length));
          if (!file) return next();
          for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
          response.setHeader(
            "Content-Type",
            CONTENT_TYPES[/** @type {keyof typeof CONTENT_TYPES} */ (path.extname(file))],
          );
          response.setHeader("Content-Length", statSync(file).size);
          response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          response.setHeader("Cache-Control", "no-cache");
          createReadStream(file).pipe(response);
          return undefined;
        }
        return next();
      });
    },
    async generateBundle() {
      for (const vendor of packages) {
        const { files, info } = resolveVendor(vendor);
        for (const [name, file] of files) {
          this.emitFile({
            type: "asset",
            fileName: `${vendor.dir}/${name}`,
            source: await readFile(file),
          });
        }
        this.emitFile({
          type: "asset",
          fileName: `${vendor.dir}/LICENSE-NOTICE.txt`,
          source: licenseNotice(vendor, info),
        });
      }
    },
  };
}

/** @typedef {{ version: string, license: string, homepage?: string, hasLicenseFile: boolean }} PackageInfo */

/**
 * Finds the package.json of `name` above one of its files.
 *
 * @param {string} file
 * @param {string} name
 * @returns {PackageInfo}
 */
function readPackageInfo(file, name) {
  let directory = path.dirname(file);
  for (;;) {
    const candidate = path.join(directory, "package.json");
    if (existsSync(candidate)) {
      const json = JSON.parse(readFileSync(candidate, "utf8"));
      if (json.name === name) {
        const repository =
          typeof json.repository === "string" ? json.repository : json.repository?.url;
        return {
          version: json.version,
          license: json.license,
          homepage: json.homepage ?? repository,
          hasLicenseFile: ["LICENSE", "LICENSE.md", "LICENSE.txt"].some((license) =>
            existsSync(path.join(directory, license)),
          ),
        };
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`package.json of ${name} not found above ${file}`);
    directory = parent;
  }
}

/**
 * @param {VendorPackage} vendor
 * @param {PackageInfo} info
 */
function licenseNotice(vendor, info) {
  return [
    `${vendor.name} ${info.version}`,
    `License: ${info.license} (as declared in the package's package.json${
      info.hasLicenseFile
        ? "; the package's LICENSE file has the full text"
        : "; the npm package ships no LICENSE file"
    }).`,
    `Homepage: ${info.homepage ?? "unknown"}`,
    "",
    `Files in this directory: ${vendor.files.join(", ")} (unmodified copies from the package).`,
    vendor.bundledAs,
    "",
  ].join("\n");
}
