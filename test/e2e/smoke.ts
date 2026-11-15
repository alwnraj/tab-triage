/**
 * End-to-end smoke test in a real Chromium (fresh temp profile, MOCK classifier,
 * no network: every page is served by request interception).
 * Verifies what the unit-test fake can't: real chrome.tabs.group / tabGroups /
 * move semantics, the popup ↔ worker messaging, and Undo.
 *   npm run build && npm run test:e2e
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { launchWithExtension } from "../../scripts/browser.js";

const PAGES: Array<[string, string]> = [
  ["https://en.wikipedia.org/wiki/Calibration_(statistics)", "Calibration (statistics) - Wikipedia reference article"],
  ["https://shop.example.com/kettle", "Electric kettle - online store product page, price"],
  ["https://news.example.com/a", "Election results: news reporting"],
  ["https://recipes.example.com/pasta", "Easy pasta recipes and cooking techniques for food"],
  ["https://arxiv.org/abs/1706.03762", "Attention Is All You Need"],
  ["https://github.com/microsoft/playwright", "GitHub - microsoft/playwright: source code repositories"],
  ["https://misc.example.com/zzz", "Qwerty zxcv"],
];

const { ctx, sw, extId, profileDir } = await launchWithExtension({ headless: true });
try {
  await ctx.route("**/*", (route) => {
    const url = route.request().url();
    const hit = PAGES.find(([u]) => u === url);
    return hit
      ? route.fulfill({ contentType: "text/html", body: `<title>${hit[1]}</title><h1>${hit[1]}</h1>` })
      : route.continue();
  });

  // Seed settings: consent given, mock mode on (no key, no network).
  await sw.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get("settings")) as { settings: Record<string, unknown> };
    await chrome.storage.local.set({ settings: { ...settings, consentAt: Date.now(), mockMode: true, collapse: false } });
  });

  // Fresh tabs only: on install the extension opens its Options page, which can take over
  // the initial blank tab mid-navigation.
  const first = await ctx.newPage();
  await first.goto(PAGES[0]![0], { waitUntil: "domcontentloaded" });
  for (const [u] of PAGES.slice(1)) await (await ctx.newPage()).goto(u, { waitUntil: "domcontentloaded" });

  type Strip = { tabs: Array<{ title: string; groupId: number; index: number }>; groups: Array<{ id: number; title: string; color: string }> };
  const strip = (): Promise<Strip> =>
    sw.evaluate(async () => {
      const [w] = await chrome.windows.getAll({ windowTypes: ["normal"] });
      const tabs = await chrome.tabs.query({ windowId: w!.id });
      const groups = await chrome.tabGroups.query({ windowId: w!.id });
      return {
        tabs: tabs.map((t) => ({ title: t.title ?? "", groupId: t.groupId, index: t.index })),
        groups: groups.map((g) => ({ id: g.id, title: g.title ?? "", color: g.color })),
      };
    });
  const windowId = await sw.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ["normal"] }))[0]!.id!);
  const before = await strip();
  assert.equal(before.groups.length, 0);

  // Drive the real popup UI, opened as its own page with ?window=.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?window=${windowId}`);
  const beforeWithPopup = await strip();
  await popup.click("#sort");
  await popup.waitForSelector("#results li", { timeout: 20_000 });
  const after = await strip();
  // A mock run must always say so in the popup.
  assert.equal(await popup.isVisible("#mock"), true, "MOCK tag shown");
  console.log("summary:", (await popup.textContent("#summary"))?.replace(/\s+/g, " "));

  // The threshold now lives on the Options page, next to the last run's speed and cost.
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  assert.equal(await opts.inputValue("#threshold"), "0.8");
  await opts.waitForFunction(() => (document.getElementById("last-sort")?.textContent ?? "").includes("MOCK"));
  console.log("options:", await opts.textContent("#last-sort"));
  await opts.close();

  const groupOf = (title: string) => {
    const t = after.tabs.find((x) => x.title.startsWith(title));
    return after.groups.find((g) => g.id === t?.groupId)?.title ?? null;
  };
  console.log("groups:", after.groups.map((g) => `${g.title}/${g.color}`).join(", "));
  assert.equal(groupOf("Attention Is All You Need"), "Research", "domain rule → Research");
  assert.equal(groupOf("Easy pasta"), "Cooking");
  assert.equal(groupOf("Qwerty"), null, "nonsense tab stays ungrouped");
  // Grouped tabs must be contiguous in the strip (Chrome invariant).
  for (const g of after.groups) {
    const idx = after.tabs.filter((t) => t.groupId === g.id).map((t) => t.index);
    assert.equal(Math.max(...idx) - Math.min(...idx) + 1, idx.length, `group ${g.title} contiguous`);
  }

  // Undo restores order and grouping exactly.
  await popup.click("#undo");
  await popup.waitForFunction(() => (document.getElementById("message")?.textContent ?? "").includes("Undone"), null, { timeout: 10_000 });
  const undone = await strip();
  assert.deepEqual(
    undone.tabs.map((t) => [t.title, t.groupId]),
    beforeWithPopup.tabs.map((t) => [t.title, t.groupId]),
    "undo restores order and grouping",
  );
  assert.equal(undone.groups.length, 0);

  // Review #2 repro in real Chrome: a pre-existing user group in the MIDDLE of loose tabs
  // ([L, G1, G2, L, ...]); sorting forms new groups around it; Undo must restore it exactly.
  await sw.evaluate(async (wid) => {
    const tabs = (await chrome.tabs.query({ windowId: wid })).filter((t) => t.url?.startsWith("http"));
    const mid = [tabs[2]!.id!, tabs[3]!.id!];
    const gid = await chrome.tabs.group({ tabIds: mid as [number, number], createProperties: { windowId: wid } });
    await chrome.tabGroups.update(gid, { title: "Mine", color: "pink" });
    await chrome.tabs.update(tabs[4]!.id!, { active: true });
  }, windowId);
  const pre = await strip();
  await popup.click("#sort");
  await popup.waitForFunction(() => !(document.getElementById("sort") as HTMLButtonElement).disabled, null, { timeout: 20_000 });
  const mid = await strip();
  assert.ok(mid.groups.length > 1, "new groups formed");
  await popup.click("#undo");
  await popup.waitForFunction(() => (document.getElementById("message")?.textContent ?? "").includes("Undone"), null, { timeout: 10_000 });
  const msgText = await popup.textContent("#message");
  assert.doesNotMatch(msgText ?? "", /could not be put back/);
  const post = await strip();
  const named = (st: Strip) => st.tabs.map((t) => [t.title, st.groups.find((g) => g.id === t.groupId)?.title ?? null]);
  assert.deepEqual(named(post), named(pre), "order and grouping restored around a pre-existing group");
  assert.deepEqual(post.groups.map((g) => [g.title, g.color]), pre.groups.map((g) => [g.title, g.color]));

  // Live popup: a sort started outside the popup (as the demo does with the toolbar
  // dropdown) must show up in an already-open popup without clicking anything.
  await sw.evaluate(async (wid) => {
    const t = (globalThis as { tabTriage?: { handle(m: unknown): Promise<unknown> } }).tabTriage!;
    await t.handle({ type: "sort", windowId: wid, threshold: 0.8 });
  }, windowId);
  await popup.waitForFunction(() => !(document.getElementById("message")?.textContent ?? "").includes("Undone") && !!document.querySelector("#summary .chip"), null, { timeout: 10_000 });
  assert.equal(await popup.isEnabled("#undo"), true, "popup picked up the new run");
  await sw.evaluate(async (wid) => {
    const t = (globalThis as { tabTriage?: { handle(m: unknown): Promise<unknown> } }).tabTriage!;
    await t.handle({ type: "undo", windowId: wid });
  }, windowId);
  await popup.waitForFunction(() => (document.getElementById("message")?.textContent ?? "").includes("Undone"), null, { timeout: 10_000 });

  console.log("E2E smoke: PASS");
} finally {
  await ctx.close();
  rmSync(profileDir, { recursive: true, force: true });
}
