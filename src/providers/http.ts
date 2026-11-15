import { BACKOFF_MS, MAX_RETRIES, RETRY_AFTER_CAP_MS } from "../core/config.js";
import { ClassifierError, type ClassifierErrorKind } from "./classifier.js";

/** One POST with a per-attempt timeout, bounded retries with backoff, and honest error kinds. Shared by both providers. */
export interface PostOptions {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  timeoutMs: number;
  /** Shown in error messages: "TypeSafe" or "The tab-triage service". */
  who: string;
  signal?: AbortSignal;
  /** Called once per HTTP attempt; lets scripts enforce a hard call budget. */
  onAttempt?: () => void;
  /** Retries after the first attempt (default MAX_RETRIES). The hosted service uses 0: the client retries. */
  retries?: number;
  /** Map a non-2xx response to an error kind and whether retrying can help. */
  classify?: (status: number, headers: Headers) => { kind: ClassifierErrorKind; retry: boolean };
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Status codes worth retrying (per docs.typesafe.ai/api/errors: 429 and 529 back off and retry). */
export function retryable(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}

export function kindFor(status: number): ClassifierErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server";
  return "bad_request";
}

/** retry-after in seconds (or an HTTP date), capped. */
export function parseRetryAfter(h: string | null, now = Date.now()): number | null {
  if (!h) return null;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - now;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

const defaultClassify = (status: number) => ({ kind: kindFor(status), retry: retryable(status) });

export async function postJson(url: string, headers: Record<string, string>, body: string, o: PostOptions): Promise<unknown> {
  const classify = o.classify ?? defaultClassify;
  const err = (kind: ClassifierErrorKind, status?: number, attempts?: number) => new ClassifierError(kind, status, attempts, o.who);
  let last = err("network");
  const retries = o.retries ?? MAX_RETRIES;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (o.signal?.aborted) throw err("timeout", undefined, attempt);
    o.onAttempt?.();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    o.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let retryAfter: number | null = null;
    // Each attempt ends in exactly one outcome: an answer, a stop, or a retry.
    let outcome: { done: unknown } | { stop: ClassifierError } | { retry: ClassifierError };
    try {
      const res = await o.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: ctrl.signal,
        // Never follow a redirect with credentials, send no cookies, cache nothing.
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      if (res.ok) {
        try {
          outcome = { done: await res.json() };
        } catch {
          // A timeout while reading the body is a timeout (retryable), not a bad answer.
          outcome = ctrl.signal.aborted ? { retry: err("timeout", undefined, attempt + 1) } : { stop: err("bad_response", res.status) };
        }
      } else {
        const c = classify(res.status, res.headers);
        const e = err(c.kind, res.status, attempt + 1);
        if (c.retry) retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        outcome = c.retry ? { retry: e } : { stop: e };
      }
    } catch {
      outcome = { retry: err(ctrl.signal.aborted ? "timeout" : "network", undefined, attempt + 1) };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onOuterAbort);
    }
    if ("done" in outcome) return outcome.done;
    if ("stop" in outcome) throw outcome.stop;
    last = outcome.retry;
    if (attempt < retries) {
      const base = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
      await o.sleep(Math.max(retryAfter ?? 0, base + Math.floor(o.random() * 100)));
    }
  }
  throw last;
}
