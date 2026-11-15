/**
 * Shared counters for rate limits and the daily spending cap, kept in Upstash Redis
 * over its REST API (Vercel Marketplace → Upstash). Keys hold only hashes and
 * counts, and expire on their own.
 */
export interface Limiter {
  /** Count one hit for `key` in the current window; true if it is over `limit`. */
  over(key: string, limit: number, windowSec: number): Promise<boolean>;
  tokensToday(day: string): Promise<number>;
  addTokens(day: string, n: number): Promise<void>;
}

export function upstashLimiter(url: string, token: string, f: typeof fetch = fetch): Limiter {
  const base = url.replace(/\/+$/, "");
  async function pipeline(cmds: Array<Array<string | number>>): Promise<Array<{ result?: unknown; error?: string }>> {
    const res = await f(`${base}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) throw new Error(`limiter HTTP ${res.status}`);
    return (await res.json()) as Array<{ result?: unknown; error?: string }>;
  }
  return {
    async over(key, limit, windowSec) {
      const [count] = await pipeline([
        ["INCR", key],
        ["EXPIRE", key, windowSec, "NX"],
      ]);
      return Number(count?.result) > limit;
    },
    async tokensToday(day) {
      const [r] = await pipeline([["GET", `tt:tokens:${day}`]]);
      return Number(r?.result ?? 0) || 0;
    },
    async addTokens(day, n) {
      if (n <= 0) return;
      await pipeline([
        ["INCRBY", `tt:tokens:${day}`, Math.round(n)],
        ["EXPIRE", `tt:tokens:${day}`, 2 * 86_400],
      ]);
    },
  };
}

/** In-memory limiter for tests and local runs. */
export function memoryLimiter(): Limiter & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async over(key, limit) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n > limit;
    },
    async tokensToday(day) {
      return counts.get(`tokens:${day}`) ?? 0;
    },
    async addTokens(day, n) {
      counts.set(`tokens:${day}`, (counts.get(`tokens:${day}`) ?? 0) + n);
    },
  };
}
