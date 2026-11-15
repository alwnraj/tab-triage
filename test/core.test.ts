import { describe, expect, it } from "vitest";
import { AnswerCache, cacheKey, groupsHash, MemoryKV } from "../src/core/cache.js";
import { decide, topOf } from "../src/core/decide.js";
import { matchDomain, ordered, slugKey, toModelGroups } from "../src/core/groups.js";
import { hostMatches, isLocalHost, normalizeDomain, toTabInput, truncateTitle, webHostname } from "../src/core/privacy.js";
import type { GroupDef, RawAnswer } from "../src/core/types.js";

const G: GroupDef[] = [
  { id: "a", name: "Research", color: "blue", description: "Papers and docs", domains: ["arxiv.org"] },
  { id: "b", name: "Shopping", color: "green", description: "Stores and products", domains: [] },
  { id: "c", name: "Mail", color: "red", description: "", domains: ["mail.google.com"] },
];
const MG = toModelGroups(G);
const ans = (probs: Record<string, number>, noul: number, choice?: string): RawAnswer => ({
  choice: choice ?? Object.entries(probs).sort((x, y) => y[1] - x[1])[0]![0],
  probabilities: probs,
  noul,
  inputTokens: 10,
  model: "test",
});

describe("privacy", () => {
  it("keeps only the hostname", () => {
    expect(webHostname("https://Sub.Example.com:8443/a/b?q=secret#frag")).toBe("sub.example.com");
    expect(webHostname("chrome://settings")).toBeNull();
    expect(webHostname("chrome-extension://abc/popup.html")).toBeNull();
    expect(webHostname("file:///Users/me/x.pdf")).toBeNull();
    expect(webHostname("not a url")).toBeNull();
  });
  it("truncates titles to 120 code points without splitting emoji", () => {
    const t = "😀".repeat(130);
    expect(Array.from(truncateTitle(t)).length).toBe(120);
    expect(truncateTitle("  a \n b  ")).toBe("a b");
  });
  it("matches domains on a dot boundary", () => {
    expect(hostMatches("www.bank.com", "bank.com")).toBe(true);
    expect(hostMatches("bank.com", "bank.com")).toBe(true);
    expect(hostMatches("notbank.com", "bank.com")).toBe(false);
    expect(normalizeDomain(" https://WWW.Foo.com/path ")).toBe("www.foo.com");
    expect(normalizeDomain("*.foo.com")).toBe("foo.com");
  });
  it("never sends local hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "192.168.1.4", "intranet", "nas.local", "x.internal"]) expect(isLocalHost(h)).toBe(true);
    expect(isLocalHost("en.wikipedia.org")).toBe(false);
  });
  it("blanks titles that are really URLs (untitled or loading tabs)", () => {
    const base = { id: 1, index: 0, windowId: 1, groupId: -1, pinned: false };
    for (const title of ["https://a.com/reset?token=abc", "a.com/reset?token=abc", "www.a.com/x", "files.example.org/secret.pdf"])
      expect(toTabInput({ ...base, url: "https://a.com/reset?token=abc", title }, [])).toEqual({ ok: true, input: { site: "a.com", title: "" } });
    expect(toTabInput({ ...base, url: "https://a.com/x", title: "Reset your password" }, [])).toMatchObject({ input: { title: "Reset your password" } });
  });
  it("filters ineligible tabs and strips paths", () => {
    const base = { id: 1, index: 0, windowId: 1, groupId: -1, pinned: false, title: "T" };
    expect(toTabInput({ ...base, url: "https://a.com/x?token=1" }, [])).toEqual({ ok: true, input: { site: "a.com", title: "T" } });
    expect(toTabInput({ ...base, pinned: true, url: "https://a.com" }, [])).toEqual({ ok: false, reason: "pinned" });
    expect(toTabInput({ ...base, groupId: 3, url: "https://a.com" }, [])).toEqual({ ok: false, reason: "already-grouped" });
    expect(toTabInput({ ...base, url: "https://www.bank.com" }, ["bank.com"])).toEqual({ ok: false, reason: "blocklisted" });
    expect(toTabInput({ ...base, url: "http://localhost:3000" }, [])).toEqual({ ok: false, reason: "local" });
  });
});

describe("groups", () => {
  it("builds non-numeric unique keys and drops domain-only groups", () => {
    expect(slugKey("2024")).toBe("g_2024");
    expect(slugKey("日本")).toBe("g_group");
    const mg = toModelGroups([...G, { id: "d", name: "research!", color: "grey", description: "x", domains: [] }]);
    expect(mg.map((g) => g.key)).toEqual(["g_research", "g_shopping", "g_research_2"]);
  });
  it("reversal really reverses JSON key order, even for numeric-looking names", () => {
    const mg = toModelGroups([
      { id: "1", name: "2024", color: "grey", description: "x", domains: [] },
      { id: "2", name: "Alpha", color: "grey", description: "y", domains: [] },
    ]);
    const obj = Object.fromEntries(ordered(mg, "rev").map((g) => [g.key, g.description]));
    expect(Object.keys(JSON.parse(JSON.stringify(obj)))).toEqual(["g_alpha", "g_2024"]);
  });
  it("domain table", () => {
    expect(matchDomain("www.arxiv.org", G)?.id).toBe("a");
    expect(matchDomain("example.com", G)).toBeNull();
  });
});

describe("decide", () => {
  const t = 0.8;
  it("reads probabilities by key", () => {
    expect(topOf(ans({ g_shopping: 0.7, g_research: 0.3 }, 1), MG)?.key).toBe("g_shopping");
  });
  it("needs both the Choice and the companion Noul", () => {
    expect(decide(ans({ g_research: 0.95, g_shopping: 0.05 }, 0.95), undefined, MG, t)).toMatchObject({ groupId: "a", reason: "confident" });
    expect(decide(ans({ g_research: 0.95, g_shopping: 0.05 }, 0.5), undefined, MG, t)).toMatchObject({ groupId: null, reason: "no-fit" });
    expect(decide(ans({ g_research: 0.6, g_shopping: 0.4 }, 0.99), undefined, MG, t)).toMatchObject({ groupId: null, reason: "low-prob" });
  });
  it("re-asks only in the band just above the threshold", () => {
    const near = ans({ g_research: 0.85, g_shopping: 0.15 }, 0.95);
    expect(decide(near, undefined, MG, t).reason).toBe("needs-reverse");
    expect(decide(near, ans({ g_research: 0.82, g_shopping: 0.18 }, 0.9), MG, t)).toMatchObject({ groupId: "a", reason: "order-agree" });
    expect(decide(near, ans({ g_research: 0.4, g_shopping: 0.6 }, 0.9), MG, t)).toMatchObject({ groupId: null, reason: "order-disagree" });
    // Below threshold: no rescue, no re-ask.
    expect(decide(ans({ g_research: 0.75, g_shopping: 0.25 }, 0.95), undefined, MG, t).reason).toBe("low-prob");
  });
  it("treats missing or non-finite probabilities as absent", () => {
    expect(decide(ans({ g_research: Number.NaN }, 0.99, "g_research"), undefined, MG, t).reason).toBe("low-prob");
  });
});

describe("cache", () => {
  it("expires after the TTL and keys on everything that matters", async () => {
    let now = 0;
    const kv = new MemoryKV();
    const c = new AnswerCache(kv, () => now, 1000);
    const h = await groupsHash(MG);
    const k = await cacheKey({ site: "a.com", title: "T" }, h, "m", "fwd");
    await c.set(k, ans({ g_research: 1 }, 1));
    expect(await c.get(k)).not.toBeNull();
    expect(k).not.toBe(await cacheKey({ site: "a.com", title: "T" }, h, "m", "rev"));
    expect(k).not.toBe(await cacheKey({ site: "a.com", title: "T" }, h, "mock", "fwd"));
    expect(h).not.toBe(await groupsHash(toModelGroups([{ ...G[0]!, description: "changed" }, G[1]!])));
    now = 1001;
    expect(await c.get(k)).toBeNull();
    expect(kv.map.size).toBe(0);
  });
  it("stores no hostname or title in values", async () => {
    const kv = new MemoryKV();
    const c = new AnswerCache(kv);
    const k = await cacheKey({ site: "secret-host.com", title: "Secret title" }, "h", "m", "fwd");
    await c.set(k, ans({ g_research: 1 }, 1));
    expect(JSON.stringify([...kv.map])).not.toMatch(/secret/i);
  });
  it("prunes expired entries", async () => {
    let now = 0;
    const kv = new MemoryKV();
    const c = new AnswerCache(kv, () => now, 10);
    await c.set("cache:x", ans({ g_research: 1 }, 1));
    now = 5;
    await c.set("cache:y", ans({ g_research: 1 }, 1));
    now = 12;
    expect(await c.prune()).toBe(1);
    expect([...kv.map.keys()]).toEqual(["cache:y"]);
  });
});
