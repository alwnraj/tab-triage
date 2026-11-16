import { chromeAdapter } from "./browser/adapter.js";
import { AnswerCache } from "./core/cache.js";
import type { Snapshot } from "./core/plan.js";
import { restoreSnapshot } from "./core/plan.js";
import { runSort, type SortReport } from "./core/sort.js";
import { parseRequest, type Response } from "./messages.js";
import type { Classifier } from "./providers/classifier.js";
import { ClassifierError } from "./providers/classifier.js";
import { MockClassifier } from "./providers/mock.js";
import { RELEASE } from "./core/config.js";
import { HostedClassifier } from "./providers/hosted.js";
import { chromeKV, installId, loadSettings, saveSettings } from "./settings.js";

const local = chromeKV(chrome.storage.local);
const session = chromeKV(chrome.storage.session);
const cache = new AnswerCache(local);
let running = false;

const reportKey = (w: number) => `report:${w}`;
const undoKey = (w: number) => `undo:${w}`;
/** Present while a sort or undo runs, so an open popup can show it live. */
const runKey = (w: number) => `run:${w}`;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const s = await loadSettings(local);
  await saveSettings(local, s); // materialise defaults
  await installId(local);
  if (reason === "install" && !s.consentAt) await chrome.runtime.openOptionsPage();
});

// A worker that stopped mid-run leaves its "running" marker behind; nothing runs at startup.
void chrome.storage.session.get(null).then((all) => {
  const stale = Object.keys(all).filter((k) => k.startsWith("run:"));
  if (stale.length) return chrome.storage.session.remove(stale);
});

async function state(windowId: number) {
  const got = await session.get([reportKey(windowId), undoKey(windowId)]);
  return {
    report: (got[reportKey(windowId)] as SortReport | undefined) ?? null,
    canUndo: !!got[undoKey(windowId)],
  };
}

async function makeClassifier(mock: boolean): Promise<Classifier> {
  if (mock) return new MockClassifier(60);
  return new HostedClassifier({ installId: await installId(local) });
}

async function handle(msg: unknown): Promise<Response> {
  const req = parseRequest(msg);
  if (!req) return { ok: false, error: "Bad request." };

  let win: chrome.windows.Window;
  try {
    win = await chrome.windows.get(req.windowId);
  } catch {
    return { ok: false, error: "That window no longer exists." };
  }
  if (win.incognito) return { ok: false, error: "tab-triage does not run in incognito windows." };

  if (req.type === "status") return { ok: true, running, ...(await state(req.windowId)) };
  if (running) return { ok: false, error: "A sort is already running.", running, ...(await state(req.windowId)) };

  running = true;
  // Chrome may stop an idle worker after ~30 s; a run can wait up to a minute on a rate limit.
  // Any extension API call counts as activity.
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  try {
    await session.set({ [runKey(req.windowId)]: req.type });
    if (req.type === "undo") {
      const snap = (await session.get([undoKey(req.windowId)]))[undoKey(req.windowId)] as Snapshot | undefined;
      if (!snap) return { ok: false, error: "Nothing to undo.", running: false, ...(await state(req.windowId)) };
      const r = await restoreSnapshot(chromeAdapter, snap);
      await session.remove([undoKey(req.windowId)]);
      const s = await state(req.windowId);
      const note =
        (r.missing ? ` (${r.missing} tab(s) had been closed)` : "") + (r.exact ? "" : " Some tabs could not be put back exactly.");
      const report = s.report ? { ...s.report, message: `Undone${note}.` } : null;
      if (report) await session.set({ [reportKey(req.windowId)]: report });
      return { ok: true, running: false, ...s, report };
    }

    const settings = await loadSettings(local);
    if (!settings.consentAt)
      return { ok: false, error: "Please review and accept what gets sent (Options page) first.", ...(await state(req.windowId)) };

    let classifier: Classifier;
    try {
      // Mock mode is a developer tool; a store build ignores a stale setting.
      classifier = await makeClassifier(settings.mockMode && !RELEASE);
    } catch (e) {
      return { ok: false, error: e instanceof ClassifierError ? e.message : "Couldn't start the classifier.", ...(await state(req.windowId)) };
    }

    const report = await runSort(
      { windowId: req.windowId, threshold: settings.threshold, collapse: settings.collapse, groups: settings.groups, blocklist: settings.blocklist },
      {
        browser: chromeAdapter,
        classifier,
        cache,
        saveSnapshot: (snap) => session.set({ [undoKey(req.windowId)]: snap }),
        clearSnapshot: () => session.remove([undoKey(req.windowId)]),
      },
    );
    await session.set({ [reportKey(req.windowId)]: report });
    return { ok: true, running: false, ...(await state(req.windowId)), report };
  } catch (e) {
    // Never crash the worker; never echo internals that could contain secrets.
    console.warn("tab-triage: run failed:", e instanceof Error ? e.name : "unknown");
    return {
      ok: false,
      error: "Something went wrong. No further tabs were moved; try Undo if anything changed.",
      ...(await state(req.windowId).catch(() => ({ report: null, canUndo: false }))),
    };
  } finally {
    clearInterval(keepAlive);
    running = false;
    await session.remove([runKey(req.windowId)]).catch(() => undefined);
  }
}

// For automation in dev builds (the demo drives a sort while the real toolbar popup is
// open, which Playwright can't click into). Only code inside this worker can reach it.
if (!RELEASE) (globalThis as { tabTriage?: unknown }).tabTriage = { handle };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages may drive the worker.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  handle(msg).then(sendResponse, () => sendResponse({ ok: false, error: "Unexpected error." } satisfies Response));
  return true;
});
