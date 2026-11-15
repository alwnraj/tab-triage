import { decide, topOf } from "../src/core/decide.js";
import type { ModelGroup, RawAnswer } from "../src/core/types.js";

/** One evaluated tab: ground-truth label (a group id or "none") and both orderings' raw answers. */
export interface EvalRow {
  site: string;
  title: string;
  label: string; // group id or "none"
  source: "domain" | "model";
  /** For domain rows: the group the table picked. */
  domainGroup?: string;
  fwd?: RawAnswer;
  rev?: RawAnswer;
}

export interface ThresholdPoint {
  threshold: number;
  eligible: number;
  grouped: number;
  correct: number;
  coverage: number; // grouped / eligible
  accuracy: number | null; // correct / grouped
  /** Tabs labelled "none" that got grouped anyway. */
  falseGroupings: number;
}

export function sweep(rows: readonly EvalRow[], groups: readonly ModelGroup[], thresholds: readonly number[]): ThresholdPoint[] {
  return thresholds.map((t) => {
    let grouped = 0;
    let correct = 0;
    let falseGroupings = 0;
    for (const r of rows) {
      const g = r.source === "domain" ? (r.domainGroup ?? null) : r.fwd ? decide(r.fwd, r.rev, groups, t).groupId : null;
      if (!g) continue;
      grouped++;
      if (g === r.label) correct++;
      if (r.label === "none") falseGroupings++;
    }
    return {
      threshold: t,
      eligible: rows.length,
      grouped,
      correct,
      coverage: rows.length ? grouped / rows.length : 0,
      accuracy: grouped ? correct / grouped : null,
      falseGroupings,
    };
  });
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number;
  observed: number;
}

/** Reliability diagram: bucket predictions, compare mean prediction to observed frequency. */
export function reliability(pairs: ReadonlyArray<[number, boolean]>, nBins = 10): { bins: Bin[]; ece: number } {
  const bins: Bin[] = Array.from({ length: nBins }, (_, i) => ({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, meanPredicted: 0, observed: 0 }));
  for (const [p, y] of pairs) {
    const i = Math.min(nBins - 1, Math.max(0, Math.floor(p * nBins)));
    const b = bins[i]!;
    b.n++;
    b.meanPredicted += p;
    b.observed += y ? 1 : 0;
  }
  let ece = 0;
  const total = pairs.length || 1;
  for (const b of bins) {
    if (!b.n) continue;
    b.meanPredicted /= b.n;
    b.observed /= b.n;
    ece += (b.n / total) * Math.abs(b.meanPredicted - b.observed);
  }
  return { bins, ece };
}

/** Calibration pairs for the Choice (top prob vs correct, on tabs whose label is a group) and the Noul (fit vs label != none). */
export function calibrationPairs(rows: readonly EvalRow[], groups: readonly ModelGroup[]) {
  const choice: Array<[number, boolean]> = [];
  const noul: Array<[number, boolean]> = [];
  for (const r of rows) {
    if (r.source !== "model" || !r.fwd) continue; // domain rows (p = 1) would flatter calibration
    const top = topOf(r.fwd, groups);
    const topGroup = groups.find((g) => g.key === top?.key)?.groupId;
    if (top && r.label !== "none") choice.push([top.p, topGroup === r.label]);
    noul.push([r.fwd.noul, r.label !== "none"]);
  }
  return { choice, noul };
}

/** How often reversing option order changed anything: a check that the server honours key order at all. */
export function orderStats(rows: readonly EvalRow[], groups: readonly ModelGroup[]) {
  let both = 0;
  let identical = 0;
  let choiceFlips = 0;
  for (const r of rows) {
    if (!r.fwd || !r.rev) continue;
    both++;
    const same = groups.every((g) => Math.abs((r.fwd!.probabilities[g.key] ?? 0) - (r.rev!.probabilities[g.key] ?? 0)) < 1e-9);
    if (same) identical++;
    if (topOf(r.fwd, groups)?.key !== topOf(r.rev, groups)?.key) choiceFlips++;
  }
  return { pairs: both, identicalRate: both ? identical / both : null, choiceFlipRate: both ? choiceFlips / both : null };
}
