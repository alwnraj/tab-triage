import { describe, expect, it, vi } from "vitest";
import { toModelGroups } from "../src/core/groups.js";
import { ClassifierError } from "../src/providers/classifier.js";
import { MockClassifier } from "../src/providers/mock.js";
import { buildRequest } from "../src/providers/request.js";
import { parseResponse, parseRetryAfter, TypeSafeClassifier } from "../src/providers/typesafe.js";

const MG = toModelGroups([
  { id: "a", name: "Research", color: "blue", description: "Academic papers, documentation, references", domains: [] },
  { id: "b", name: "Cooking", color: "orange", description: "Recipes and food", domains: [] },
]);
const INPUT = { site: "arxiv.org", title: "Attention Is All You Need" };
const KEY = "ts_test_DO_NOT_LEAK_123";

/** Shaped exactly like the OpenAPI "choice" + "noul" response examples. */
const okBody = (probs = { g_research: 0.93, g_cooking: 0.07 }, noul = 0.97) => ({
  model: "jev-1.14.0",
  answers: {
    group: { type: "choice", choice: "g_research", confidence: 0.9, probabilities: probs },
    fits: { type: "noul", noul },
  },
  usage: { input_tokens: 180, output_tokens: 20 },
});
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(responses: Array<Response | Error | "hang">, extra: Partial<ConstructorParameters<typeof TypeSafeClassifier>[0]> = {}) {
  const calls: RequestInit[] = [];
  const sleeps: number[] = [];
  const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init!);
    const r = responses.shift();
    if (r === "hang")
      return new Promise<Response>((_, rej) => init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    if (r instanceof Error) throw r;
    return r!;
  });
  const c = new TypeSafeClassifier({
    apiKey: KEY,
    fetch: f as unknown as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    timeoutMs: 20,
    ...extra,
  });
  return { c, f, calls, sleeps };
}

describe("buildRequest", () => {
  it("sends only hostname and title, plus the groups, in the documented shape", () => {
    const body = buildRequest("jev-1.14.0", INPUT, MG, "fwd");
    expect(body.state).toEqual(INPUT);
    expect(body.questions.group.type).toBe("choice");
    expect(Object.keys(body.questions.group.criteria)).toEqual(["g_research", "g_cooking"]);
    expect(body.questions.fits.type).toBe("noul");
    expect(body.questions.fits.criteria).toHaveProperty("true");
    expect(body.questions.fits.criteria).toHaveProperty("false");
  });
  it("reverses both the Choice options and the Noul's group list", () => {
    const body = JSON.parse(JSON.stringify(buildRequest("m", INPUT, MG, "rev")));
    expect(Object.keys(body.questions.group.criteria)).toEqual(["g_cooking", "g_research"]);
    expect(Object.keys(body.questions.fits.instructions.groups)).toEqual(["g_cooking", "g_research"]);
  });
});

describe("parseResponse", () => {
  it("parses the documented response", () => {
    expect(parseResponse(okBody(), MG)).toEqual({
      choice: "g_research",
      probabilities: { g_research: 0.93, g_cooking: 0.07 },
      noul: 0.97,
      inputTokens: 180,
      model: "jev-1.14.0",
    });
  });
  it("rejects malformed answers and unknown choices", () => {
    expect(() => parseResponse({}, MG)).toThrow(ClassifierError);
    const bad = okBody();
    (bad.answers.group as { choice: string }).choice = "g_other";
    expect(() => parseResponse(bad, MG)).toThrow(/unexpected/);
    const bad2 = okBody();
    (bad2.answers.fits as { noul: unknown }).noul = "high";
    expect(() => parseResponse(bad2, MG)).toThrow(ClassifierError);
  });
});

describe("TypeSafeClassifier", () => {
  it("posts to /v1/systemone with a bearer key", async () => {
    const { c, f, calls } = client([res(200, okBody())]);
    const a = await c.classify(INPUT, MG, "fwd");
    expect(a.noul).toBe(0.97);
    expect(f.mock.calls[0]![0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect((calls[0]!.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]!.body as string).model).toBe("jev-1.14.0");
  });
  it("retries 429 honouring retry-after, then succeeds", async () => {
    const { c, f, sleeps } = client([res(429, {}, { "retry-after": "2" }), res(200, okBody())]);
    await c.classify(INPUT, MG, "fwd");
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });
  it("retries 529 and 5xx with backoff, at most 2 retries", async () => {
    const { c, f, sleeps } = client([res(529), res(503), res(500)]);
    await expect(c.classify(INPUT, MG, "fwd")).rejects.toMatchObject({ kind: "server", attempts: 3 });
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1500]);
  });
  it("times out each attempt and reports a timeout", async () => {
    const { c, f } = client(["hang", "hang", "hang"]);
    await expect(c.classify(INPUT, MG, "fwd")).rejects.toMatchObject({ kind: "timeout" });
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("retries network errors", async () => {
    const { c } = client([new TypeError("fetch failed"), res(200, okBody())]);
    await expect(c.classify(INPUT, MG, "fwd")).resolves.toMatchObject({ choice: "g_research" });
  });
  it.each([400, 401, 403, 422])("does not retry %i", async (status) => {
    const { c, f } = client([res(status, { detail: "x" }), res(200, okBody())]);
    const err = await c.classify(INPUT, MG, "fwd").catch((e) => e);
    expect(err).toBeInstanceOf(ClassifierError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("never puts the key in error messages", async () => {
    const { c } = client([res(401)]);
    const err = (await c.classify(INPUT, MG, "fwd").catch((e) => e)) as ClassifierError;
    expect(err.kind).toBe("auth");
    expect(err.message + String(err.stack)).not.toContain(KEY);
  });
  it("refuses to construct without a key", () => {
    expect(() => new TypeSafeClassifier({ apiKey: "" })).toThrow(/No API key/);
  });
  it("calls onAttempt once per HTTP attempt", async () => {
    let n = 0;
    const { c } = client([res(429), res(200, okBody())], { onAttempt: () => n++ });
    await c.classify(INPUT, MG, "fwd");
    expect(n).toBe(2);
  });
  it("rejects out-of-range probabilities and nouls", () => {
    const bad = okBody({ g_research: 1.7, g_cooking: 0 }, 0.5);
    expect(parseResponse(bad, MG).probabilities.g_research).toBe(0);
    expect(() => parseResponse(okBody(undefined, 1.2), MG)).toThrow(ClassifierError);
  });
  it("does not expose the key when the classifier object is logged or serialised", () => {
    const { c } = client([]);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(Object.values(c).map(String).join(" ")).not.toContain(KEY);
  });
  it("retry-after: 0 still backs off", async () => {
    const { c, sleeps } = client([res(429, {}, { "retry-after": "0" }), res(200, okBody())]);
    await c.classify(INPUT, MG, "fwd");
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
  });
  it("parses retry-after", () => {
    expect(parseRetryAfter("1")).toBe(1000);
    expect(parseRetryAfter("100")).toBe(5000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("garbage")).toBeNull();
  });
});

describe("MockClassifier", () => {
  it("is labelled as mock and picks by keywords", async () => {
    const m = new MockClassifier();
    expect(m.isMock).toBe(true);
    const a = await m.classify({ site: "example.com", title: "Easy pasta recipes for food lovers" }, MG, "fwd");
    expect(a.choice).toBe("g_cooking");
    expect(a.noul).toBeGreaterThan(0.8);
    const none = await m.classify({ site: "x.com", title: "zzz" }, MG, "fwd");
    expect(none.noul).toBeLessThan(0.5);
    // The first-option lean is in the probabilities, so reversing can flip the top answer.
    const fwd = await m.classify({ site: "x.com", title: "zzz" }, MG, "fwd");
    const rev = await m.classify({ site: "x.com", title: "zzz" }, MG, "rev");
    expect(fwd.choice).toBe("g_research");
    expect(rev.choice).toBe("g_cooking");
  });
});
