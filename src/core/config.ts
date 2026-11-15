/** Tunables in one place. Price from https://docs.typesafe.ai/models (2026-11-15); output tokens are free. */
export const PRICE_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** Pinned rather than "jev-latest": aliases move, and thresholds are tuned per model version. */
export const MODEL_ID = "jev-1.14.0";
export const API_BASE = "https://api.typesafe.ai";

/** The hosted service (proxy/). Set at build time with TAB_TRIAGE_SERVICE; also becomes the manifest's host permission. */
declare const __SERVICE_URL__: string | undefined;
export const SERVICE_URL: string = typeof __SERVICE_URL__ === "string" ? __SERVICE_URL__ : "https://tab-triage-pi.vercel.app";

/** True in store builds (npm run package): developer-only features such as mock mode are off. */
declare const __RELEASE__: boolean | undefined;
export const RELEASE: boolean = typeof __RELEASE__ === "boolean" && __RELEASE__;

/** Limits the service enforces on each request (shared by the client and proxy/). */
export const MAX_GROUPS = 12;
export const MAX_DESCRIPTION = 500;

/** Bump when the wording of the questions changes; part of the cache key. */
export const PROMPT_VERSION = "p2";

export const DEFAULT_THRESHOLD = 0.8;
/** Band above the threshold where we double-check with reversed option order. */
export const REASK_BAND = 0.1;

export const TITLE_MAX = 120;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const REQUEST_TIMEOUT_MS = 5_000;
export const MAX_RETRIES = 2;
export const BACKOFF_MS = [500, 1500] as const;
export const RETRY_AFTER_CAP_MS = 5_000;
export const CONCURRENCY = 4;

export const EDIT_RETRY_DELAY_MS = 50;
export const EDIT_RETRY_MAX = 10;
