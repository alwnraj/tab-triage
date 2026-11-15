/**
 * POST /api/classify: the hosted tab-triage service.
 *
 * It holds the TypeSafe key so users don't need one, and it only does one thing:
 * classify one tab ({site, title, groups, order}) with the same questions the
 * extension used to send itself. It builds those questions here, so it can't be
 * used as a general-purpose TypeSafe proxy.
 *
 * Abuse limits: request shape and size, optional origin allow-list, per-install and
 * per-IP rate limits, and a daily input-token cap (the last three need Redis; see
 * proxy/README.md). Privacy: titles and hostnames are never logged or stored; rate
 * limit keys are salted hashes that expire within minutes.
 */
import { MODEL_ID, PRICE_USD_PER_INPUT_TOKEN } from "../src/core/config.js";
import { ClassifierError } from "../src/providers/classifier.js";
import { TypeSafeClassifier } from "../src/providers/typesafe.js";
import { ERROR_HEADER, type HostedAnswer, INSTALL_HEADER, INSTALL_RE, parseHostedRequest } from "../src/providers/wire.js";
import type { Limiter } from "./limits.js";

export interface Env {
  TYPESAFE_API_KEY?: string;
  /** Comma-separated, e.g. "chrome-extension://abcdef…". Unset: any chrome-extension:// origin, or none. */
  ALLOWED_ORIGINS?: string;
  /** Daily cap in US dollars of TypeSafe input tokens (default 5). */
  DAILY_BUDGET_USD?: string;
  PER_INSTALL_PER_MIN?: string;
  PER_IP_PER_MIN?: string;
  /** Salt for hashing rate-limit keys. Any random string. */
  RATE_LIMIT_SALT?: string;
}

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  limiter: Limiter | null;
  log: (event: Record<string, unknown>) => void;
  /** The underlying message of the last failed upstream fetch (no request data), for diagnosing "network". */
  lastFetchError?: () => string | null;
}

const MAX_BODY = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 4_500;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

async function hash(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function originAllowed(origin: string | null, env: Env): boolean {
  const list = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length) return origin !== null && list.includes(origin);
  // No allow-list: refuse ordinary web pages (they send an http(s) Origin), allow the extension.
  return origin === null || origin.startsWith("chrome-extension://");
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const t0 = deps.now();
  const done = (res: Response, outcome: string) => {
    deps.log({ outcome, status: res.status, ms: deps.now() - t0 });
    return res;
  };

  // Health check: whether the key and the limits are configured (never their values).
  if (request.method === "GET")
    return done(
      json(200, {
        ok: true,
        configured: !!env.TYPESAFE_API_KEY?.trim(),
        limits: !!deps.limiter,
        model: MODEL_ID,
        // Names only (never values), so a misnamed Redis integration is easy to spot.
        ...(deps.limiter ? {} : { redisVariables: Object.keys(env).filter((k) => /REDIS|^KV_|UPSTASH|_REST(_API)?_(URL|TOKEN)$/.test(k)).sort() }),
      }),
      "health",
    );
  if (request.method !== "POST") return done(json(405, { error: "method" }, { allow: "GET, POST" }), "method");
  if (!originAllowed(request.headers.get("origin"), env)) return done(json(403, { error: "origin" }), "origin");
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) return done(json(503, { error: "not configured" }, { [ERROR_HEADER]: "not_configured" }), "not_configured");

  const installId = request.headers.get(INSTALL_HEADER) ?? "";
  if (!INSTALL_RE.test(installId)) return done(json(400, { error: "install id" }), "bad_install");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return done(json(413, { error: "too large" }), "too_large");
  const text = await request.text();
  if (text.length > MAX_BODY) return done(json(413, { error: "too large" }), "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return done(json(400, { error: "json" }), "bad_json");
  }
  const parsed = parseHostedRequest(body);
  if (!parsed.ok) return done(json(400, { error: parsed.reason }), "bad_request");

  // --- Rate limits and the daily cap (only when a limiter is configured). ---
  const now = deps.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const minute = Math.floor(now / 60_000);
  const retryAfter = String(60 - Math.floor((now / 1000) % 60));
  const budgetTokens = num(env.DAILY_BUDGET_USD, 5) / PRICE_USD_PER_INPUT_TOKEN;
  if (deps.limiter) {
    try {
      const salt = env.RATE_LIMIT_SALT ?? "tab-triage";
      const ip = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      if (await deps.limiter.over(`tt:i:${await hash(salt + installId)}:${minute}`, num(env.PER_INSTALL_PER_MIN, 120), 60))
        return done(json(429, { error: "rate limit" }, { "retry-after": retryAfter }), "limit_install");
      if (await deps.limiter.over(`tt:ip:${await hash(salt + ip)}:${minute}`, num(env.PER_IP_PER_MIN, 300), 60))
        return done(json(429, { error: "rate limit" }, { "retry-after": retryAfter }), "limit_ip");
      if ((await deps.limiter.tokensToday(day)) >= budgetTokens)
        return done(json(503, { error: "daily budget reached" }, { [ERROR_HEADER]: "budget" }), "budget");
    } catch (e) {
      // Fail open on a limiter outage rather than take the whole service down; it's logged.
      deps.log({ outcome: "limiter_error", error: e instanceof Error ? e.message : "unknown" });
    }
  }

  // --- One upstream call. The extension retries; retrying here too would multiply load. ---
  const classifier = new TypeSafeClassifier({ apiKey: key, fetch: deps.fetch, timeoutMs: UPSTREAM_TIMEOUT_MS, retries: 0 });
  let answer: HostedAnswer;
  try {
    answer = await classifier.classify({ site: parsed.req.site, title: parsed.req.title }, parsed.req.groups, parsed.req.order);
  } catch (e) {
    const kind = e instanceof ClassifierError ? e.kind : "server";
    const upstream = e instanceof ClassifierError ? e.status : undefined;
    const detail = kind === "network" || kind === "timeout" ? (deps.lastFetchError?.() ?? null) : null;
    deps.log({ outcome: "upstream_error", kind, upstream, detail });
    if (kind === "rate_limit") return json(429, { error: "busy" }, { "retry-after": "2" });
    if (kind === "overloaded") return json(503, { error: "busy" }, { "retry-after": "2" });
    if (kind === "bad_request" || kind === "bad_response") return json(422, { error: "upstream rejected this tab" });
    if (kind === "timeout") return json(504, { error: "upstream timeout" });
    // auth (our key is wrong or revoked), network, server: a service problem, not the user's.
    // The kind and upstream status are safe to return and make a misconfiguration diagnosable.
    return json(502, { error: "upstream error", kind, upstream: upstream ?? null, ...(detail ? { detail } : {}) });
  }

  if (deps.limiter) {
    try {
      await deps.limiter.addTokens(day, answer.inputTokens);
    } catch {
      /* counted best-effort */
    }
  }
  return done(json(200, { ...answer, model: answer.model || MODEL_ID }), "ok");
}
