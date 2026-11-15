import { MODEL_ID } from "../core/config.js";
import { AnswerCache } from "../core/cache.js";
import { toModelGroups } from "../core/groups.js";
import { normalizeDomain, toTabInput, truncateTitle } from "../core/privacy.js";
import { GROUP_COLORS, type GroupDef } from "../core/types.js";
import { buildRequest } from "../providers/request.js";
import { chromeKV, loadApiKey, loadSettings, saveApiKey, saveSettings, type Settings } from "../settings.js";

const kv = chromeKV(chrome.storage.local);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let s: Settings;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(kv, s);
    $("saved").textContent = "Saved.";
    setTimeout(() => ($("saved").textContent = ""), 1500);
  }, 250);
  renderExample();
}

function renderExample() {
  const mg = toModelGroups(s.groups);
  const pre = $("example");
  if (!mg.length) {
    pre.textContent = "(No group has a description, so nothing is sent: every group is matched by domain only.)";
    return;
  }
  const body = buildRequest(MODEL_ID, { site: "en.wikipedia.org", title: truncateTitle("Calibration (statistics) - Wikipedia") }, mg, "fwd");
  pre.textContent = `POST https://api.typesafe.ai/v1/systemone\nAuthorization: Bearer <your key>\n\n${JSON.stringify(body, null, 2)}`;
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
}

function renderConsent() {
  $("consent-box").classList.toggle("hidden", !!s.consentAt);
  $("consent-done").classList.toggle("hidden", !s.consentAt);
  if (s.consentAt) $("consent-date").textContent = new Date(s.consentAt).toLocaleString();
}

async function renderKeyStatus() {
  const k = await loadApiKey(kv);
  $("key-status").textContent = k ? "A key is saved. (It is never displayed.)" : "No key saved.";
}

async function exportTabs() {
  const tabs = await chrome.tabs.query({});
  const wins = new Map((await chrome.windows.getAll()).map((w) => [w.id, w.incognito]));
  const rows = [];
  for (const t of tabs) {
    if (wins.get(t.windowId) || typeof t.id !== "number") continue;
    const e = toTabInput({ id: t.id, index: t.index, windowId: t.windowId, groupId: -1, pinned: false, url: t.url, title: t.title }, s.blocklist);
    if (e.ok) rows.push(e.input);
  }
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), tabs: rows }, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "tabs-export.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $("data-status").textContent = `Exported ${rows.length} tabs.`;
}

async function init() {
  s = await loadSettings(kv);
  renderGroups();
  renderConsent();
  renderExample();
  await renderKeyStatus();
  $<HTMLTextAreaElement>("blocklist").value = s.blocklist.join("\n");
  $<HTMLInputElement>("collapse").checked = s.collapse;
  $<HTMLInputElement>("mock").checked = s.mockMode;

  $("add-group").addEventListener("click", () => {
    s.groups.push({ id: crypto.randomUUID(), name: "New group", color: "grey", description: "", domains: [] });
    renderGroups();
    persist();
  });
  $("blocklist").addEventListener("change", () => {
    s.blocklist = $<HTMLTextAreaElement>("blocklist").value.split(/\s+/).map(normalizeDomain).filter(Boolean);
    $<HTMLTextAreaElement>("blocklist").value = s.blocklist.join("\n");
    persist();
  });
  $("collapse").addEventListener("change", () => ((s.collapse = $<HTMLInputElement>("collapse").checked), persist()));
  $("mock").addEventListener("change", () => ((s.mockMode = $<HTMLInputElement>("mock").checked), persist()));
  $("accept").addEventListener("click", () => {
    s.consentAt = Date.now();
    renderConsent();
    persist();
  });
  $("revoke").addEventListener("click", () => {
    s.consentAt = null;
    renderConsent();
    persist();
  });
  $("save-key").addEventListener("click", async () => {
    const input = $<HTMLInputElement>("api-key");
    await saveApiKey(kv, input.value);
    input.value = "";
    await renderKeyStatus();
  });
  $("clear-key").addEventListener("click", async () => {
    await saveApiKey(kv, "");
    await renderKeyStatus();
  });
  $("clear-cache").addEventListener("click", async () => {
    await new AnswerCache(kv).clear();
    $("data-status").textContent = "Cache cleared.";
  });
  $("export").addEventListener("click", () => void exportTabs());
}

void init();
