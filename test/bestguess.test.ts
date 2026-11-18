import { describe, expect, it } from "vitest";
import { bestGuess } from "../src/core/decide.js";
import { toModelGroups } from "../src/core/groups.js";
import { siteGroups, siteName, siteOf } from "../src/core/sites.js";
import type { RawAnswer } from "../src/core/types.js";
import { DEFAULT_GROUPS, LEGACY_DEFAULT_GROUPS, sanitize, upgradeDefaultGroups } from "../src/settings.js";

const MG = toModelGroups([
  { id: "a", name: "Docs", color: "blue", description: "docs", domains: [] },
  { id: "b", name: "Reading", color: "yellow", description: "essays", domains: [] },
  { id: "c", name: "Social", color: "cyan", description: "forums", domains: [] },
]);
const ans = (probs: Record<string, number>, noul: number): RawAnswer => ({ choice: "docs", probabilities: probs, noul, inputTokens: 1, model: "t" });

describe("bestGuess", () => {
  it("takes the top group even at modest confidence, as long as something fits", () => {
    const d = bestGuess(ans({ docs: 0.55, reading: 0.3, social: 0.15 }, 0.7), undefined, MG);
    expect(d).toMatchObject({ groupId: "a", reason: "best-guess" });
    expect(bestGuess(ans({ docs: 0.95, reading: 0.04, social: 0.01 }, 0.9), undefined, MG)).toMatchObject({ groupId: "a", reason: "confident" });
  });
  it("leaves a tab alone only when the Noul says nothing fits", () => {
    expect(bestGuess(ans({ docs: 0.9, reading: 0.05, social: 0.05 }, 0.2), undefined, MG)).toMatchObject({ groupId: null, reason: "no-fit" });
    expect(bestGuess(ans({ docs: 0.9, reading: 0.05, social: 0.05 }, 0.3), undefined, MG).groupId).toBe("a");
  });
  it("asks again with the options reversed on a close call, and averages both answers", () => {
    const fwd = ans({ docs: 0.45, reading: 0.4, social: 0.15 }, 0.8);
    expect(bestGuess(fwd, undefined, MG)).toMatchObject({ groupId: null, reason: "needs-reverse" });
    // Reversed, "reading" wins clearly: the first-option lean explains the forward result.
    const rev = ans({ docs: 0.2, reading: 0.7, social: 0.1 }, 0.8);
    expect(bestGuess(fwd, rev, MG)).toMatchObject({ groupId: "b", reason: "close-call" });
  });
});

describe("site groups for leftovers", () => {
  it("names a group after the site when two or more leftovers share it", () => {
    const { groups, assign } = siteGroups([
      { tabId: 1, site: "en.wikipedia.org", title: "Maillard reaction - Wikipedia" },
      { tabId: 2, site: "de.wikipedia.org", title: "Bayes' theorem - Wikipedia" },
      { tabId: 3, site: "example.com", title: "Only one" },
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Wikipedia"]);
    expect([...assign.keys()]).toEqual([1, 2]);
  });
  it("reduces hostnames to the site, including two-part suffixes and shared hosts", () => {
    expect(siteOf("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("docs.astro.build")).toBe("astro.build");
    expect(siteOf("alice.github.io")).toBe("alice.github.io");
    expect(siteOf("bob.github.io")).not.toBe(siteOf("alice.github.io"));
  });
  it("prefers the brand the titles end with, else the domain name", () => {
    expect(siteName("bbcgoodfood.com", ["Easy curry recipe | Good Food", "Banana bread | Good Food"])).toBe("Good Food");
    expect(siteName("example.org", ["One page", "Another"])).toBe("Example");
    expect(siteName("news.ycombinator.com".split(".").slice(-2).join("."), ["x", "y"])).toBe("Hacker News");
  });
});

describe("default groups", () => {
  it("are specific: twelve groups, each described and most with domains", () => {
    expect(DEFAULT_GROUPS).toHaveLength(12);
    expect(DEFAULT_GROUPS.every((g) => g.description.length > 40)).toBe(true);
    expect(new Set(DEFAULT_GROUPS.map((g) => g.id)).size).toBe(12);
    const all = DEFAULT_GROUPS.flatMap((g) => g.domains);
    expect(new Set(all).size).toBe(all.length); // no domain in two groups
  });
  it("upgrade installs still on the old five untouched, and nobody else", () => {
    const old = sanitize({ groups: LEGACY_DEFAULT_GROUPS, consentAt: 1 });
    expect(upgradeDefaultGroups(old).groups).toEqual(DEFAULT_GROUPS);
    const edited = sanitize({ groups: [{ ...LEGACY_DEFAULT_GROUPS[0]!, name: "My research" }, ...LEGACY_DEFAULT_GROUPS.slice(1)] });
    expect(upgradeDefaultGroups(edited).groups[0]!.name).toBe("My research");
  });
});
