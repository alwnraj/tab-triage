import type { TabResult } from "../core/pipeline.js";
import type { SortReport } from "../core/sort.js";
import type { DecisionReason, GroupDef } from "../core/types.js";
import type { Request, Response } from "../messages.js";
import { chromeKV, loadSettings } from "../settings.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sortBtn = $<HTMLButtonElement>("sort");
const sortLabel = $("sort-label");
const undoBtn = $<HTMLButtonElement>("undo");
const msg = $("message");
const hint = $("hint");
const summary = $("summary");
const count = $("count");
const mockTag = $("mock");
const modeBtn = $<HTMLButtonElement>("mode");
const results = $("results");
/** An error from this popup's own Sort/Undo click; kept on screen until the next action. */
let clickError: string | null = null;

/** Why a tab went into a group. */
const GROUPED: Partial<Record<DecisionReason, string>> = {
  domain: "your domain rule",
  confident: "confident",
  "best-guess": "best guess",
  "close-call": "close call, checked twice",
  "same-site": "same site",
  "order-agree": "confirmed on a second ask",
};
/** Why a tab was left alone, with and without a group it leaned towards. */
const LEFT_ALONE: Partial<Record<DecisionReason, [withLean: string, without: string]>> = {
  "no-fit": ["doesn't fit well", "No group fits"],
  "low-prob": ["close, not sure", "Not sure which group"],
  "order-disagree": ["changed on a second ask", "Changed on a second ask"],
  "needs-reverse": ["unresolved", "Unresolved"],
  error: ["couldn't classify this tab", "Couldn't classify this tab"],
};

/** Rows shown per section before "+ N more". */
const SHOW = 2;
const expanded = new Set<string>();

let windowId = -1;
let consented = false;
let groups: GroupDef[] = [];
let modeText = "Best guess";
let lastReport: SortReport | null = null;
/** The user's groups plus the same-site groups made for the last sort. */
let shownGroups: GroupDef[] = [];

/** All untrusted text (tab titles, group names) goes through textContent, never innerHTML. */
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
  const g = shownGroups.find((x) => x.id === (d.groupId ?? d.leaningGroupId));
  const li = el("li");
  li.append(el("span", "title", r.title || r.site || "(untitled)"));
  const soft = d.reason === "domain" || d.reason === "same-site";
  li.append(el("span", soft ? "pct soft" : "pct", d.reason === "domain" ? "rule" : d.reason === "same-site" ? "site" : d.reason === "error" ? "—" : pct(d.probability)));

  const meta = el("span", "meta");
  if (d.groupId && g) {
    meta.append(el("span", `chip c-${g.color}`, g.name), el("span", undefined, GROUPED[d.reason] ?? ""));
  } else {
    const [withLean, without] = LEFT_ALONE[d.reason] ?? ["not sure", "Not sure"];
    if (g && d.reason !== "error") meta.append(el("span", `chip lean c-${g.color}`, g.name), el("span", undefined, withLean));
    else meta.append(el("span", undefined, without));
  }
  li.append(meta);
  return li;
}

function section(key: string, title: string, rows: TabResult[]): HTMLElement {
  const sec = el("section");
  sec.append(el("h3", undefined, title));
  const open = expanded.has(key);
  const ol = el("ol");
  ol.append(...(open ? rows : rows.slice(0, SHOW)).map(row));
  sec.append(ol);
  if (rows.length > SHOW) {
    const more = el("button", "more", open ? "Show fewer" : `+ ${rows.length - SHOW} more`);
    more.type = "button";
    more.setAttribute("aria-expanded", String(open));
    more.addEventListener("click", () => {
      if (open) expanded.delete(key);
      else expanded.add(key);
      render(lastReport);
    });
    sec.append(more);
  }
  return sec;
}

function render(report: SortReport | null) {
  lastReport = report;
  results.replaceChildren();
  summary.classList.toggle("hidden", !report);
  hint.classList.toggle("hidden", !!report);
  mockTag.classList.toggle("hidden", !report?.mock);
  if (!report) return;
  shownGroups = [...groups, ...(report.siteGroups ?? [])];
  const decided = report.results.filter((r) => r.decision);
  const grouped = decided.filter((r) => r.decision!.groupId);
  const loose = decided.filter((r) => !r.decision!.groupId);

  count.replaceChildren();
  const strong = el("b", undefined, `${grouped.length} of ${decided.length}`);
  count.append(strong, ` grouped${loose.length ? ` · ${loose.length} left alone` : ""}`);
  modeBtn.textContent = modeText;

  // Tabs left alone come first: they're the ones that may need you. Grouped tabs are visible in the tab strip.
  if (loose.length) results.append(section("loose", "Left alone", loose));
  if (grouped.length) results.append(section("grouped", "Grouped", grouped));
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
  else if (clickError) showMessage(clickError, "err");
  else if (res.report?.message) showMessage(res.report.message, res.report.ok ? "warn" : "err");
  else showMessage(null);
}

async function init() {
  const param = Number(new URLSearchParams(location.search).get("window"));
  windowId = Number.isSafeInteger(param) && param > 0 ? param : ((await chrome.windows.getCurrent()).id ?? -1);

  const settings = await loadSettings(chromeKV(chrome.storage.local));
  groups = settings.groups;
  consented = !!settings.consentAt;
  modeText = settings.strict ? `≥ ${Math.round(settings.threshold * 100)}% sure` : "Best guess";
  modeBtn.setAttribute("aria-label", `${settings.strict ? `Only groups tabs it is at least ${Math.round(settings.threshold * 100)}% sure about` : "Groups each tab with its best-fitting group"}. Open options`);
  $("consent").classList.toggle("hidden", consented);
}

sortBtn.addEventListener("click", async () => {
  sortBtn.disabled = true;
  undoBtn.disabled = true;
  sortLabel.textContent = "Sorting…";
  clickError = null;
  showMessage(null);
  const res = await send({ type: "sort", windowId });
  clickError = res.ok ? null : res.error;
  sortLabel.textContent = "Sort tabs";
  apply(res);
});
undoBtn.addEventListener("click", async () => {
  undoBtn.disabled = true;
  clickError = null;
  const res = await send({ type: "undo", windowId });
  clickError = res.ok ? null : res.error;
  apply(res);
});
for (const id of ["options", "mode", "open-consent"])
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
  // Trust the worker over the marker: a worker that died mid-run can leave a stale one.
  const live = res.running ? run : undefined;
  sortLabel.textContent = live === "sort" ? "Sorting…" : "Sort tabs";
  if (live) {
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
