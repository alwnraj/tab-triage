import {
  API_BASE,
  BACKOFF_MS,
  MAX_RETRIES,
  MODEL_ID,
  REQUEST_TIMEOUT_MS,
  RETRY_AFTER_CAP_MS,
} from "../core/config.js";
import type { ModelGroup, Order, RawAnswer, TabInput } from "../core/types.js";
import { type Classifier, ClassifierError } from "./classifier.js";
import { buildRequest } from "./request.js";

export interface TypeSafeOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Called once per HTTP attempt; lets scripts enforce a hard call budget. */
  onAttempt?: () => void;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Status codes worth retrying (per docs.typesafe.ai/api/errors: 429 and 529 back off and retry). */
function retryable(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}

function kindFor(status: number): ClassifierError["kind"] {
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
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - now;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** Validate and reduce a SystemOneResponse to a RawAnswer. */
export function parseResponse(body: unknown, groups: readonly ModelGroup[]): RawAnswer {
  const b = body as {
    model?: unknown;
    answers?: { group?: { type?: unknown; choice?: unknown; probabilities?: unknown }; fits?: { type?: unknown; noul?: unknown } };
    usage?: { input_tokens?: unknown };
  };
  const g = b?.answers?.group;
  const f = b?.answers?.fits;
  if (!g || g.type !== "choice" || typeof g.choice !== "string" || !g.probabilities || typeof g.probabilities !== "object")
    throw new ClassifierError("bad_response");
  const inRange = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  if (!f || f.type !== "noul" || !inRange(f.noul)) throw new ClassifierError("bad_response");
  const probabilities: Record<string, number> = {};
  for (const grp of groups) {
    const p = (g.probabilities as Record<string, unknown>)[grp.key];
    probabilities[grp.key] = inRange(p) ? p : 0;
  }
  if (!groups.some((x) => x.key === g.choice)) throw new ClassifierError("bad_response");
  const tokens = b.usage?.input_tokens;
  return {
    choice: g.choice,
    probabilities,
    noul: f.noul,
    inputTokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0,
    model: typeof b.model === "string" ? b.model : "unknown",
  };
}

export class TypeSafeClassifier implements Classifier {
  readonly isMock = false;
  readonly model: string;
  readonly id: string;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly random: () => number;

  /** True-private field: logging or JSON-serialising the classifier can't reveal the key. */
  readonly #apiKey: string;
  private readonly onAttempt?: () => void;

  constructor(opts: TypeSafeOptions) {
    if (!opts.apiKey) throw new ClassifierError("no_key");
    this.#apiKey = opts.apiKey;
    this.onAttempt = opts.onAttempt;
    this.model = opts.model ?? MODEL_ID;
    this.id = `typesafe:${this.model}`;
    this.f = opts.fetch ?? fetch.bind(globalThis);
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.random = opts.random ?? Math.random;
  }

  async classify(input: TabInput, groups: readonly ModelGroup[], order: Order, signal?: AbortSignal): Promise<RawAnswer> {
    const body = JSON.stringify(buildRequest(this.model, input, groups, order));
    let last: ClassifierError = new ClassifierError("network");
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new ClassifierError("timeout", undefined, attempt);
      this.onAttempt?.();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const onOuterAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      let retryAfter: number | null = null;
      try {
        const res = await this.f(`${API_BASE}/v1/systemone`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
          body,
          signal: ctrl.signal,
          // Never follow a redirect with the bearer token, send no cookies, cache nothing.
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        });
        if (res.ok) {
          let json: unknown;
          try {
            json = await res.json();
          } catch {
            // A timeout while reading the body is a timeout (retryable), not a bad answer.
            if (ctrl.signal.aborted) throw new ClassifierError("timeout", undefined, attempt + 1);
            throw new ClassifierError("bad_response", res.status);
          }
          return parseResponse(json, groups);
        }
        last = new ClassifierError(kindFor(res.status), res.status, attempt + 1);
        if (!retryable(res.status)) throw last;
        retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      } catch (e) {
        if (e instanceof ClassifierError) {
          if (!e.status || !retryable(e.status)) {
            if (e.kind !== "network" && e.kind !== "timeout") throw e;
          }
          last = e;
        } else if (ctrl.signal.aborted) {
          last = new ClassifierError("timeout", undefined, attempt + 1);
        } else {
          last = new ClassifierError("network", undefined, attempt + 1);
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
      if (attempt < MAX_RETRIES) {
        const base = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
        await this.sleep(Math.max(retryAfter ?? 0, base + Math.floor(this.random() * 100)));
      }
    }
    throw last;
  }
}
