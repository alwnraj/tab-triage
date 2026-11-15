/**
 * Vercel Edge Function entry (bundled by scripts/build-proxy.mjs into
 * .vercel/output/functions/api/classify.func). Configuration comes from the
 * project's environment variables; see proxy/README.md.
 */
import { type Env, handle } from "./handler.js";
import { upstashLimiter } from "./limits.js";

declare const process: { env: Record<string, string | undefined> };

/**
 * Upstash's REST credentials, under whatever prefix the Vercel Marketplace integration
 * was given: UPSTASH_REDIS_REST_URL/_TOKEN (direct), KV_REST_API_URL/_TOKEN (default
 * Marketplace prefix), or <PREFIX>_REST_API_URL/_TOKEN, <PREFIX>_REST_URL/_TOKEN.
 */
export function findUpstash(env: Record<string, string | undefined>): { url?: string; token?: string } {
  for (const [name, value] of Object.entries(env)) {
    const m = /^(.*_REST(?:_API)?)_URL$/.exec(name);
    if (!m || !value?.startsWith("https://")) continue;
    const token = env[`${m[1]}_TOKEN`];
    if (token) return { url: value, token };
  }
  return {};
}

export default async function classify(request: Request): Promise<Response> {
  const env = process.env;
  const { url, token } = findUpstash(env);
  let fetchError: string | null = null;
  return handle(request, env as Env, {
    // Edge runtimes don't all implement the browser-only `cache`/`credentials` fields or
    // redirect "error". "manual" still never follows a redirect with the key attached:
    // a 3xx comes back as a non-2xx response and is treated as an error.
    fetch: async (input, init) => {
      const { cache: _c, credentials: _cr, redirect: _r, ...rest } = init ?? {};
      try {
        return await fetch(input, { ...rest, redirect: "manual" });
      } catch (e) {
        fetchError = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : "unknown";
        throw e;
      }
    },
    now: () => Date.now(),
    limiter: url && token ? upstashLimiter(url, token) : null,
    // Status, outcome and timing only: never the request body.
    log: (e) => console.log(JSON.stringify(e)),
    lastFetchError: () => fetchError,
  });
}
