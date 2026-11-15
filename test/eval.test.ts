import { describe, expect, it } from "vitest";
import { toModelGroups } from "../src/core/groups.js";
import type { RawAnswer } from "../src/core/types.js";
import { calibrationPairs, type EvalRow, orderStats, reliability, sweep } from "../eval/metrics.js";

const MG = toModelGroups([
  { id: "a", name: "A", color: "blue", description: "a", domains: [] },
  { id: "b", name: "B", color: "red", description: "b", domains: [] },
]);
const ans = (pa: number, noul: number): RawAnswer => ({ choice: pa >= 0.5 ? "a" : "b", probabilities: { a: pa, b: 1 - pa }, noul, inputTokens: 1, model: "t" });

describe("eval metrics", () => {
  const rows: EvalRow[] = [
    { site: "x", title: "1", label: "a", source: "model", fwd: ans(0.99, 0.99), rev: ans(0.99, 0.99) },
    { site: "x", title: "2", label: "b", source: "model", fwd: ans(0.95, 0.95), rev: ans(0.95, 0.95) }, // confidently wrong
    { site: "x", title: "3", label: "none", source: "model", fwd: ans(0.9, 0.2), rev: ans(0.9, 0.2) }, // noul saves it
    { site: "x", title: "4", label: "a", source: "model", fwd: ans(0.7, 0.9), rev: ans(0.7, 0.9) }, // low prob
    { site: "d", title: "5", label: "a", source: "domain", domainGroup: "a" },
  ];
  it("sweeps coverage and accuracy", () => {
    const [p50, , , , , , p80] = sweep(rows, MG, [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]);
    expect(p50).toMatchObject({ grouped: 4, correct: 3, eligible: 5 });
    expect(p80).toMatchObject({ grouped: 3, correct: 2, falseGroupings: 0 });
    expect(p80!.accuracy).toBeCloseTo(2 / 3);
  });
  it("leaves domain rows out of calibration", () => {
    const { choice, noul } = calibrationPairs(rows, MG);
    expect(choice).toHaveLength(3); // rows 1, 2, 4 (row 3 is labelled none)
    expect(noul).toHaveLength(4);
  });
  it("computes reliability and ECE", () => {
    const r = reliability([[0.95, true], [0.95, false], [0.15, false]]);
    expect(r.bins[9]).toMatchObject({ n: 2, observed: 0.5 });
    expect(r.ece).toBeCloseTo((2 / 3) * 0.45 + (1 / 3) * 0.15);
  });
  it("flags when reversal never changes anything", () => {
    expect(orderStats(rows, MG).identicalRate).toBe(1);
  });
});

