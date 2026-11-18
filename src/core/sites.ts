import type { GroupDef } from "./types.js";

/** Public suffixes with a second level, so "bbc.co.uk" stays one site rather than "co.uk". */
const SECOND_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "co.in", "com.br", "com.mx", "co.za"]);
/** Hosts where each subdomain is a different person's site. */
const SHARED_HOSTS = new Set(["github.io", "substack.com", "medium.com", "blogspot.com", "wordpress.com", "netlify.app", "vercel.app", "pages.dev"]);

/** The site a hostname belongs to: "en.wikipedia.org" → "wikipedia.org", "news.bbc.co.uk" → "bbc.co.uk". */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  const last2 = parts.slice(-2).join(".");
  if (SHARED_HOSTS.has(last2)) return parts.slice(-3).join(".");
  return parts.slice(SECOND_LEVEL.has(last2) ? -3 : -2).join(".");
}

const KNOWN: Record<string, string> = {
  "ycombinator.com": "Hacker News",
  "github.com": "GitHub",
  "youtube.com": "YouTube",
  "linkedin.com": "LinkedIn",
  "stackoverflow.com": "Stack Overflow",
};
const SEPARATORS = / [-|–—·:] | :: /;

/**
 * A short, human name for a site group. Prefer the brand the pages themselves end their
 * titles with ("… - Wikipedia", "… | Good Food"); fall back to the domain name.
 */
export function siteName(site: string, titles: readonly string[]): string {
  if (KNOWN[site]) return KNOWN[site];
  const tails = titles.map((t) => t.split(SEPARATORS).pop()?.trim() ?? "").filter((t) => t && t.length <= 30);
  if (tails.length === titles.length && new Set(tails.map((t) => t.toLowerCase())).size === 1) return tails[0]!;
  const label = site.split(".")[0] ?? site;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Groups for leftover tabs: two or more ungrouped tabs from the same site become one group
 * named after it. Deterministic and local: no model call.
 */
export function siteGroups(leftovers: ReadonlyArray<{ tabId: number; site: string; title: string }>): { groups: GroupDef[]; assign: Map<number, string> } {
  const bySite = new Map<string, { tabId: number; title: string }[]>();
  for (const t of leftovers) {
    const s = siteOf(t.site);
    bySite.set(s, [...(bySite.get(s) ?? []), { tabId: t.tabId, title: t.title }]);
  }
  const groups: GroupDef[] = [];
  const assign = new Map<number, string>();
  for (const [site, tabs] of bySite) {
    if (tabs.length < 2) continue;
    const id = `site:${site}`;
    groups.push({ id, name: siteName(site, tabs.map((t) => t.title)), color: "grey", description: "", domains: [] });
    for (const t of tabs) assign.set(t.tabId, id);
  }
  return { groups, assign };
}
