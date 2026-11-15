import { DEFAULT_THRESHOLD } from "./core/config.js";
import type { KV } from "./core/cache.js";
import { GROUP_COLORS, type GroupColor, type GroupDef } from "./core/types.js";

export interface Settings {
  groups: GroupDef[];
  blocklist: string[];
  threshold: number;
  collapse: boolean;
  /** Developer/rehearsal toggle. Every run made with it is labelled MOCK. */
  mockMode: boolean;
  /** Epoch ms when the user accepted the first-run consent screen; null = not yet. */
  consentAt: number | null;
}

export const DEFAULT_GROUPS: GroupDef[] = [
  { id: "research", name: "Research", color: "blue", description: "Academic papers, encyclopedia articles, technical documentation and reference material", domains: ["arxiv.org"] },
  { id: "code", name: "Code", color: "purple", description: "Source code repositories, issue trackers, package registries and programming Q&A", domains: [] },
  { id: "news", name: "News", color: "red", description: "News articles and current-events reporting", domains: [] },
  { id: "cooking", name: "Cooking", color: "orange", description: "Recipes, cooking techniques and food", domains: [] },
  { id: "shopping", name: "Shopping", color: "green", description: "Online stores, product pages and price comparisons", domains: [] },
];

export const DEFAULT_SETTINGS: Settings = {
  groups: DEFAULT_GROUPS,
  blocklist: [],
  threshold: DEFAULT_THRESHOLD,
  collapse: false,
  mockMode: false,
  consentAt: null,
};

const SETTINGS_KEY = "settings";
const API_KEY_KEY = "apiKey";

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
/** Earlier versions stored the user's own TypeSafe key; the hosted service made it unnecessary. */
export async function removeLegacyApiKey(kv: KV): Promise<void> {
  await kv.remove([API_KEY_KEY]);
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
