import { z } from "zod";

// The production Content Security Policy forbids eval. Zod 4 otherwise probes `new Function`
// to JIT-compile object parsers; the probe is caught but still raises a CSP violation report.
// jitless must be set before any schema is constructed, so every schema module imports `z`
// from here instead of from "zod".
z.config({ jitless: true });

export { z };
