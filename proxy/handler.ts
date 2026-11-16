/**
 * POST /api/classify: classifies one tab ({site, title, groups, order}) with the
 * server's TypeSafe key. It builds the questions itself, so callers can't send
 * arbitrary TypeSafe requests; what limits abuse is the rate limits and spending
 * caps below. Setup: proxy/README.md.
 */
import { MODEL_ID, PRICE_USD_PER_INPUT_TOKEN } from "../src/core/config.js";
import { ClassifierError } from "../src/providers/classifier.js";
import { TypeSafeClassifier } from "../src/providers/typesafe.js";
import { ERROR_HEADER, type HostedAnswer, INSTALL_HEADER, INSTALL_RE, parseHostedRequest } from "../src/providers/wire.js";
import type { Keys, Limiter } from "./limits.js";

export interface Env {
  TYPESAFE_API_KEY?: string;
  /** Comma-separated, e.g. "chrome-extension://abcdef…". Unset: any chrome-extension:// origin, or none. */
  ALLOWED_ORIGINS?: string;
  /** Daily cap in US dollars of TypeSafe input tokens, for everyone together (default 5). */
  DAILY_BUDGET_USD?: string;
  /** Daily cap per IP address (or IPv6 /64), in US dollars (default 2% of the daily cap). */
  PER_IP_DAILY_USD?: string;
  PER_INSTALL_PER_MIN?: string;
  PER_IP_PER_MIN?: string;
  /** Salt for hashing rate-limit keys. Defaults to one derived from the API key (never public). */
  RATE_LIMIT_SALT?: string;
}

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  limiter: Limiter | null;
  log: (event: Record<string, unknown>) => void;
  /** The underlying message of the last failed upstream fetch (logged only, for diagnosing "network"). */
  lastFetchError?: () => string | null;
  /** Run work after the response is sent (Vercel's waitUntil). */
  waitUntil?: (p: Promise<unknown>) => void;
}

const MAX_BODY_BYTES = 32 * 1024;
/** Under the extension's 5 s timeout, so the client doesn't give up and retry a call we still finish and pay for. */
const UPSTREAM_TIMEOUT_MS = 3_500;

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

/** The client's IP, with IPv6 reduced to its /64 (one household or server gets many /128s). */
export function ipBucket(request: Request): string {
  const ip = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!ip.includes(":")) return ip;
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1); // IPv4-mapped, e.g. ::ffff:203.0.113.7
  const [h = "", t] = ip.split("::");
  const head = h ? h.split(":") : [];
  const tail = t ? t.split(":") : [];
  const groups = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  return groups.slice(0, 4).map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const t0 = deps.now();
  const done = (res: Response, outcome: string, extra: Record<string, unknown> = {}) => {
    deps.log({ outcome, status: res.status, ms: deps.now() - t0, ...extra });
    return res;
  };

  // Health check: configuration only. It never touches Redis, so it can't be used to drain it.
  if (request.method === "GET")
    return done(json(200, { ok: true, configured: !!env.TYPESAFE_API_KEY?.trim(), limits: !!deps.limiter, model: MODEL_ID }), "health");
  if (request.method !== "POST") return done(json(405, { error: "method" }, { allow: "GET, POST" }), "method");
  if (!originAllowed(request.headers.get("origin"), env)) return done(json(403, { error: "origin" }), "origin");
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) return done(json(503, { error: "not configured" }, { [ERROR_HEADER]: "not_configured" }), "not_configured");

  const installId = request.headers.get(INSTALL_HEADER) ?? "";
  if (!INSTALL_RE.test(installId)) return done(json(400, { error: "install id" }), "bad_install");

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return done(json(413, { error: "too large" }), "too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) return done(json(413, { error: "too large" }), "too_large");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return done(json(400, { error: "json" }), "bad_json");
  }
  const parsed = parseHostedRequest(body);
  if (!parsed.ok) return done(json(400, { error: parsed.reason }), "bad_request");

  // --- Rate limits and spending caps: one Redis round trip that also reserves tokens. ---
  const now = deps.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const minute = Math.floor(now / 60_000);
  const retryAfter = String(60 - Math.floor((now / 1000) % 60));
  const dayBudget = num(env.DAILY_BUDGET_USD, 5) / PRICE_USD_PER_INPUT_TOKEN;
  const ipDayBudget = num(env.PER_IP_DAILY_USD, num(env.DAILY_BUDGET_USD, 5) * 0.02) / PRICE_USD_PER_INPUT_TOKEN;
  // Rough upper estimate: the descriptions are sent twice (Choice + Noul), ~4 bytes per token.
  const reserve = Math.max(400, Math.ceil(bytes.length / 2));
  let keys: Keys | null = null;
  if (deps.limiter) {
    const salt = env.RATE_LIMIT_SALT ?? `tab-triage:${await hash(`salt:${key}`)}`;
    const [i, ip] = [await hash(salt + installId), await hash(salt + ipBucket(request))];
    keys = { install: `tt:i:${i}:${minute}`, ip: `tt:ip:${ip}:${minute}`, day: `tt:tokens:${day}`, ipDay: `tt:ipd:${ip}:${day}` };
    let a;
    try {
      a = await deps.limiter.admit(keys, reserve);
    } catch (e) {
      // Fail closed: without working counters there is no spending cap.
      return done(json(503, { error: "unavailable" }, { [ERROR_HEADER]: "unavailable", "retry-after": "60" }), "limiter_error", {
        error: e instanceof Error ? e.message : "unknown",
      });
    }
    const release = () => deps.limiter!.settle(keys!, -reserve).catch(() => undefined);
    if (a.installCount > num(env.PER_INSTALL_PER_MIN, 240)) return (await release(), done(json(429, { error: "rate limit" }, { "retry-after": retryAfter }), "limit_install"));
    if (a.ipCount > num(env.PER_IP_PER_MIN, 300)) return (await release(), done(json(429, { error: "rate limit" }, { "retry-after": retryAfter }), "limit_ip"));
    if (a.dayTokens > dayBudget) return (await release(), done(json(503, { error: "daily budget reached" }, { [ERROR_HEADER]: "budget" }), "budget"));
    if (a.ipDayTokens > ipDayBudget) return (await release(), done(json(503, { error: "daily limit reached" }, { [ERROR_HEADER]: "budget" }), "ip_budget"));
  }

  // --- One upstream call. The extension retries; retrying here too would multiply load. ---
  const classifier = new TypeSafeClassifier({ apiKey: key, fetch: deps.fetch, timeoutMs: UPSTREAM_TIMEOUT_MS, retries: 0 });
  let answer: HostedAnswer;
  try {
    answer = await classifier.classify({ site: parsed.req.site, title: parsed.req.title }, parsed.req.groups, parsed.req.order);
  } catch (e) {
    // The reservation stays counted: a failed call may still have been billed.
    const kind = e instanceof ClassifierError ? e.kind : "server";
    const upstream = e instanceof ClassifierError ? e.status : undefined;
    const detail = kind === "network" || kind === "timeout" ? (deps.lastFetchError?.() ?? null) : null;
    const extra = { kind, upstream, detail };
    if (kind === "rate_limit") return done(json(429, { error: "busy" }, { "retry-after": "2" }), "upstream_error", extra);
    if (kind === "overloaded") return done(json(503, { error: "busy" }, { "retry-after": "2" }), "upstream_error", extra);
    if (kind === "bad_request" || kind === "bad_response") return done(json(422, { error: "upstream rejected this tab" }), "upstream_error", extra);
    if (kind === "timeout") return done(json(504, { error: "upstream timeout" }), "upstream_error", extra);
    // auth (key wrong or revoked), network, server: details go to the log, not to callers.
    return done(json(502, { error: "upstream error" }), "upstream_error", extra);
  }

  // Replace the reservation with the real count, after responding when the platform allows it.
  if (deps.limiter && keys) {
    const p = deps.limiter.settle(keys, answer.inputTokens - reserve).catch(() => undefined);
    if (deps.waitUntil) deps.waitUntil(p);
    else await p;
  }
  return done(json(200, { ...answer, model: answer.model || MODEL_ID }), "ok");
}
