import type { ModelGroup, Order, RawAnswer, TabInput } from "../core/types.js";

/**
 * Any decision provider. The pipeline only depends on this, so a second
 * provider (e.g. Google's Gemini Decisions API) only has to map its own
 * request/response onto RawAnswer.
 */
export interface Classifier {
  /** e.g. "typesafe:jev-1.14.0" or "mock". Shown in the UI and logs. */
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
  | "budget";

const MESSAGES: Record<ClassifierErrorKind, string> = {
  auth: "The API key was rejected. Check it on the Options page.",
  rate_limit: "TypeSafe is rate-limiting requests right now.",
  overloaded: "TypeSafe is temporarily overloaded.",
  bad_request: "TypeSafe rejected the request.",
  bad_response: "TypeSafe returned an unexpected response.",
  timeout: "TypeSafe didn't answer in time.",
  network: "Couldn't reach TypeSafe (network error).",
  server: "TypeSafe had a server error.",
  no_key: "No API key set. Add one on the Options page.",
  budget: "Stopped: the call budget for this run was reached.",
};

/** Never carries the request body or the API key; only a kind and status. */
export class ClassifierError extends Error {
  constructor(
    readonly kind: ClassifierErrorKind,
    readonly status?: number,
    readonly attempts = 1,
  ) {
    super(MESSAGES[kind] + (status ? ` (HTTP ${status})` : "") + (attempts > 1 ? ` after ${attempts} tries` : ""));
    this.name = "ClassifierError";
  }
  /** Errors where trying another tab is pointless: the whole run should stop. */
  get fatal(): boolean {
    return this.kind === "auth" || this.kind === "no_key" || this.kind === "budget";
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
