import type { Classifier } from "../providers/classifier.js";
import { ClassifierError } from "../providers/classifier.js";
import { AnswerCache, cacheKey, groupsHash } from "./cache.js";
import { CONCURRENCY } from "./config.js";
import { decide, domainDecision } from "./decide.js";
import { matchDomain, toModelGroups } from "./groups.js";
import { toTabInput } from "./privacy.js";
import type { Decision, GroupDef, ModelGroup, Order, RawAnswer, SkipReason, TabInput, TabLike } from "./types.js";

export interface TabResult {
  tabId: number;
  title: string;
  site: string | null;
  skipped?: SkipReason;
  decision?: Decision;
  error?: string;
}

export interface RunMetrics {
  eligible: number;
  grouped: number;
  apiCalls: number;
  cacheHits: number;
  inputTokens: number;
  reverseAsks: number;
  /** Tabs left alone because their own request was rejected (400/422/bad response). */
  tabErrors: number;
}

export interface ClassifyOutcome {
  results: TabResult[];
  metrics: RunMetrics;
  /** Set if any classification failed; callers must then move nothing. */
  error: ClassifierError | null;
}

/** Run `fn` over items with at most `n` in flight; stops scheduling new items once `shouldStop()` is true. */
export async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>, shouldStop: () => boolean = () => false): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (!shouldStop() && i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export interface ClassifyArgs {
  tabs: readonly TabLike[];
  groups: readonly GroupDef[];
  blocklist: readonly string[];
  threshold: number;
  classifier: Classifier;
  cache: AnswerCache;
  concurrency?: number;
}

/**
 * Steps 2-5 of the pipeline: filter, domain table, classifier (cache first),
 * decide. Pure with respect to the browser: it never moves a tab.
 */
export async function classifyTabs(a: ClassifyArgs): Promise<ClassifyOutcome> {
  const modelGroups = toModelGroups(a.groups);
  const gHash = await groupsHash(modelGroups);
  const metrics: RunMetrics = { eligible: 0, grouped: 0, apiCalls: 0, cacheHits: 0, inputTokens: 0, reverseAsks: 0, tabErrors: 0 };
  const results: TabResult[] = [];
  const toAsk: { result: TabResult; input: TabInput }[] = [];

  for (const tab of a.tabs) {
    const r: TabResult = { tabId: tab.id, title: tab.title ?? "", site: null };
    results.push(r);
    const el = toTabInput(tab, a.blocklist);
    if (!el.ok) {
      r.skipped = el.reason;
      continue;
    }
    r.site = el.input.site;
    metrics.eligible++;
    const dom = matchDomain(el.input.site, a.groups);
    if (dom) r.decision = domainDecision(dom.id);
    else if (modelGroups.length) toAsk.push({ result: r, input: el.input });
    else r.decision = { groupId: null, leaningGroupId: null, probability: 0, noul: 0, reason: "no-fit" };
  }

  // Any run-level error (auth, rate limit, network, timeout, 5xx) stops new work and cancels in-flight calls.
  const abort = new AbortController();
  let error: ClassifierError | null = null;
  const fail = (e: ClassifierError) => {
    error ??= e;
    abort.abort();
  };

  const ask = async (input: TabInput, order: Order): Promise<RawAnswer> => {
    const key = await cacheKey(input, gHash, a.classifier.model, order);
    // A broken cache must never cost a call or fail a tab: treat it as a miss.
    const hit = await a.cache.get(key).catch(() => null);
    if (hit) {
      metrics.cacheHits++;
      return hit;
    }
    metrics.apiCalls++;
    const ans = await a.classifier.classify(input, modelGroups, order, abort.signal);
    metrics.inputTokens += ans.inputTokens;
    // Never cache mock answers: they must not be served later as if a real model produced them.
    if (!a.classifier.isMock) await a.cache.set(key, ans).catch(() => undefined);
    return ans;
  };

  await pool(
    toAsk,
    a.concurrency ?? CONCURRENCY,
    async ({ result, input }) => {
      try {
        const fwd = await ask(input, "fwd");
        let d = decide(fwd, undefined, modelGroups, a.threshold);
        if (d.reason === "needs-reverse") {
          metrics.reverseAsks++;
          const rev = await ask(input, "rev");
          d = decide(fwd, rev, modelGroups, a.threshold);
        }
        result.decision = d;
      } catch (e) {
        if (error) return; // already aborting; this is just a cancelled sibling
        const err = e instanceof ClassifierError ? e : new ClassifierError("bad_response");
        if (err.perTab) {
          metrics.tabErrors++;
          result.error = err.message;
          result.decision = { groupId: null, leaningGroupId: null, probability: 0, noul: 0, reason: "error" };
          return;
        }
        result.error = err.message;
        fail(err);
      }
    },
    () => error !== null,
  );

  // If every model call was rejected, the problem is the setup (e.g. a retired model id), not the tabs.
  if (!error && toAsk.length > 0 && metrics.tabErrors === toAsk.length) error = new ClassifierError("bad_request");

  metrics.grouped = results.filter((r) => r.decision?.groupId).length;
  return { results, metrics, error };
}

export { toModelGroups, type ModelGroup };
