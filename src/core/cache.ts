import { CACHE_TTL_MS, PROMPT_VERSION } from "./config.js";
import { sha256Hex } from "./hash.js";
import type { ModelGroup, Order, RawAnswer, TabInput } from "./types.js";

/** Minimal key-value store; chrome.storage.local in the extension, a Map in tests and scripts. */
export interface KV {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** All keys with the given prefix. */
  keys(prefix: string): Promise<string[]>;
}

export const CACHE_PREFIX = "cache:";

interface Entry {
  at: number;
  answer: RawAnswer;
}

/** Hash of the model-eligible groups in canonical (forward) order. Any edit invalidates the cache. */
export async function groupsHash(groups: readonly ModelGroup[]): Promise<string> {
  return sha256Hex(JSON.stringify(groups.map((g) => [g.key, g.description])));
}

export async function cacheKey(input: TabInput, gHash: string, model: string, order: Order): Promise<string> {
  // Only the hash is stored as a key; the value holds no hostname or title.
  return CACHE_PREFIX + (await sha256Hex([input.site, input.title, gHash, model, PROMPT_VERSION, order].join("\n")));
}

export class AnswerCache {
  constructor(
    private kv: KV,
    private now: () => number = Date.now,
    private ttl = CACHE_TTL_MS,
  ) {}

  async get(key: string): Promise<RawAnswer | null> {
    const got = (await this.kv.get([key]))[key] as Entry | undefined;
    if (!got || typeof got.at !== "number") return null;
    if (this.now() - got.at > this.ttl) {
      await this.kv.remove([key]);
      return null;
    }
    return got.answer;
  }

  async set(key: string, answer: RawAnswer): Promise<void> {
    await this.kv.set({ [key]: { at: this.now(), answer } satisfies Entry });
  }

  /** Drop expired entries. Returns how many were removed. */
  async prune(): Promise<number> {
    const keys = await this.kv.keys(CACHE_PREFIX);
    if (!keys.length) return 0;
    const all = await this.kv.get(keys);
    const dead = keys.filter((k) => {
      const e = all[k] as Entry | undefined;
      return !e || typeof e.at !== "number" || this.now() - e.at > this.ttl;
    });
    if (dead.length) await this.kv.remove(dead);
    return dead.length;
  }

  async clear(): Promise<void> {
    const keys = await this.kv.keys(CACHE_PREFIX);
    if (keys.length) await this.kv.remove(keys);
  }
}

/** In-memory KV for tests and Node scripts. */
export class MemoryKV implements KV {
  readonly map = new Map<string, unknown>();
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (this.map.has(k)) out[k] = structuredClone(this.map.get(k));
    return out;
  }
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.map.set(k, structuredClone(v));
  }
  async remove(keys: string[]) {
    for (const k of keys) this.map.delete(k);
  }
  async keys(prefix: string) {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}
