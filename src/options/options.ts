import { MAX_GROUPS, MODEL_ID, RELEASE, SERVICE_URL } from "../core/config.js";
import { type HostedRequest, INSTALL_HEADER } from "../providers/wire.js";
import { AnswerCache } from "../core/cache.js";
import { toModelGroups } from "../core/groups.js";
import { normalizeDomain, toTabInput, truncateTitle } from "../core/privacy.js";
import { GROUP_COLORS, type GroupDef } from "../core/types.js";
import { buildRequest } from "../providers/request.js";
import type { SortReport } from "../core/sort.js";
import { chromeKV, loadSettings, sanitize, saveSettings, type Settings } from "../settings.js";

const kv = chromeKV(chrome.storage.local);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let s: Settings;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** What this page last wrote, so its own writes don't trigger a re-render below. */
let lastSaved = "";
async function saveNow() {
  clearTimeout(saveTimer);
  lastSaved = JSON.stringify(sanitize(s));
  await saveSettings(kv, s);
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 1500);
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 250);
  renderExample();
}

function renderExample() {
  const mg = toModelGroups(s.groups);
  const pre = $("example");
  if (!mg.length) {
    pre.textContent = "(No group has a description, so nothing is sent: every group is matched by domain only.)";
    return;
  }
  const input = { site: "en.wikipedia.org", title: truncateTitle("Calibration (statistics) - Wikipedia") };
  // Exactly what HostedClassifier sends, then what the service builds from it with the same buildRequest().
  const sent: HostedRequest = { v: 1, ...input, groups: mg.map(({ key, description }) => ({ key, description })), order: "fwd" };
  pre.textContent =
    `From your browser:\nPOST ${SERVICE_URL}/api/classify\n${INSTALL_HEADER}: <random install id>\n\n${JSON.stringify(sent, null, 2)}` +
    `\n\nWhat the service sends on to TypeSafe:\nPOST https://api.typesafe.ai/v1/systemone\n\n${JSON.stringify(buildRequest(MODEL_ID, input, mg, "fwd"), null, 2)}`;
}

function groupRow(g: GroupDef): HTMLElement {
  const wrap = el("div", { className: "group" });
  const name = el("input", { type: "text", value: g.name, placeholder: "Group name", maxLength: 40 });
  name.setAttribute("aria-label", "Group name");
  const color = el("select");
  color.setAttribute("aria-label", "Colour");
  for (const c of GROUP_COLORS) color.append(el("option", { value: c, textContent: c, selected: c === g.color }));
  const del = el("button", { textContent: "Remove" });
  const desc = el("textarea", { value: g.description, rows: 2, placeholder: "Plain-language description (sent to the model)", maxLength: 500 });
  desc.setAttribute("aria-label", "Description");
  const domains = el("input", { type: "text", className: "domains", value: g.domains.join(", "), placeholder: "Domains (optional): arxiv.org, docs.python.org" });
  domains.setAttribute("aria-label", "Domains");

  name.addEventListener("input", () => ((g.name = name.value), persist()));
  color.addEventListener("change", () => ((g.color = color.value as GroupDef["color"]), persist()));
  desc.addEventListener("input", () => ((g.description = desc.value), persist()));
  domains.addEventListener("change", () => {
    g.domains = domains.value.split(/[,\s]+/).map(normalizeDomain).filter(Boolean);
    domains.value = g.domains.join(", ");
    persist();
  });
  del.addEventListener("click", () => {
    s.groups = s.groups.filter((x) => x !== g);
    renderGroups();
    persist();
  });
  wrap.append(name, color, del, desc, domains);
  return wrap;
}

function renderGroups() {
  $("groups").replaceChildren(...s.groups.map(groupRow));
  // The service accepts at most MAX_GROUPS groups per request.
  const full = s.groups.length >= MAX_GROUPS;
  $<HTMLButtonElement>("add-group").disabled = full;
  $("group-limit").classList.toggle("hidden", !full);
}

function renderConsent() {
  $("consent-box").classList.toggle("hidden", !!s.consentAt);
  $("consent-done").classList.toggle("hidden", !s.consentAt);
  if (s.consentAt) $("consent-date").textContent = new Date(s.consentAt).toLocaleString();
}


async function exportTabs() {
  const tabs = await chrome.tabs.query({});
  const wins = new Map((await chrome.windows.getAll()).map((w) => [w.id, w.incognito]));
  const rows = [];
  for (const t of tabs) {
    if (wins.get(t.windowId) || typeof t.id !== "number") continue;
    const e = toTabInput({ id: t.id, index: t.index, windowId: t.windowId, groupId: -1, pinned: t.pinned, url: t.url, title: t.title }, s.blocklist);
    if (e.ok) rows.push(e.input);
  }
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), tabs: rows }, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "tabs-export.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $("data-status").textContent = `Exported ${rows.length} tabs.`;
}

/** The most recent sort in any window: its speed and cost (the popup keeps to results only). */
async function renderLastSort() {
  const all = await chrome.storage.session.get(null);
  const reports = Object.entries(all)
    .filter(([k]) => k.startsWith("report:"))
    .map(([, v]) => v as SortReport)
    .sort((a, b) => b.at - a.at);
  const r = reports[0];
  if (!r) return;
  const m = r.metrics;
  const cost = m.estCostUsd === 0 ? "$0" : m.estCostUsd < 0.0001 ? `$${m.estCostUsd.toExponential(1)}` : `$${m.estCostUsd.toFixed(4)}`;
  $("last-sort").textContent =
    `Last sort: ${(m.latencyMs / 1000).toFixed(2)} s · est. ${cost} (${m.inputTokens} input tokens) · ` +
    `${Math.round(m.sortedPct * 100)}% sorted · ${m.apiCalls} calls, ${m.cacheHits} cached · ${r.mock ? "MOCK classifier" : r.classifierId}`;
}

function renderAll() {
  renderGroups();
  renderConsent();
  renderExample();
  $<HTMLTextAreaElement>("blocklist").value = s.blocklist.join("\n");
  $<HTMLInputElement>("threshold").value = String(s.threshold);
  $("threshold-value").textContent = s.threshold.toFixed(2);
  $<HTMLInputElement>("collapse").checked = s.collapse;
  $<HTMLInputElement>("mock").checked = s.mockMode;
  $<HTMLInputElement>("strict").checked = s.strict;
  $<HTMLInputElement>("threshold").disabled = !s.strict;
}

async function init() {
  s = await loadSettings(kv);
  lastSaved = JSON.stringify(s);
  renderAll();
  if (RELEASE) {
    $("mock-row").classList.add("hidden");
    $("export-row").classList.add("hidden");
  }
  $("service-host").textContent = new URL(SERVICE_URL).host;
  $<HTMLAnchorElement>("privacy-link").href = `${SERVICE_URL}/privacy`;
  const th = $<HTMLInputElement>("threshold");
  th.addEventListener("input", () => {
    s.threshold = Number(th.value);
    $("threshold-value").textContent = s.threshold.toFixed(2);
    persist();
  });
  void renderLastSort();

  $("add-group").addEventListener("click", () => {
    if (s.groups.length >= MAX_GROUPS) return;
    s.groups.push({ id: crypto.randomUUID(), name: "New group", color: "grey", description: "", domains: [] });
    renderGroups();
    persist();
  });
  $("blocklist").addEventListener("change", () => {
    s.blocklist = $<HTMLTextAreaElement>("blocklist").value.split(/\s+/).map(normalizeDomain).filter(Boolean);
    $<HTMLTextAreaElement>("blocklist").value = s.blocklist.join("\n");
    persist();
  });
  $("strict").addEventListener("change", () => {
    s.strict = $<HTMLInputElement>("strict").checked;
    $<HTMLInputElement>("threshold").disabled = !s.strict;
    persist();
  });
  $("collapse").addEventListener("change", () => ((s.collapse = $<HTMLInputElement>("collapse").checked), persist()));
  $("mock").addEventListener("change", () => ((s.mockMode = $<HTMLInputElement>("mock").checked), persist()));
  // Consent is saved at once, not debounced: closing the tab right after must not lose it.
  $("accept").addEventListener("click", () => {
    s.consentAt = Date.now();
    renderConsent();
    void saveNow();
  });
  $("revoke").addEventListener("click", () => {
    s.consentAt = null;
    renderConsent();
    void saveNow();
  });
  $("clear-cache").addEventListener("click", async () => {
    await new AnswerCache(kv).clear();
    $("data-status").textContent = "Cache cleared.";
  });
  $("export").addEventListener("click", () => void exportTabs());

  // Stay current: settings changed in another Options tab, and the latest sort's numbers.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "session" && Object.keys(changes).some((k) => k.startsWith("report:"))) void renderLastSort();
    if (area === "local" && "settings" in changes) {
      const fresh = await loadSettings(kv);
      if (JSON.stringify(fresh) === lastSaved) return; // our own write
      clearTimeout(saveTimer);
      s = fresh;
      lastSaved = JSON.stringify(s);
      renderAll();
    }
  });
}

void init();
