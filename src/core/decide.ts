import { CLOSE_CALL, DEFAULT_THRESHOLD, FIT_MIN, REASK_BAND } from "./config.js";
import type { Decision, ModelGroup, RawAnswer } from "./types.js";

/** Top option by probability, read by key (response order is not request order). */
export function topOf(answer: RawAnswer, groups: readonly ModelGroup[]): { key: string; p: number } | null {
  let best: { key: string; p: number } | null = null;
  for (const g of groups) {
    const p = answer.probabilities[g.key];
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    if (!best || p > best.p) best = { key: g.key, p };
  }
  return best;
}

/**
 * The decision rule.
 *   1. noul < t or p < t        -> ungrouped
 *   2. p >= t + band            -> grouped
 *   3. t <= p < t + band        -> grouped only if the reversed-order answer picks the same key
 * The reversed answer can only veto; it never rescues a failing answer.
 */
export function decide(
  fwd: RawAnswer,
  rev: RawAnswer | undefined,
  groups: readonly ModelGroup[],
  threshold: number,
  band = REASK_BAND,
): Decision {
  const top = topOf(fwd, groups);
  const byKey = (k: string | undefined) => groups.find((g) => g.key === k)?.groupId ?? null;
  const leaning = byKey(top?.key);
  const base = { leaningGroupId: leaning, probability: top?.p ?? 0, noul: fwd.noul };

  if (!top) return { ...base, groupId: null, reason: "low-prob" };
  if (!(fwd.noul >= threshold)) return { ...base, groupId: null, reason: "no-fit" };
  if (!(top.p >= threshold)) return { ...base, groupId: null, reason: "low-prob" };
  if (top.p >= threshold + band) return { ...base, groupId: leaning, reason: "confident" };

  if (!rev) return { ...base, groupId: null, reason: "needs-reverse" };
  const revTop = topOf(rev, groups);
  if (revTop?.key === top.key) return { ...base, groupId: leaning, reason: "order-agree" };
  return { ...base, groupId: null, reason: "order-disagree" };
}

/**
 * Best-guess rule (the default): put the tab in its most likely group unless nothing fits.
 *   1. noul < FIT_MIN                    -> ungrouped ("no-fit")
 *   2. top two within CLOSE_CALL, no rev -> "needs-reverse"
 *   3. close call with rev               -> argmax of the two orders' average ("close-call")
 *   4. otherwise                         -> top option ("confident" at >= 0.8, else "best-guess")
 * Averaging both orders cancels the model's lean toward whichever option is listed first.
 */
export function bestGuess(fwd: RawAnswer, rev: RawAnswer | undefined, groups: readonly ModelGroup[], fitMin = FIT_MIN, close = CLOSE_CALL): Decision {
  const ranked = groups
    .map((g) => ({ key: g.key, p: fwd.probabilities[g.key] ?? 0 }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => b.p - a.p);
  const byKey = (k: string | undefined) => groups.find((g) => g.key === k)?.groupId ?? null;
  const top = ranked[0];
  const base = { leaningGroupId: byKey(top?.key), probability: top?.p ?? 0, noul: fwd.noul };

  if (!top) return { ...base, groupId: null, reason: "low-prob" };
  if (!(fwd.noul >= fitMin)) return { ...base, groupId: null, reason: "no-fit" };
  if (top.p - (ranked[1]?.p ?? 0) >= close)
    return { ...base, groupId: base.leaningGroupId, reason: top.p >= DEFAULT_THRESHOLD ? "confident" : "best-guess" };

  if (!rev) return { ...base, groupId: null, reason: "needs-reverse" };
  const avg = groups
    .map((g) => ({ key: g.key, p: ((fwd.probabilities[g.key] ?? 0) + (rev.probabilities[g.key] ?? 0)) / 2 }))
    .sort((a, b) => b.p - a.p)[0]!;
  const id = byKey(avg.key);
  return { leaningGroupId: id, groupId: id, probability: avg.p, noul: (fwd.noul + rev.noul) / 2, reason: "close-call" };
}

export function domainDecision(groupId: string): Decision {
  return { groupId, leaningGroupId: groupId, probability: 1, noul: 1, reason: "domain" };
}
