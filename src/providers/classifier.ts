import type { ModelGroup, Order, RawAnswer, TabInput } from "../core/types.js";

/**
 * Any decision provider. The pipeline only depends on this, so a second
 * provider (e.g. Google's Gemini Decisions API) only has to map its own
 * request/response onto RawAnswer.
 */
export interface Classifier {
  /** e.g. "typesafe:jev-1.14.0", "hosted:jev-1.14.0" or "mock". Shown in the UI and logs. */
  readonly id: string;
  /** Model id used in cache keys. */
  readonly model: string;
  readonly isMock: boolean;
  classify(input: TabInput, groups: readonly ModelGroup[], order: Order, signal?: AbortSignal): Promise<RawAnswer>;
}

export type ClassifierErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "bad_request"
  | "bad_response"
  | "timeout"
  | "network"
  | "server"
  | "no_key"
  | "budget"
  | "unavailable";

/** `who` is the service being called: "TypeSafe" (direct) or "The tab-triage service" (hosted). */
const MESSAGES: Record<ClassifierErrorKind, (who: string) => string> = {
  auth: (w) => (w === "TypeSafe" ? "The API key was rejected." : `${w} refused this request. Try updating the extension.`),
  rate_limit: (w) => `${w} is rate-limiting requests right now. Try again in a minute.`,
  overloaded: (w) => `${w} is temporarily overloaded.`,
  bad_request: (w) => `${w} rejected the request.`,
  bad_response: (w) => `${w} returned an unexpected response.`,
  timeout: (w) => `${w} didn't answer in time.`,
  network: (w) => `Couldn't reach ${w === "TypeSafe" ? w : "the tab-triage service"} (network error).`,
  server: (w) => `${w} had a server error.`,
  no_key: () => "No API key set.",
  budget: () => "Stopped: the call budget for this run was reached.",
  unavailable: (w) => `${w} is paused for today. Try again tomorrow.`,
};

/** Never carries the request body or any key; only a kind and status. */
export class ClassifierError extends Error {
  constructor(
    readonly kind: ClassifierErrorKind,
    readonly status?: number,
    readonly attempts = 1,
    who = "TypeSafe",
  ) {
    super(MESSAGES[kind](who) + (status ? ` (HTTP ${status})` : "") + (attempts > 1 ? ` after ${attempts} tries` : ""));
    this.name = "ClassifierError";
  }
  /** Errors where trying another tab is pointless: the whole run should stop. */
  get fatal(): boolean {
    return this.kind === "auth" || this.kind === "no_key" || this.kind === "budget" || this.kind === "unavailable";
  }
  /**
   * Errors specific to one tab's request (a deterministic 400/422 or a malformed
   * answer). That tab stays ungrouped; the rest of the run proceeds. Anything
   * else (auth, rate limit, network, timeout, 5xx) aborts the run with no moves.
   */
  get perTab(): boolean {
    return this.kind === "bad_request" || this.kind === "bad_response";
  }
}
