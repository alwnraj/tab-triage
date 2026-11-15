/**
 * Vercel Edge Function entry (bundled by scripts/build-proxy.mjs into
 * .vercel/output/functions/api/classify.func). Configuration comes from the
 * project's environment variables; see proxy/README.md.
 */
import { type Env, handle } from "./handler.js";
import { upstashLimiter } from "./limits.js";

declare const process: { env: Record<string, string | undefined> };

export default async function classify(request: Request): Promise<Response> {
  const env = process.env;
  // The Vercel Marketplace Upstash integration sets KV_REST_API_*; a direct Upstash database sets UPSTASH_REDIS_REST_*.
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
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
