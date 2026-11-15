import { MODEL_ID, REQUEST_TIMEOUT_MS, SERVICE_URL } from "../core/config.js";
import type { ModelGroup, Order, RawAnswer, TabInput } from "../core/types.js";
import { type Classifier, ClassifierError } from "./classifier.js";
import { kindFor, postJson, realSleep, retryable } from "./http.js";
import { ERROR_HEADER, type HostedRequest, INSTALL_HEADER, parseHostedAnswer } from "./wire.js";

export interface HostedOptions {
  /** Anonymous random id for this install (rate limiting only). */
  installId: string;
  serviceUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  random?: () => number;
}

const WHO = "The tab-triage service";

/**
 * Calls the hosted tab-triage service, which holds the TypeSafe key. Users need no
 * key; the service only accepts {site, title, groups, order} and builds the
 * TypeSafe questions itself.
 */
export class HostedClassifier implements Classifier {
  readonly isMock = false;
  readonly model = MODEL_ID;
  readonly id = `hosted:${MODEL_ID}`;
  private readonly url: string;
  private readonly installId: string;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly random: () => number;

  constructor(opts: HostedOptions) {
    this.installId = opts.installId;
    this.url = `${(opts.serviceUrl ?? SERVICE_URL).replace(/\/+$/, "")}/api/classify`;
    this.f = opts.fetch ?? fetch.bind(globalThis);
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.random = opts.random ?? Math.random;
  }

  async classify(input: TabInput, groups: readonly ModelGroup[], order: Order, signal?: AbortSignal): Promise<RawAnswer> {
    // Only what the service needs: no local group ids, colours or domains.
    const body: HostedRequest = { v: 1, site: input.site, title: input.title, groups: groups.map(({ key, description }) => ({ key, description })), order };
    const json = await postJson(this.url, { [INSTALL_HEADER]: this.installId }, JSON.stringify(body), {
      fetch: this.f,
      sleep: this.sleep,
      random: this.random,
      timeoutMs: this.timeoutMs,
      who: WHO,
      signal,
      classify: (status, headers) => {
        // The service is paused (daily budget reached or not configured): retrying won't help.
        if (status === 503 && headers.get(ERROR_HEADER)) return { kind: "unavailable", retry: false };
        return { kind: kindFor(status), retry: retryable(status) };
      },
    });
    const answer = parseHostedAnswer(json, groups);
    if (!answer) throw new ClassifierError("bad_response", undefined, 1, WHO);
    return answer;
  }
}
