import type { TabResult } from "../core/pipeline.js";
import type { SortReport } from "../core/sort.js";
import type { DecisionReason, GroupDef } from "../core/types.js";
import type { Request, Response } from "../messages.js";
import { chromeKV, loadSettings } from "../settings.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sortBtn = $<HTMLButtonElement>("sort");
const undoBtn = $<HTMLButtonElement>("undo");
const tval = $<HTMLOutputElement>("tval");
const tDown = $<HTMLButtonElement>("t-down");
const tUp = $<HTMLButtonElement>("t-up");
const presets = $("presets");
const msg = $("message");
const summary = $("summary");
const list = $("results");
const metrics = $("metrics");

// Same range the settings accept (0.5–0.95), in 0.05 steps.
const T_MIN = 0.5;
const T_MAX = 0.95;
const PRESETS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
let threshold = 0.8;
const presetBtns = PRESETS.map((p) => {
  const b = el("button", "tile", p.toFixed(2).replace(/0$/, ""));
  b.setAttribute("aria-label", `Threshold ${p.toFixed(2)}`);
  b.addEventListener("click", () => setThreshold(p));
  return b;
});
presets.append(...presetBtns);

function setThreshold(t: number) {
  threshold = Math.min(T_MAX, Math.max(T_MIN, Math.round(t * 20) / 20));
  tval.value = threshold.toFixed(2);
  tDown.disabled = threshold <= T_MIN + 1e-9;
  tUp.disabled = threshold >= T_MAX - 1e-9;
  PRESETS.forEach((p, i) => {
    const on = Math.abs(p - threshold) < 1e-9;
    presetBtns[i]!.classList.toggle("on", on);
    presetBtns[i]!.setAttribute("aria-pressed", String(on));
  });
}

const REASON: Record<DecisionReason, string> = {
  domain: "domain rule",
  confident: "confident",
  "order-agree": "near threshold, confirmed with options reversed",
  "no-fit": "no group fits well enough",
  "low-prob": "top group below threshold",
  "order-disagree": "answer changed when options were reversed",
  "needs-reverse": "unresolved",
  error: "API rejected this tab",
};

let windowId = -1;
let consented = false;
let groups: GroupDef[] = [];

/** All untrusted text (tab titles) goes through textContent, never innerHTML. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showMessage(text: string | null, kind: "warn" | "err" = "warn") {
  msg.classList.toggle("hidden", !text);
  msg.classList.remove("warn", "err");
  msg.classList.add(kind);
  msg.textContent = text ?? "";
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

function row(r: TabResult): HTMLLIElement {
  const d = r.decision!;
  const g = groups.find((x) => x.id === (d.groupId ?? d.leaningGroupId));
  const li = el("li", d.groupId ? "grouped" : "ungrouped");
  li.append(el("span", "title", r.title || r.site || "(untitled)"));
  li.append(el("span", "prob", d.reason === "domain" ? "rule" : d.reason === "error" ? "—" : pct(d.probability)));
  const where = el("span", "where");
  if (d.groupId && g) {
    const dot = el("span", `dot c-${g.color}`);
    where.append(dot, document.createTextNode(`${g.name} · ${REASON[d.reason]}`));
  } else {
    const lean = g && d.reason !== "error" ? ` (leaned ${g.name}, fit ${pct(d.noul)})` : "";
    where.textContent = `Left ungrouped: ${REASON[d.reason]}${lean}`;
  }
  li.append(where);
  return li;
}

function chip(n: number, label: string): HTMLElement {
  const c = el("div", "chip");
  c.append(el("b", undefined, String(n)), el("span", undefined, label));
  return c;
}

function render(report: SortReport | null) {
  list.replaceChildren();
  summary.replaceChildren();
  metrics.replaceChildren();
  summary.classList.toggle("hidden", !report);
  if (!report) return;
  const decided = report.results.filter((r) => r.decision);
  const grouped = decided.filter((r) => r.decision!.groupId);
  const loose = decided.filter((r) => !r.decision!.groupId);
  summary.append(chip(grouped.length, "grouped"), chip(loose.length, "left alone"));
  // Tabs left alone come first: they're the ones that may need you. Grouped tabs are visible in the tab strip.
  if (loose.length) list.append(el("h3", undefined, `Left alone (${loose.length})`), ...loose.map(row));
  if (grouped.length) list.append(el("h3", undefined, `Grouped (${grouped.length})`), ...grouped.map(row));

  const m = report.metrics;
  const cost = m.estCostUsd === 0 ? "$0" : m.estCostUsd < 0.0001 ? `$${m.estCostUsd.toExponential(1)}` : `$${m.estCostUsd.toFixed(4)}`;
  metrics.append(
    document.createTextNode(`${(m.latencyMs / 1000).toFixed(2)} s · est. ${cost} · ${pct(m.sortedPct)} sorted`),
    el("br"),
    document.createTextNode(`${m.apiCalls} calls · ${m.cacheHits} cached · `),
    report.mock ? el("span", "mock-tag", "MOCK") : document.createTextNode(report.classifierId.replace("typesafe:", "")),
  );
}

async function send(req: Request): Promise<Response> {
  try {
    return (await chrome.runtime.sendMessage(req)) as Response;
  } catch {
    return { ok: false, error: "The extension's background worker didn't respond. Try again." };
  }
}

function apply(res: Response) {
  if ("report" in res && res.report !== undefined) render(res.report);
  undoBtn.disabled = !res.canUndo;
  sortBtn.disabled = !!res.running || !consented;
  if (!res.ok) showMessage(res.error, "err");
  else if (res.report?.message) showMessage(res.report.message, res.report.ok ? "warn" : "err");
  else showMessage(null);
}

async function init() {
  const param = Number(new URLSearchParams(location.search).get("window"));
  windowId = Number.isSafeInteger(param) && param > 0 ? param : ((await chrome.windows.getCurrent()).id ?? -1);

  const settings = await loadSettings(chromeKV(chrome.storage.local));
  groups = settings.groups;
  setThreshold(settings.threshold);
  consented = !!settings.consentAt;
  $("consent").classList.toggle("hidden", consented);
}

tDown.addEventListener("click", () => setThreshold(threshold - 0.05));
tUp.addEventListener("click", () => setThreshold(threshold + 0.05));
sortBtn.addEventListener("click", async () => {
  sortBtn.disabled = true;
  undoBtn.disabled = true;
  sortBtn.textContent = "Sorting…";
  showMessage(null);
  const res = await send({ type: "sort", windowId, threshold });
  sortBtn.textContent = "Sort tabs";
  apply(res);
});
undoBtn.addEventListener("click", async () => {
  undoBtn.disabled = true;
  apply(await send({ type: "undo", windowId }));
});
for (const id of ["options", "open-consent"])
  $(id).addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  });

// Stay live: a sort or undo started elsewhere (or one still running when the popup opened)
// shows up here as it happens.
async function refresh() {
  const run = (await chrome.storage.session.get(`run:${windowId}`))[`run:${windowId}`];
  const res = await send({ type: "status", windowId });
  apply(res);
  sortBtn.textContent = run === "sort" ? "Sorting…" : "Sort tabs";
  if (run) {
    sortBtn.disabled = true;
    undoBtn.disabled = true;
  }
  if (!consented) sortBtn.disabled = true;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || windowId < 0) return;
  if ([`report:${windowId}`, `undo:${windowId}`, `run:${windowId}`].some((k) => k in changes)) void refresh();
});

void init().then(refresh);
