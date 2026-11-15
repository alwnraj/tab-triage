import { REASK_BAND } from "./config.js";
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
 * The decision rule (see docs/DESIGN.md §5).
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

export function domainDecision(groupId: string): Decision {
  return { groupId, leaningGroupId: groupId, probability: 1, noul: 1, reason: "domain" };
}
