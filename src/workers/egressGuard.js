/**
 * Blocks network requests from a worker to any origin other than the app's own, independently of
 * the Content Security Policy (which the dev server does not send).
 *
 * Why: MediaPipe Tasks Vision 1.2.2 batches usage statistics (task type, running mode, platform,
 * library version, call counts, latencies) and POSTs them to https://odml.pa.googleapis.com/v1/log
 * every 60 s and when a task is closed. The lab must not send anything to another origin, so
 * such requests are refused here and reported to the main thread instead.
 *
 * Covered APIs: fetch, XMLHttpRequest, WebSocket, EventSource. Same-origin, blob:, and data:
 * URLs are allowed, and WebSockets to the same host and port (the Vite dev client in workers;
 * CSP `'self'` allows these too).
 *
 * @param {any} scope the worker global scope (`self`), or a test double with `location`
 * @param {{ onBlocked?: (request: { url: string, api: string }) => void }} [options]
 */
export function installEgressGuard(scope, { onBlocked } = {}) {
  const { origin, host } = scope.location;
  /** @param {unknown} url */
  const isAllowed = (url) => {
    try {
      const parsed = new URL(String(url), scope.location.href);
      if (parsed.protocol === "data:" || parsed.origin === origin) return true;
      return (parsed.protocol === "ws:" || parsed.protocol === "wss:") && parsed.host === host;
    } catch {
      return false;
    }
  };
  /**
   * @param {unknown} url
   * @param {string} api
   */
  const refuse = (url, api) => {
    try {
      onBlocked?.({ url: String(url), api });
    } catch {
      // Reporting must never turn a refused request into a crash of the caller.
    }
    return new TypeError(`Blocked by the lab's egress guard (${api}): ${String(url)}`);
  };

  if (typeof scope.fetch === "function") {
    const originalFetch = scope.fetch.bind(scope);
    scope.fetch = (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit=} */ init) => {
      const url = typeof input === "object" && "url" in input ? input.url : input;
      if (!isAllowed(url)) return Promise.reject(refuse(url, "fetch"));
      return originalFetch(input, init);
    };
  }

  if (typeof scope.XMLHttpRequest === "function") {
    const originalOpen = scope.XMLHttpRequest.prototype.open;
    scope.XMLHttpRequest.prototype.open = function open(
      /** @type {string} */ method,
      /** @type {string | URL} */ url,
      /** @type {unknown[]} */ ...rest
    ) {
      if (!isAllowed(url)) throw refuse(url, "XMLHttpRequest");
      return originalOpen.call(this, method, url, ...rest);
    };
  }

  for (const api of ["WebSocket", "EventSource"]) {
    const Original = scope[api];
    if (typeof Original !== "function") continue;
    scope[api] = new Proxy(Original, {
      construct(target, args, newTarget) {
        if (!isAllowed(args[0])) throw refuse(args[0], api);
        return Reflect.construct(target, args, newTarget);
      },
    });
  }
}
