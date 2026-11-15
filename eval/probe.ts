/**
 * npm run probe   (key from TYPESAFE_API_KEY or the gitignored .env)
 *
 * A small, capped check against the live API before any larger run: does it accept the
 * exact request the extension sends, does the response parse, what does it cost, and do
 * the answers look sensible on representative, hard and "fits nothing" tabs?
 *
 * Data sent: hostname + title of the PUBLIC demo pages below (no personal data), plus the
 * default group descriptions. At most MAX_ATTEMPTS HTTP requests. Every payload and raw
 * response is saved to eval/out/probe-<time>.json (gitignored) so any case can be rerun.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { API_BASE, MODEL_ID, PRICE_USD_PER_INPUT_TOKEN, REQUEST_TIMEOUT_MS } from "../src/core/config.js";
import { decide } from "../src/core/decide.js";
import { toModelGroups } from "../src/core/groups.js";
import type { Order } from "../src/core/types.js";
import { buildRequest } from "../src/providers/request.js";
import { parseResponse } from "../src/providers/typesafe.js";
import { DEFAULT_GROUPS } from "../src/settings.js";
import { typesafeKey } from "../scripts/env.js";

const MAX_ATTEMPTS = 15;

// expect: the group a person would pick, or "none". kind: why the case is here.
const CASES: Array<{ site: string; title: string; expect: string; kind: string; orders: Order[] }> = [
  { site: "en.wikipedia.org", title: "Calibration (statistics) - Wikipedia", expect: "research", kind: "representative", orders: ["fwd"] },
  { site: "github.com", title: "GitHub - microsoft/playwright: Playwright is a framework for Web Testing and Automation.", expect: "code", kind: "representative", orders: ["fwd"] },
  { site: "www.kingarthurbaking.com", title: "Classic Chocolate Chip Cookies Recipe | King Arthur Baking", expect: "cooking", kind: "representative", orders: ["fwd"] },
  { site: "www.sciencenews.org", title: "Science News | The latest news from all areas of science", expect: "news", kind: "representative", orders: ["fwd"] },
  { site: "www.ikea.com", title: "KALLAX Shelf unit, white, 30 3/8x30 3/8 \" - IKEA", expect: "shopping", kind: "representative", orders: ["fwd"] },
  { site: "pypi.org", title: "requests · PyPI", expect: "code", kind: "representative", orders: ["fwd"] },
  { site: "en.wikipedia.org", title: "Maillard reaction - Wikipedia", expect: "research", kind: "hard: research or cooking", orders: ["fwd", "rev"] },
  { site: "news.ycombinator.com", title: "Hacker News", expect: "news", kind: "hard: news or code", orders: ["fwd", "rev"] },
  { site: "www.nytimes.com", title: "The 3 Best Electric Kettles of 2026 | Reviews by Wirecutter", expect: "shopping", kind: "hard: shopping or news", orders: ["fwd"] },
  { site: "www.timeanddate.com", title: "World Clock — current local time around the world", expect: "none", kind: "fits nothing", orders: ["fwd"] },
  { site: "www.weather.gov", title: "National Weather Service", expect: "none", kind: "fits nothing", orders: ["fwd"] },
];

const key = typesafeKey();
if (!key) {
  console.error("No key: set TYPESAFE_API_KEY, or put it in a gitignored .env (it is never printed or saved).");
  process.exit(1);
}
const planned = CASES.reduce((n, c) => n + c.orders.length, 0);
if (planned > MAX_ATTEMPTS) throw new Error(`planned ${planned} > cap ${MAX_ATTEMPTS}`);

const groups = toModelGroups(DEFAULT_GROUPS);
const keyToId = new Map(groups.map((g) => [g.key, g.groupId]));
const records: unknown[] = [];
let attempts = 0;
let tokens = 0;
console.log(`Probing ${MODEL_ID}: ${planned} requests (cap ${MAX_ATTEMPTS}), public demo pages only.\n`);

for (const c of CASES) {
  const answers: Record<string, ReturnType<typeof parseResponse>> = {};
  for (const order of c.orders) {
    if (++attempts > MAX_ATTEMPTS) throw new Error("attempt cap reached");
    const payload = buildRequest(MODEL_ID, { site: c.site, title: c.title }, groups, order);
    const t0 = Date.now();
    let status = 0;
    let raw: unknown = null;
    let error: string | null = null;
    try {
      const res = await fetch(`${API_BASE}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
      });
      status = res.status;
      const text = await res.text();
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text.slice(0, 2000);
      }
      if (res.ok) {
        answers[order] = parseResponse(raw, groups);
        tokens += answers[order]!.inputTokens;
      } else error = `HTTP ${status}`;
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    records.push({ case: c, order, payload, status, ms: Date.now() - t0, raw, error });
    if (error) {
      console.log(`✗ ${c.site} [${order}] ${error}  ${typeof raw === "string" ? raw.slice(0, 300) : JSON.stringify(raw)?.slice(0, 300)}`);
      // A rejected request is a setup problem: stop rather than spend the rest of the budget.
      if (status >= 400 && status < 500 && status !== 429) {
        save();
        process.exit(1);
      }
    }
  }
  const f = answers.fwd;
  if (!f) continue;
  const top = Object.entries(f.probabilities).sort((a, b) => b[1] - a[1]);
  const d = decide(f, answers.rev, groups, 0.8);
  const got = d.groupId ?? "—";
  const ok = (d.groupId ?? "none") === c.expect ? "✓" : "·";
  console.log(
    `${ok} ${c.site.padEnd(24)} expect ${c.expect.padEnd(8)} → ${String(got).padEnd(8)} (${d.reason})  top ${top
      .slice(0, 2)
      .map(([k, p]) => `${keyToId.get(k) ?? k} ${p.toFixed(2)}`)
      .join(", ")} · fits ${f.noul.toFixed(2)}` + (answers.rev ? ` · reversed top ${Object.entries(answers.rev.probabilities).sort((a, b) => b[1] - a[1])[0]![0]}` : ""),
  );
}

function save() {
  mkdirSync("eval/out", { recursive: true });
  const path = `eval/out/probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(path, JSON.stringify({ model: MODEL_ID, attempts, inputTokens: tokens, records }, null, 1));
  console.log(`\n${attempts} requests · ${tokens} input tokens · est. $${(tokens * PRICE_USD_PER_INPUT_TOKEN).toFixed(6)} · saved ${path}`);
}
save();
