import type { TabResult } from "../core/pipeline.js";
import type { SortReport } from "../core/sort.js";
import type { DecisionReason, GroupDef } from "../core/types.js";
import type { Request, Response } from "../messages.js";
import { chromeKV, loadSettings } from "../settings.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sortBtn = $<HTMLButtonElement>("sort");
const undoBtn = $<HTMLButtonElement>("undo");
const slider = $<HTMLInputElement>("threshold");
const tval = $<HTMLOutputElement>("tval");
const msg = $("message");
const list = $("results");
const footer = $("footer");

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

function render(report: SortReport | null) {
  list.replaceChildren();
  footer.replaceChildren();
  if (!report) return;
  const decided = report.results.filter((r) => r.decision);
  const grouped = decided.filter((r) => r.decision!.groupId);
  const loose = decided.filter((r) => !r.decision!.groupId);
  if (grouped.length) list.append(el("h3", undefined, `Grouped (${grouped.length})`), ...grouped.map(row));
  if (loose.length) list.append(el("h3", undefined, `Left alone (${loose.length})`), ...loose.map(row));

  const m = report.metrics;
  const cost = m.estCostUsd === 0 ? "$0" : m.estCostUsd < 0.0001 ? `$${m.estCostUsd.toExponential(1)}` : `$${m.estCostUsd.toFixed(4)}`;
  const parts = [
    `${(m.latencyMs / 1000).toFixed(2)} s`,
    `est. ${cost} (${m.inputTokens} input tokens)`,
    `${pct(m.sortedPct)} sorted`,
    `${m.apiCalls} calls, ${m.cacheHits} cached`,
  ];
  footer.append(document.createTextNode(parts.join(" · ")));
  footer.append(el("br"));
  if (report.mock) footer.append(el("span", "mock-tag", "MOCK classifier (keyword rehearsal, not a model)"));
  else footer.append(document.createTextNode(`Classifier: ${report.classifierId}`));
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
  sortBtn.disabled = !!res.running;
  if (!res.ok) showMessage(res.error, "err");
  else if (res.report?.message) showMessage(res.report.message, res.report.ok ? "warn" : "err");
  else showMessage(null);
}

async function init() {
  const param = Number(new URLSearchParams(location.search).get("window"));
  windowId = Number.isSafeInteger(param) && param > 0 ? param : ((await chrome.windows.getCurrent()).id ?? -1);

  const settings = await loadSettings(chromeKV(chrome.storage.local));
  groups = settings.groups;
  slider.value = String(settings.threshold);
  tval.value = settings.threshold.toFixed(2);
  if (!settings.consentAt) {
    $("consent").classList.remove("hidden");
    sortBtn.disabled = true;
  }

  apply(await send({ type: "status", windowId }));
  if (!settings.consentAt) sortBtn.disabled = true;
}

slider.addEventListener("input", () => (tval.value = Number(slider.value).toFixed(2)));
sortBtn.addEventListener("click", async () => {
  sortBtn.disabled = true;
  undoBtn.disabled = true;
  sortBtn.textContent = "Sorting…";
  showMessage(null);
  const res = await send({ type: "sort", windowId, threshold: Number(slider.value) });
  sortBtn.textContent = "Sort tabs";
  apply(res);
  sortBtn.disabled = false;
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

void init();
