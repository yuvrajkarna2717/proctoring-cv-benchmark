/**
 * Saves `data` as a pretty-printed JSON file through a temporary object URL. Nothing is sent
 * over the network.
 *
 * @param {string} filename
 * @param {unknown} data
 */
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** @param {string} prefix */
export function timestampedFilename(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}
