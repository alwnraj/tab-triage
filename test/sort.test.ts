import { describe, expect, it } from "vitest";
import { withEditRetry } from "../src/browser/adapter.js";
import { AnswerCache, MemoryKV } from "../src/core/cache.js";
import { toModelGroups } from "../src/core/groups.js";
import { classifyTabs } from "../src/core/pipeline.js";
import { buildPlan, restoreSnapshot, type Snapshot, takeSnapshot } from "../src/core/plan.js";
import { runSort } from "../src/core/sort.js";
import type { GroupDef, ModelGroup, Order, RawAnswer, TabInput } from "../src/core/types.js";
import { type Classifier, ClassifierError } from "../src/providers/classifier.js";
import { FakeBrowser } from "./fakeBrowser.js";

const GROUPS: GroupDef[] = [
  { id: "r", name: "Research", color: "blue", description: "papers", domains: ["arxiv.org"] },
  { id: "k", name: "Cooking", color: "orange", description: "recipes", domains: [] },
];
const W = 7;

/** Scripted classifier: answers by title keyword; can be told to fail. */
class Scripted implements Classifier {
  id = "scripted";
  model = "scripted";
  isMock = false;
  calls: Array<[string, Order]> = [];
  constructor(
    private table: Record<string, { fwd: [number, number, number]; rev?: [number, number, number] }>,
    private failWith?: ClassifierError,
  ) {}
  async classify(input: TabInput, groups: readonly ModelGroup[], order: Order): Promise<RawAnswer> {
    this.calls.push([input.title, order]);
    if (this.failWith) throw this.failWith;
    const row = this.table[input.title];
    if (!row) throw new ClassifierError("bad_request", 422);
    const [pr, pk, noul] = order === "rev" && row.rev ? row.rev : row.fwd;
    const probabilities = { [groups[0]!.key]: pr, [groups[1]!.key]: pk };
    return { choice: pr >= pk ? groups[0]!.key : groups[1]!.key, probabilities, noul, inputTokens: 100, model: "scripted" };
  }
}

const tabs = () => [
  { url: "https://arxiv.org/abs/1706.03762", title: "Attention paper" }, // 1 domain table
  { url: "https://food.example.org/pasta", title: "Pasta recipe" }, // 2 confident cooking
  { url: "https://news.example.org/x", title: "Unrelated news" }, // 3 noul low
  { url: "https://blog.example.org/y", title: "Borderline" }, // 4 near threshold, rev agrees
  { url: "https://blog.example.org/z", title: "Flip" }, // 5 near threshold, rev disagrees
  { url: "chrome://settings", title: "Settings" }, // 6 skipped
  { url: "https://pinned.example.org", title: "Pinned", pinned: true }, // 7 skipped
];
const TABLE = {
  "Pasta recipe": { fwd: [0.03, 0.97, 0.98] as [number, number, number] },
  "Unrelated news": { fwd: [0.9, 0.1, 0.1] as [number, number, number] },
  Borderline: { fwd: [0.85, 0.15, 0.95] as [number, number, number], rev: [0.81, 0.19, 0.9] as [number, number, number] },
  Flip: { fwd: [0.84, 0.16, 0.95] as [number, number, number], rev: [0.3, 0.7, 0.9] as [number, number, number] },
};

function setup(failWith?: ClassifierError) {
  const b = new FakeBrowser(W, tabs());
  const classifier = new Scripted(TABLE, failWith);
  const kv = new MemoryKV();
  let saved: Snapshot | null = null;
  const deps = {
    browser: b,
    classifier,
    cache: new AnswerCache(kv),
    saveSnapshot: async (s: Snapshot) => void (saved = s),
    clearSnapshot: async () => void (saved = null),
  };
  const req = { windowId: W, threshold: 0.8, strict: true, collapse: true, groups: GROUPS, blocklist: [] };
  return { b, classifier, kv, deps, req, saved: () => saved as Snapshot | null };
}

describe("classifyTabs", () => {
  it("applies the funnel: skip → domain table → model → threshold → order check", async () => {
    const { deps, req, classifier } = setup();
    const out = await classifyTabs({ ...req, tabs: await deps.browser.tabsInWindow(W), classifier, cache: deps.cache });
    const by = Object.fromEntries(out.results.map((r) => [r.tabId, r]));
    expect(by[1]!.decision).toMatchObject({ groupId: "r", reason: "domain" });
    expect(by[2]!.decision).toMatchObject({ groupId: "k", reason: "confident" });
    expect(by[3]!.decision).toMatchObject({ groupId: null, reason: "no-fit" });
    expect(by[4]!.decision).toMatchObject({ groupId: "r", reason: "order-agree" });
    expect(by[5]!.decision).toMatchObject({ groupId: null, reason: "order-disagree" });
    expect(by[6]!.skipped).toBe("not-web");
    expect(by[7]!.skipped).toBe("pinned");
    // Domain-table tab never reaches the model; only near-threshold tabs get a reverse call.
    expect(classifier.calls.map((c) => c[0])).not.toContain("Attention paper");
    expect(classifier.calls.filter((c) => c[1] === "rev").map((c) => c[0]).sort()).toEqual(["Borderline", "Flip"]);
    expect(out.metrics).toMatchObject({ eligible: 5, grouped: 3, apiCalls: 6, inputTokens: 600, reverseAsks: 2 });
  });
  it("serves the second run from cache", async () => {
    const { deps, req, classifier } = setup();
    const args = { ...req, tabs: await deps.browser.tabsInWindow(W), classifier, cache: deps.cache };
    await classifyTabs(args);
    const second = await classifyTabs(args);
    expect(second.metrics.apiCalls).toBe(0);
    expect(second.metrics.cacheHits).toBe(6);
    expect(second.metrics.inputTokens).toBe(0);
  });
  it("makes no call when every group is domain-only", async () => {
    const { deps, classifier } = setup();
    const out = await classifyTabs({
      tabs: await deps.browser.tabsInWindow(W),
      groups: [{ ...GROUPS[0]!, description: "" }],
      blocklist: [],
      threshold: 0.8,
      strict: true,
      classifier,
      cache: deps.cache,
    });
    expect(classifier.calls).toHaveLength(0);
    expect(out.metrics.grouped).toBe(1);
  });
});

describe("runSort", () => {
  it("groups, names, colours and collapses; snapshot saved before moving", async () => {
    const { b, deps, req, saved } = setup();
    const before = b.look();
    const rep = await runSort(req, deps);
    expect(rep.ok).toBe(true);
    expect(rep.metrics.movedTabs).toBe(3);
    expect(b.groups.map((g) => [g.title, g.color, g.collapsed])).toEqual([
      ["Research", "blue", true],
      ["Cooking", "orange", true],
    ]);
    expect(rep.metrics.estCostUsd).toBeCloseTo(600 * 0.042e-6, 12);
    expect(saved()).not.toBeNull();
    expect((await restoreSnapshot(b, saved()!)).exact).toBe(true);
    expect(b.look()).toBe(before);
    expect(b.groups).toHaveLength(0);
  });
  it("moves nothing when the API fails for the run", async () => {
    const { b, deps, req, saved } = setup(new ClassifierError("timeout", undefined, 3));
    const before = b.strip();
    const rep = await runSort(req, deps);
    expect(rep.ok).toBe(false);
    expect(rep.message).toMatch(/No tabs were moved/);
    expect(b.strip()).toBe(before);
    expect(saved()).toBeNull();
  });
  it("leaves a tab whose own request is rejected, and sorts the rest", async () => {
    const { b, deps, req } = setup();
    b.tabs.push({ id: 99, index: 7, windowId: W, groupId: -1, pinned: false, url: "https://weird.example.org", title: "Unknown to script" });
    const rep = await runSort(req, deps);
    expect(rep.ok).toBe(true);
    expect(rep.metrics.tabErrors).toBe(1);
    expect(rep.message).toMatch(/rejected by the API/);
    expect(b.tabs.find((t) => t.id === 99)!.groupId).toBe(-1);
  });
  it("aborts remaining work on a run-level error instead of grinding through every tab", async () => {
    const { deps, req, classifier } = setup(new ClassifierError("timeout", undefined, 3));
    const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://s${i}.example.org/`, title: `Tab ${i}` }));
    deps.browser = new FakeBrowser(W, many);
    const rep = await runSort(req, deps);
    expect(rep.ok).toBe(false);
    expect(classifier.calls.length).toBeLessThanOrEqual(4); // only the first in-flight batch
  });
  it("treats 'every model call rejected' as a setup problem, not per-tab noise", async () => {
    const { deps, req } = setup();
    deps.browser = new FakeBrowser(W, [{ url: "https://a.example.org", title: "nope 1" }, { url: "https://b.example.org", title: "nope 2" }]);
    const rep = await runSort(req, deps);
    expect(rep.ok).toBe(false);
    expect(rep.message).toMatch(/No tabs were moved/);
  });
  it("never caches mock answers", async () => {
    const { deps, req, kv, classifier } = setup();
    classifier.isMock = true;
    await runSort(req, deps);
    expect([...kv.map.keys()].filter((k) => k.startsWith("cache:"))).toHaveLength(0);
  });
  it("stops the whole run on an auth error", async () => {
    const { deps, req, classifier } = setup(new ClassifierError("auth", 401));
    const rep = await runSort(req, deps);
    expect(rep.ok).toBe(false);
    expect(rep.message).toMatch(/API key/);
    expect(classifier.calls.length).toBeLessThanOrEqual(4); // in-flight only, no new work scheduled
  });
  it("skips tabs that changed during classification", async () => {
    const { b, deps, req } = setup();
    const origClassify = deps.classifier.classify.bind(deps.classifier);
    deps.classifier.classify = async (...args) => {
      b.tabs.find((t) => t.id === 2)!.title = "Navigated elsewhere";
      return origClassify(...args);
    };
    const rep = await runSort(req, deps);
    expect(rep.metrics.staleTabs).toBe(1);
    expect(b.tabs.find((t) => t.id === 2)!.groupId).toBe(-1);
  });
  it("rolls back if Chrome refuses a move mid-apply", async () => {
    const { b, deps, req, saved } = setup();
    const before = b.strip();
    b.failGroupCall = 2;
    const rep = await runSort(req, deps);
    expect(rep.ok).toBe(false);
    expect(rep.message).toMatch(/rolled back/);
    expect(b.strip()).toBe(before);
    expect(saved()).toBeNull(); // no Undo offered for a run that changed nothing
  });
  it("reuses an existing group with the same title and restores its look on undo", async () => {
    const { b, deps, req, saved } = setup();
    const gid = await b.group([3], W);
    await b.updateGroup(gid, { title: "cooking", color: "pink", collapsed: false });
    const before = b.look();
    await runSort(req, deps);
    expect(b.tabs.find((t) => t.id === 2)!.groupId).toBe(gid);
    expect((await restoreSnapshot(b, saved()!)).exact).toBe(true);
    expect(b.look()).toBe(before);
    expect(b.groups.find((g) => g.id === gid)).toMatchObject({ title: "cooking", color: "pink", collapsed: false });
  });
});

describe("undo edge cases", () => {
  it("keeps a pre-existing group intact when new groups form around it", async () => {
    // [L1, G1, G2, L2] with G pre-existing; sort L1 and L2 into a new group; Undo.
    const b = new FakeBrowser(W, [
      { url: "https://food.example.org/1", title: "Pasta recipe" },
      { url: "https://g.example.org/1", title: "G1" },
      { url: "https://g.example.org/2", title: "G2" },
      { url: "https://food.example.org/2", title: "Pasta recipe" },
    ]);
    const gid = await b.group([2, 3], W);
    await b.updateGroup(gid, { title: "Mine", color: "pink", collapsed: false });
    const before = b.look();
    let saved: Snapshot | null = null;
    const rep = await runSort(
      { windowId: W, threshold: 0.8, strict: true, collapse: true, groups: GROUPS, blocklist: [] },
      {
        browser: b,
        classifier: new Scripted(TABLE),
        cache: new AnswerCache(new MemoryKV()),
        saveSnapshot: async (s) => void (saved = s),
        clearSnapshot: async () => void (saved = null),
      },
    );
    expect(rep.metrics.movedTabs).toBe(2);
    expect(b.look()).not.toBe(before);
    const r = await restoreSnapshot(b, saved!);
    expect(r.exact).toBe(true);
    expect(b.look()).toBe(before);
    expect(b.groups.find((g) => g.id === gid)).toMatchObject({ title: "Mine", color: "pink" });
  });
  it("restores interleaved loose tabs and several groups exactly, and the active tab", async () => {
    const specs = Array.from({ length: 9 }, (_, i) => ({ url: `https://x${i}.example.org`, title: `T${i}` }));
    const b = new FakeBrowser(W, specs);
    const g1 = await b.group([2, 3], W);
    await b.updateGroup(g1, { title: "A", color: "blue", collapsed: true });
    const g2 = await b.group([6, 7, 8], W);
    await b.updateGroup(g2, { title: "B", color: "red", collapsed: false });
    await b.activate(5);
    const snap = await takeSnapshot(b, W);
    const before = b.look();
    // Scramble: new group pulling loose tabs together, regroup some members, move things around.
    const n = await b.group([1, 9, 4], W);
    await b.updateGroup(n, { title: "New", color: "green", collapsed: true });
    await b.ungroup([7]);
    await b.moveGroup(g1, b.tabs.length - 2);
    await b.activate(1);
    const r = await restoreSnapshot(b, snap);
    expect(r.exact).toBe(true);
    expect(b.look()).toBe(before);
  });
  it("recreates a pre-existing group that Chrome deleted and tolerates closed tabs", async () => {
    const b = new FakeBrowser(W, tabs());
    const gid = await b.group([2, 3], W);
    await b.updateGroup(gid, { title: "Mine", color: "red", collapsed: false });
    const snap = await takeSnapshot(b, W);
    await b.ungroup([2, 3]); // group disappears
    b.tabs = b.tabs.filter((t) => t.id !== 5); // a tab was closed
    const r = await restoreSnapshot(b, snap);
    expect(r.missing).toBe(1);
    const g = b.groups.find((x) => x.title === "Mine")!;
    expect(g).toMatchObject({ color: "red" });
    expect(b.tabs.filter((t) => t.groupId === g.id).map((t) => t.id)).toEqual([2, 3]);
  });
});

describe("buildPlan", () => {
  it("keeps the user's group order and skips empty groups", () => {
    const steps = buildPlan(
      [
        { tabId: 1, groupId: "k" },
        { tabId: 2, groupId: "r" },
        { tabId: 3, groupId: null },
      ],
      GROUPS,
      [],
    );
    expect(steps.map((s) => [s.group.id, s.tabIds])).toEqual([
      ["r", [2]],
      ["k", [1]],
    ]);
  });
});

describe("withEditRetry", () => {
  it("retries Chrome's drag error and gives up on other errors", async () => {
    let n = 0;
    await expect(
      withEditRetry(async () => {
        if (n++ < 2) throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
        return "ok";
      }, 1),
    ).resolves.toBe("ok");
    expect(n).toBe(3);
    await expect(withEditRetry(async () => Promise.reject(new Error("other")), 1)).rejects.toThrow("other");
  });
  it("works end to end with a busy strip", async () => {
    const b = new FakeBrowser(W, tabs());
    b.busy = 3;
    const realGroup = b.group.bind(b);
    b.group = (ids, w, g) => withEditRetry(() => realGroup(ids, w, g), 1);
    expect(await b.group([1], W)).toBeGreaterThan(0);
  });
});

void toModelGroups;
