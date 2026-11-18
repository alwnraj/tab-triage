import { DEFAULT_THRESHOLD } from "./core/config.js";
import type { KV } from "./core/cache.js";
import { GROUP_COLORS, type GroupColor, type GroupDef } from "./core/types.js";

export interface Settings {
  groups: GroupDef[];
  blocklist: string[];
  threshold: number;
  /** true: only group tabs the model is sure about (threshold). false (default): best guess. */
  strict: boolean;
  collapse: boolean;
  /** Developer/rehearsal toggle. Every run made with it is labelled MOCK. */
  mockMode: boolean;
  /** Epoch ms when the user accepted the first-run consent screen; null = not yet. */
  consentAt: number | null;
}

/** The five groups 1.0.x shipped with; installs still using them unchanged are upgraded. */
export const LEGACY_DEFAULT_GROUPS: GroupDef[] = [
  { id: "research", name: "Research", color: "blue", description: "Academic papers, encyclopedia articles, technical documentation and reference material", domains: ["arxiv.org"] },
  { id: "code", name: "Code", color: "purple", description: "Source code repositories, issue trackers, package registries and programming Q&A", domains: [] },
  { id: "news", name: "News", color: "red", description: "News articles and current-events reporting", domains: [] },
  { id: "cooking", name: "Cooking", color: "orange", description: "Recipes, cooking techniques and food", domains: [] },
  { id: "shopping", name: "Shopping", color: "green", description: "Online stores, product pages and price comparisons", domains: [] },
];

export const DEFAULT_GROUPS: GroupDef[] = [
  { id: "docs", name: "Docs & Reference", color: "blue", description: "Documentation, API and language references, encyclopedia and wiki articles, and how-to answers people look things up in.", domains: ["developer.mozilla.org", "docs.python.org", "wikipedia.org", "wiktionary.org", "stackoverflow.com", "stackexchange.com", "superuser.com", "serverfault.com", "readthedocs.io", "learn.microsoft.com", "devdocs.io", "docs.rs", "pkg.go.dev", "docs.github.com", "caniuse.com", "react.dev", "kubernetes.io"] },
  { id: "code", name: "Code & Repos", color: "purple", description: "Source code repositories, pull requests, issues, CI runs, package registries and developer dashboards.", domains: ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "npmjs.com", "pypi.org", "crates.io", "rubygems.org", "hub.docker.com", "vercel.com", "netlify.com", "replit.com", "codesandbox.io", "codepen.io", "huggingface.co"] },
  { id: "papers", name: "Papers", color: "cyan", description: "Academic papers, preprints, journal articles and research datasets.", domains: ["arxiv.org", "scholar.google.com", "semanticscholar.org", "researchgate.net", "biorxiv.org", "medrxiv.org", "ssrn.com", "pubmed.ncbi.nlm.nih.gov", "sciencedirect.com", "link.springer.com", "dl.acm.org", "ieeexplore.ieee.org", "openreview.net", "jstor.org", "plos.org", "pnas.org", "paperswithcode.com"] },
  { id: "reading", name: "Reading List", color: "yellow", description: "Personal and company blogs, opinion and analysis pieces, essays, long-form articles and newsletters, read for interest rather than to look something up.", domains: ["medium.com", "substack.com", "longreads.com", "newyorker.com", "theatlantic.com", "aeon.co", "paulgraham.com"] },
  { id: "headlines", name: "Headlines", color: "red", description: "News reports and current-events coverage from news sites and tech news.", domains: ["nytimes.com", "washingtonpost.com", "wsj.com", "reuters.com", "apnews.com", "bbc.com", "cnn.com", "theguardian.com", "npr.org", "bloomberg.com", "ft.com", "economist.com", "axios.com", "politico.com", "aljazeera.com", "news.google.com", "theverge.com", "arstechnica.com", "techcrunch.com", "wired.com"] },
  { id: "shopping", name: "Shopping", color: "green", description: "Product pages, online stores, carts, deals, and product reviews or comparisons read before buying.", domains: ["amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.in", "ebay.com", "etsy.com", "walmart.com", "target.com", "bestbuy.com", "costco.com", "ikea.com", "aliexpress.com", "temu.com", "wayfair.com", "homedepot.com", "newegg.com", "backmarket.com", "rtings.com"] },
  { id: "recipes", name: "Recipes", color: "orange", description: "Recipes, cooking techniques, baking, and meal planning.", domains: ["allrecipes.com", "seriouseats.com", "bbcgoodfood.com", "cooking.nytimes.com", "epicurious.com", "bonappetit.com", "food52.com", "kingarthurbaking.com", "budgetbytes.com", "simplyrecipes.com", "smittenkitchen.com", "minimalistbaker.com", "foodnetwork.com", "thekitchn.com"] },
  { id: "watch", name: "Watch & Listen", color: "pink", description: "Videos, streaming shows and films, music, podcasts and live streams.", domains: ["youtube.com", "youtu.be", "netflix.com", "twitch.tv", "vimeo.com", "spotify.com", "music.apple.com", "tv.apple.com", "podcasts.apple.com", "soundcloud.com", "hulu.com", "disneyplus.com", "max.com", "primevideo.com", "crunchyroll.com", "nebula.tv", "pocketcasts.com"] },
  { id: "social", name: "Social", color: "cyan", description: "Social media feeds, forums, link aggregators, discussion threads and community posts.", domains: ["reddit.com", "x.com", "twitter.com", "instagram.com", "facebook.com", "threads.net", "bsky.app", "mastodon.social", "news.ycombinator.com", "lobste.rs", "tiktok.com", "pinterest.com", "tumblr.com", "quora.com", "linkedin.com"] },
  { id: "work", name: "Work & Inbox", color: "grey", description: "Email, calendars, team chat, shared documents and spreadsheets, project boards, CRMs and other work apps.", domains: ["mail.google.com", "calendar.google.com", "docs.google.com", "drive.google.com", "meet.google.com", "outlook.live.com", "outlook.office.com", "teams.microsoft.com", "slack.com", "notion.so", "figma.com", "linear.app", "atlassian.net", "trello.com", "asana.com", "monday.com", "airtable.com", "zoom.us", "miro.com", "clickup.com", "hubspot.com", "dropbox.com"] },
  { id: "trips", name: "Trips", color: "blue", description: "Flights, hotels, rentals, routes between places, maps and travel guides for planning a trip.", domains: ["booking.com", "airbnb.com", "expedia.com", "kayak.com", "tripadvisor.com", "skyscanner.net", "hotels.com", "vrbo.com", "maps.google.com", "rome2rio.com", "seatguru.com", "lonelyplanet.com", "japan-guide.com", "flightaware.com"] },
  { id: "learning", name: "Learning", color: "yellow", description: "Online courses, tutorials, lessons, coding exercises and study material.", domains: ["coursera.org", "udemy.com", "khanacademy.org", "edx.org", "brilliant.org", "duolingo.com", "freecodecamp.org", "theodinproject.com", "exercism.org", "leetcode.com", "codecademy.com", "ocw.mit.edu", "w3schools.com", "datacamp.com"] },
];

export const DEFAULT_SETTINGS: Settings = {
  groups: DEFAULT_GROUPS,
  blocklist: [],
  threshold: DEFAULT_THRESHOLD,
  strict: false,
  collapse: false,
  mockMode: false,
  consentAt: null,
};

const SETTINGS_KEY = "settings";

function isColor(c: unknown): c is GroupColor {
  return typeof c === "string" && (GROUP_COLORS as readonly string[]).includes(c);
}

/** Defensive parse: storage could hold anything from an older version. */
export function sanitize(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Settings>;
  const groups = Array.isArray(r.groups)
    ? r.groups
        .filter((g): g is GroupDef => !!g && typeof g.id === "string" && typeof g.name === "string" && g.name.trim() !== "")
        .map((g) => ({
          id: g.id,
          name: g.name.trim().slice(0, 40),
          color: isColor(g.color) ? g.color : "grey",
          description: typeof g.description === "string" ? g.description.slice(0, 500) : "",
          domains: Array.isArray(g.domains) ? g.domains.filter((d): d is string => typeof d === "string") : [],
        }))
    : DEFAULT_SETTINGS.groups;
  const t = typeof r.threshold === "number" && r.threshold >= 0.5 && r.threshold <= 0.99 ? r.threshold : DEFAULT_THRESHOLD;
  return {
    groups,
    blocklist: Array.isArray(r.blocklist) ? r.blocklist.filter((d): d is string => typeof d === "string") : [],
    threshold: t,
    strict: r.strict === true,
    collapse: r.collapse === true,
    mockMode: r.mockMode === true,
    consentAt: typeof r.consentAt === "number" ? r.consentAt : null,
  };
}

export async function loadSettings(kv: KV): Promise<Settings> {
  return sanitize((await kv.get([SETTINGS_KEY]))[SETTINGS_KEY] ?? DEFAULT_SETTINGS);
}
export async function saveSettings(kv: KV, s: Settings): Promise<void> {
  await kv.set({ [SETTINGS_KEY]: sanitize(s) });
}
const INSTALL_ID_KEY = "installId";
/**
 * An anonymous random id for this install, sent to the hosted service for rate
 * limiting only. Not derived from anything about the user or the browser.
 */
export async function installId(kv: KV): Promise<string> {
  const v = (await kv.get([INSTALL_ID_KEY]))[INSTALL_ID_KEY];
  if (typeof v === "string" && v) return v;
  const id = crypto.randomUUID();
  await kv.set({ [INSTALL_ID_KEY]: id });
  return id;
}

/** chrome.storage area as a KV. */
export function chromeKV(area: chrome.storage.StorageArea): KV {
  return {
    get: (keys) => area.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
    keys: async (prefix) => Object.keys(await area.get(null)).filter((k) => k.startsWith(prefix)),
  };
}

/** 1.0.x installs still on the old five defaults (unchanged) move to the new defaults. */
export function upgradeDefaultGroups(s: Settings): Settings {
  const same = JSON.stringify(s.groups) === JSON.stringify(LEGACY_DEFAULT_GROUPS);
  return same ? { ...s, groups: DEFAULT_GROUPS } : s;
}
