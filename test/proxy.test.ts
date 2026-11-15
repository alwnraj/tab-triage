import { describe, expect, it, vi } from "vitest";
import { type Env, handle } from "../proxy/handler.js";
import { memoryLimiter } from "../proxy/limits.js";
import { toModelGroups } from "../src/core/groups.js";
import { HostedClassifier } from "../src/providers/hosted.js";
import { ClassifierError } from "../src/providers/classifier.js";
import { ERROR_HEADER, INSTALL_HEADER, parseHostedRequest } from "../src/providers/wire.js";

const KEY = "ts_live_SERVER_KEY_DO_NOT_LEAK";
const INSTALL = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const MG = toModelGroups([
  { id: "a", name: "Research", color: "blue", description: "Academic papers and references", domains: [] },
  { id: "b", name: "Cooking", color: "orange", description: "Recipes and food", domains: [] },
]);
const BODY = { v: 1, site: "arxiv.org", title: "Attention Is All You Need", groups: MG.map(({ key, description }) => ({ key, description })), order: "fwd" };
const upstreamOk = () =>
  new Response(
    JSON.stringify({
      model: "jev-1.14.0",
      answers: { group: { type: "choice", choice: "research", confidence: 0.9, probabilities: { research: 0.93, cooking: 0.07 } }, fits: { type: "noul", noul: 0.96 } },
      usage: { input_tokens: 600, output_tokens: 70 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function setup(upstream: Array<Response | Error> = [upstreamOk()], env: Env = { TYPESAFE_API_KEY: KEY }, limiter = memoryLimiter()) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logs: string[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const r = upstream.shift() ?? upstreamOk();
    if (r instanceof Error) throw r;
    return r;
  });
  const call = (body: unknown = BODY, headers: Record<string, string> = {}, method = "POST") =>
    handle(
      new Request("https://tab-triage.vercel.app/api/classify", {
        method,
        headers: { "content-type": "application/json", origin: EXT, [INSTALL_HEADER]: INSTALL, "x-real-ip": "203.0.113.7", ...headers },
        body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      }),
      env,
      { fetch: f as unknown as typeof fetch, now: () => Date.UTC(2026, 10, 15, 12, 0, 30), limiter, log: (e) => logs.push(JSON.stringify(e)) },
    );
  return { call, calls, logs, limiter };
}

describe("hosted service (proxy/handler.ts)", () => {
  it("classifies one tab with the server key and returns only the answer", async () => {
    const { call, calls, limiter } = setup();
    const r = await call();
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ choice: "research", noul: 0.96, inputTokens: 600, probabilities: { research: 0.93, cooking: 0.07 } });
    expect(text).not.toContain(KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    // The service builds the questions itself: the upstream body is the extension's usual request.
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.state).toEqual({ site: "arxiv.org", title: "Attention Is All You Need" });
    expect(Object.keys(sent.questions)).toEqual(["group", "fits"]);
    expect(limiter.counts.get("tokens:2026-11-15")).toBe(600);
  });

  it("never logs the hostname, title or key", async () => {
    const { call, logs } = setup([new Response("{}", { status: 401 })]);
    await call();
    await setup().call();
    for (const l of logs) for (const secret of ["arxiv.org", "Attention", KEY]) expect(l).not.toContain(secret);
  });

  it("refuses other methods, web-page origins and origins off the allow-list", async () => {
    expect((await setup().call(BODY, {}, "GET")).status).toBe(405);
    expect((await setup().call(BODY, { origin: "https://evil.example" })).status).toBe(403);
    const listed = setup(undefined, { TYPESAFE_API_KEY: KEY, ALLOWED_ORIGINS: "chrome-extension://onlythisone" });
    expect((await listed.call()).status).toBe(403);
    expect((await listed.call(BODY, { origin: "chrome-extension://onlythisone" })).status).toBe(200);
  });

  it("says it's not configured (without retry bait) when the key is missing", async () => {
    const r = await setup(undefined, {}).call();
    expect(r.status).toBe(503);
    expect(r.headers.get(ERROR_HEADER)).toBe("not_configured");
  });

  it("accepts only the tab-triage request shape", async () => {
    const { call, calls } = setup();
    const bad = [
      { ...BODY, v: 2 },
      { ...BODY, site: "arxiv.org/abs/123" },
      { ...BODY, site: "https://arxiv.org" },
      { ...BODY, title: "x".repeat(2000) },
      { ...BODY, order: "sideways" },
      { ...BODY, groups: [] },
      { ...BODY, groups: Array.from({ length: 13 }, (_, i) => ({ key: `g${i}`, description: "d" })) },
      { ...BODY, groups: [{ key: "Has Spaces", description: "d" }] },
      { ...BODY, groups: [{ key: "a", description: "x".repeat(501) }] },
      { ...BODY, groups: [{ key: "a", description: "d" }, { key: "a", description: "e" }] },
      // A general-purpose TypeSafe request is not accepted.
      { model: "jev-1.14.0", state: { anything: "x" }, questions: { q: { type: "noul", instructions: "?" } } },
    ];
    for (const b of bad) expect((await call(b)).status, JSON.stringify(b).slice(0, 60)).toBe(400);
    expect((await call("{not json")).status).toBe(400);
    expect((await call(BODY, { [INSTALL_HEADER]: "not-a-uuid" })).status).toBe(400);
    expect((await call(JSON.stringify({ ...BODY, pad: "x".repeat(20_000) }))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("truncates titles to 120 characters before they go upstream", () => {
    const p = parseHostedRequest({ ...BODY, title: "t".repeat(300) });
    expect(p.ok && p.req.title.length).toBe(120);
  });

  it("rate-limits per install and per IP", async () => {
    // The install check runs first, so the third call never reaches the IP counter (which ends at 2).
    const env = { TYPESAFE_API_KEY: KEY, PER_INSTALL_PER_MIN: "2", PER_IP_PER_MIN: "2" };
    const { call } = setup(undefined, env);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // A second install on the same IP hits the per-IP limit.
    const other = await call(BODY, { [INSTALL_HEADER]: "11111111-2222-4333-8444-555555555555" });
    expect(other.status).toBe(429);
  });

  it("stops for the day at the spending cap", async () => {
    const limiter = memoryLimiter();
    // $0.00002 is under one request's worth of tokens (600 × $0.042/M ≈ $0.000025).
    const { call } = setup(undefined, { TYPESAFE_API_KEY: KEY, DAILY_BUDGET_USD: "0.00002" }, limiter);
    expect((await call()).status).toBe(200);
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.headers.get(ERROR_HEADER)).toBe("budget");
  });

  it("makes exactly one upstream call and maps upstream errors", async () => {
    const cases: Array<[Response | Error, number]> = [
      [new Response("{}", { status: 429 }), 429],
      [new Response("{}", { status: 529 }), 503],
      [new Response("{}", { status: 401 }), 502],
      [new Response("{}", { status: 400 }), 422],
      [new Response("{}", { status: 500 }), 502],
      [new TypeError("fetch failed"), 502],
    ];
    for (const [up, want] of cases) {
      const { call, calls } = setup([up]);
      expect((await call()).status).toBe(want);
      expect(calls).toHaveLength(1);
    }
  });

  it("fails open if the limiter is down, and says so in the log", async () => {
    const broken = { over: async () => Promise.reject(new Error("redis down")), tokensToday: async () => 0, addTokens: async () => undefined };
    const { call, logs } = setup(undefined, { TYPESAFE_API_KEY: KEY }, broken as never);
    expect((await call()).status).toBe(200);
    expect(logs.some((l) => l.includes("limiter_error"))).toBe(true);
  });
});

describe("HostedClassifier (extension side)", () => {
  function client(responses: Response[]) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return responses.shift()!;
    });
    const c = new HostedClassifier({ installId: INSTALL, serviceUrl: "https://svc.example/", fetch: f as unknown as typeof fetch, sleep: async () => {}, random: () => 0 });
    return { c, calls };
  }
  const ok = () => new Response(JSON.stringify({ choice: "research", probabilities: { research: 0.9, cooking: 0.1 }, noul: 0.95, inputTokens: 600, model: "jev-1.14.0" }), { status: 200 });

  it("sends only hostname, title, group keys and descriptions, and the install id", async () => {
    const { c, calls } = client([ok()]);
    const a = await c.classify({ site: "arxiv.org", title: "Attention" }, MG, "rev");
    expect(a).toMatchObject({ choice: "research", noul: 0.95, inputTokens: 600 });
    expect(calls[0]!.url).toBe("https://svc.example/api/classify");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      v: 1,
      site: "arxiv.org",
      title: "Attention",
      groups: MG.map(({ key, description }) => ({ key, description })),
      order: "rev",
    });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h[INSTALL_HEADER]).toBe(INSTALL);
    expect(Object.keys(h).some((k) => k.toLowerCase() === "authorization")).toBe(false);
    expect(c.id).toBe("hosted:jev-1.14.0");
  });

  it("treats 'paused for today' as final and doesn't retry it", async () => {
    const { c, calls } = client([new Response("{}", { status: 503, headers: { [ERROR_HEADER]: "budget" } })]);
    const e = await c.classify({ site: "a.com", title: "t" }, MG, "fwd").catch((x) => x);
    expect(e).toBeInstanceOf(ClassifierError);
    expect((e as ClassifierError).kind).toBe("unavailable");
    expect((e as ClassifierError).fatal).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("retries a rate limit, then succeeds", async () => {
    const { c, calls } = client([new Response("{}", { status: 429, headers: { "retry-after": "1" } }), ok()]);
    await expect(c.classify({ site: "a.com", title: "t" }, MG, "fwd")).resolves.toMatchObject({ choice: "research" });
    expect(calls).toHaveLength(2);
  });

  it("rejects an answer naming a group we didn't ask about", async () => {
    const bad = new Response(JSON.stringify({ choice: "shopping", probabilities: {}, noul: 0.9, inputTokens: 1 }), { status: 200 });
    const e = await client([bad]).c.classify({ site: "a.com", title: "t" }, MG, "fwd").catch((x) => x);
    expect((e as ClassifierError).kind).toBe("bad_response");
  });
});
