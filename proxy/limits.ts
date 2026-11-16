/**
 * Counters for rate limits and spending caps, in Upstash Redis over its REST API.
 * Keys hold only hashes and counts and expire on their own.
 *
 * admit() does everything in one round trip and reserves an estimate of the request's
 * tokens up front (INCRBY returns the new total, so the check-and-reserve is atomic):
 * parallel requests can't overshoot a cap. settle() corrects the reservation afterwards.
 * Any Redis error throws; the handler then fails closed.
 */
export interface Keys {
  install: string; // per-install, per-minute
  ip: string; // per-IP, per-minute
  day: string; // everyone, per-day tokens
  ipDay: string; // per-IP, per-day tokens
}
export interface Admission {
  installCount: number;
  ipCount: number;
  dayTokens: number;
  ipDayTokens: number;
}
export interface Limiter {
  admit(keys: Keys, reserveTokens: number): Promise<Admission>;
  /** Add `delta` tokens (negative to release) to the daily counters. */
  settle(keys: Pick<Keys, "day" | "ipDay">, delta: number): Promise<void>;
}

const MINUTE = 60;
const TWO_DAYS = 2 * 86_400;

export function upstashLimiter(url: string, token: string, f: typeof fetch = fetch): Limiter {
  const base = url.replace(/\/+$/, "");
  async function pipeline(cmds: Array<Array<string | number>>): Promise<number[]> {
    const res = await f(`${base}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) throw new Error(`limiter HTTP ${res.status}`);
    const out = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    // Upstash answers 200 even when a command fails; each entry carries its own error.
    if (!Array.isArray(out) || out.length !== cmds.length) throw new Error("limiter: bad reply");
    return out.map((r, i) => {
      if (r.error) throw new Error(`limiter: ${String(cmds[i]![0])} failed`);
      const n = Number(r.result);
      if (!Number.isFinite(n)) throw new Error(`limiter: ${String(cmds[i]![0])} gave no number`);
      return n;
    });
  }
  return {
    async admit(k, reserve) {
      const r = await pipeline([
        ["INCR", k.install], ["EXPIRE", k.install, MINUTE, "NX"],
        ["INCR", k.ip], ["EXPIRE", k.ip, MINUTE, "NX"],
        ["INCRBY", k.day, reserve], ["EXPIRE", k.day, TWO_DAYS, "NX"],
        ["INCRBY", k.ipDay, reserve], ["EXPIRE", k.ipDay, TWO_DAYS, "NX"],
      ]);
      return { installCount: r[0]!, ipCount: r[2]!, dayTokens: r[4]!, ipDayTokens: r[6]! };
    },
    async settle(k, delta) {
      if (!delta) return;
      await pipeline([
        ["INCRBY", k.day, Math.round(delta)],
        ["INCRBY", k.ipDay, Math.round(delta)],
      ]);
    },
  };
}

/** In-memory limiter for tests and local runs. */
export function memoryLimiter(): Limiter & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const add = (k: string, n: number) => {
    const v = (counts.get(k) ?? 0) + n;
    counts.set(k, v);
    return v;
  };
  return {
    counts,
    async admit(k, reserve) {
      return { installCount: add(k.install, 1), ipCount: add(k.ip, 1), dayTokens: add(k.day, reserve), ipDayTokens: add(k.ipDay, reserve) };
    },
    async settle(k, delta) {
      add(k.day, delta);
      add(k.ipDay, delta);
    },
  };
}
