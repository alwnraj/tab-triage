import { API_BASE, MODEL_ID, REQUEST_TIMEOUT_MS } from "../core/config.js";
import type { ModelGroup, Order, RawAnswer, TabInput } from "../core/types.js";
import { type Classifier, ClassifierError } from "./classifier.js";
import { postJson, realSleep } from "./http.js";
import { buildRequest } from "./request.js";

export { parseRetryAfter } from "./http.js";

export interface TypeSafeOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Called once per HTTP attempt; lets scripts enforce a hard call budget. */
  onAttempt?: () => void;
  random?: () => number;
  /** Retries after the first attempt (default MAX_RETRIES). */
  retries?: number;
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

/**
 * Calls TypeSafe directly with a key. Used by the dev scripts (probe, eval) and by
 * the hosted service in proxy/. The published extension uses HostedClassifier.
 */
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
  private readonly retries?: number;

  constructor(opts: TypeSafeOptions) {
    if (!opts.apiKey) throw new ClassifierError("no_key");
    this.#apiKey = opts.apiKey;
    this.onAttempt = opts.onAttempt;
    this.retries = opts.retries;
    this.model = opts.model ?? MODEL_ID;
    this.id = `typesafe:${this.model}`;
    this.f = opts.fetch ?? fetch.bind(globalThis);
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.random = opts.random ?? Math.random;
  }

  async classify(input: TabInput, groups: readonly ModelGroup[], order: Order, signal?: AbortSignal): Promise<RawAnswer> {
    const json = await postJson(
      `${API_BASE}/v1/systemone`,
      { authorization: `Bearer ${this.#apiKey}` },
      JSON.stringify(buildRequest(this.model, input, groups, order)),
      { fetch: this.f, sleep: this.sleep, random: this.random, timeoutMs: this.timeoutMs, who: "TypeSafe", signal, onAttempt: this.onAttempt, retries: this.retries },
    );
    return parseResponse(json, groups);
  }
}
