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
  return handle(request, env as Env, {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    limiter: url && token ? upstashLimiter(url, token) : null,
    // Status, outcome and timing only: never the request body.
    log: (e) => console.log(JSON.stringify(e)),
  });
}
