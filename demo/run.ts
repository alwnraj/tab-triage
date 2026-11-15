/**
 * npm run demo [-- --mock] [--no-record] [--keep-raw]
 *
 * Records the REAL extension in a headed Chromium with a fresh temporary profile
 * (none of your tabs, bookmarks or accounts), capturing the OS screen so the real
 * tab strip is in frame, then edits it with ffmpeg into:
 *   demo/out/tab-triage-demo.mp4 (gitignored), demo/demo.gif, demo/poster.png
 *
 * --mock  rehearsal with the keyword MockClassifier. Outputs go to demo/out/rehearsal-*
 *         and are captioned MOCK; demo/demo.gif and demo/poster.png are NOT touched.
 * Without --mock the real classifier is used, through the hosted service.
 *
 * Capture: macOS → avfoundation (needs Screen Recording permission);
 *          Linux → x11grab (run under `xvfb-run -s "-screen 0 1920x1080x24"`).
 * Playwright can't click inside the toolbar popup, so sort and undo are started through
 * the worker; the open popup updates itself from session state.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launchWithExtension } from "../scripts/browser.js";
import type { SortReport } from "../src/core/sort.js";
import { DEFAULT_GROUPS } from "../src/settings.js";
import { edit } from "./edit.js";

const { values: args } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    "no-record": { type: "boolean", default: false },
    "keep-raw": { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
  },
});
const MOCK = args.mock === true;
const HEADLESS = args.headless === true;
const RECORD = args["no-record"] !== true && !HEADLESS;
const OUT = "demo/out";
const PREFIX = MOCK ? "rehearsal-" : "";
const mac = process.platform === "darwin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

function run(cmd: string, a: string[]) {
  return execFileSync(cmd, a, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
}

// ---------- preflight ----------
// A real run uses the hosted service the extension is built against (no key here).
// Keep any key in the environment out of every child process (Chromium, ffmpeg).
delete process.env.TYPESAFE_API_KEY;
try {
  run("ffmpeg", ["-version"]);
} catch {
  console.error("ffmpeg not found on PATH.");
  process.exit(1);
}
// Without Screen Recording permission, avfoundation opens but never delivers a frame and
// ffmpeg ignores SIGTERM, so probe it with a hard SIGKILL deadline before doing anything else.
if (RECORD && mac) {
  const probe = join(OUT, "capture-probe.mkv");
  rmSync(probe, { force: true });
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-framerate", "30", "-i", "Capture screen 0:none", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", probe], { stdio: "ignore" });
    const timer = setTimeout(() => (p.kill("SIGKILL"), resolve(false)), 10_000);
    p.on("exit", (code) => (clearTimeout(timer), resolve(code === 0)));
  });
  rmSync(probe, { force: true });
  if (!ok) {
    console.error(
      "Screen capture produced no frames within 10 s. macOS is most likely blocking it:\n" +
        "System Settings → Privacy & Security → Screen & System Audio Recording → allow the app that runs this\n" +
        "command (your terminal, or Claude), then quit and reopen that app and try again.",
    );
    process.exit(1);
  }
}
const urls = (JSON.parse(readFileSync("demo/urls.json", "utf8")) as { tabs: Array<{ url: string }> }).tabs.map((t) => t.url);
console.log(`[demo] building extension…`);
run("node", ["scripts/build.mjs"]);

// A run killed with SIGKILL or a crash can't clean up after itself, and chrome.storage's
// remove() is only a logical delete, so sweep profiles left by earlier runs.
for (const d of readdirSync(tmpdir())) {
  if (!d.startsWith("tab-triage-profile-")) continue;
  const p = join(tmpdir(), d);
  try {
    if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

// ---------- browser ----------
const WIN = mac ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
const { ctx, sw, extId, profileDir } = await launchWithExtension({
  headless: HEADLESS,
  viewport: HEADLESS ? WIN : null,
  args: [`--window-size=${WIN.width},${WIN.height}`, "--window-position=0,0", "--hide-crash-restore-bubble", "--disable-session-crashed-bubble"],
});
let recorder: ChildProcess | null = null;
const raw = join(OUT, `${PREFIX}raw.mkv`);
const removeProfile = () => rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
// If interrupted: stop capture, close Chromium FIRST (deleting a profile it is still writing
// can fail half-way), then delete the profile and the raw capture.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, async () => {
    recorder?.kill("SIGKILL");
    await Promise.race([ctx.close().catch(() => undefined), sleep(3000)]);
    try {
      removeProfile();
    } catch {}
    if (!args["keep-raw"]) rmSync(raw, { force: true });
    process.exit(130);
  });
process.on("exit", () => {
  try {
    removeProfile();
  } catch {}
});
try {
  const windowId: number = await sw.evaluate(async (w) => {
    const [win] = await chrome.windows.getAll({ windowTypes: ["normal"] });
    await chrome.windows.update(win!.id!, { left: 0, top: 0, width: w.width, height: w.height, focused: true });
    return win!.id!;
  }, WIN);

  // Settings in the TEMPORARY profile only: consent, default groups and mode.
  await sw.evaluate(
    async ({ groups, mock }) => {
      const { settings } = (await chrome.storage.local.get("settings")) as { settings: Record<string, unknown> };
      await chrome.storage.local.set({ settings: { ...settings, groups, consentAt: Date.now(), mockMode: mock, collapse: false, threshold: 0.8 } });
    },
    { groups: DEFAULT_GROUPS, mock: MOCK },
  );

  console.log(`[demo] opening ${urls.length} public pages…`);
  const first = ctx.pages()[0] ?? (await ctx.newPage());
  const pages = [first, ...(await Promise.all(urls.slice(1).map(() => ctx.newPage())))];
  await Promise.all(
    urls.map((u, i) => pages[i]!.goto(u, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => console.warn(`  (slow or failed: ${u})`))),
  );
  await sleep(2500);
  // Bot-check interstitials and dead pages make bad demo tabs; name them so urls.json can be fixed.
  const blocked: string[] = [];
  for (const [i, p] of pages.entries()) {
    const title = await p.title().catch(() => "");
    if (/just a moment|attention required|verify you are human|access denied|are you a robot|not found|\b404\b/i.test(title)) blocked.push(`${urls[i]} → "${title}"`);
  }
  for (const b of blocked) console.warn(`  (bot check: ${b})`);
  // A rehearsal can live with them; the published video shouldn't show challenge pages.
  if (blocked.length && !MOCK) throw new Error(`${blocked.length} page(s) served a bot check or a 404: replace them in demo/urls.json and re-run`);
  await sw.evaluate(async (wid) => {
    const tabs = await chrome.tabs.query({ windowId: wid });
    await chrome.tabs.update(tabs[0]!.id!, { active: true });
  }, windowId);

  const bounds = await sw.evaluate(async (wid) => {
    const w = await chrome.windows.get(wid);
    return { left: w.left!, top: w.top!, width: w.width!, height: w.height! };
  }, windowId);
  const screenInfo = await first.evaluate(() => ({ w: screen.width, h: screen.height, dpr: devicePixelRatio }));
  console.log(`[demo] window ${JSON.stringify(bounds)} on screen ${screenInfo.w}x${screenInfo.h} @${screenInfo.dpr}x`);

  // ---------- record ----------
  const events: Record<string, number> = {};
  let t0 = Date.now();
  const mark = (name: string) => {
    events[name] = (Date.now() - t0) / 1000;
    console.log(`  ${events[name]!.toFixed(1)}s ${name}`);
  };
  if (RECORD) {
    let input: string[];
    if (mac) {
      const list = (() => {
        try {
          return run("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
        } catch (e) {
          return String((e as { stderr?: Buffer }).stderr ?? "");
        }
      })();
      const idx = /\[(\d+)\] Capture screen 0/.exec(list)?.[1];
      if (!idx) throw new Error("No 'Capture screen 0' avfoundation device found");
      input = ["-f", "avfoundation", "-capture_cursor", "1", "-framerate", "30", "-i", `${idx}:none`];
    } else {
      input = ["-f", "x11grab", "-video_size", "1920x1080", "-framerate", "30", "-i", process.env.DISPLAY ?? ":99"];
    }
    rmSync(raw, { force: true });
    recorder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...input, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", raw], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    await sleep(1500); // let capture warm up
  }
  t0 = Date.now();
  mark("messy");
  await sleep(5000);

  // The real toolbar dropdown (chrome.action.openPopup). Playwright can't click inside an
  // action popup, so the demo starts the sort and undo through the worker; the open popup
  // updates itself live from session state, exactly as it does for a user.
  type Handle = { handle(m: unknown): Promise<{ ok: boolean; error?: string }> };
  const act = (m: object) =>
    sw.evaluate(async (msg) => (globalThis as unknown as { tabTriage: Handle }).tabTriage.handle(msg), m as Record<string, unknown>);
  const popupOpen = () => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["POPUP" as chrome.runtime.ContextType] })).length > 0);
  if (HEADLESS) {
    // No toolbar to anchor to in headless mode: show the same page as a tab instead.
    await (await ctx.newPage()).goto(`chrome-extension://${extId}/popup.html?window=${windowId}`);
  } else {
    await sw.evaluate(async (wid) => {
      await chrome.windows.update(wid, { focused: true });
      await chrome.action.openPopup({ windowId: wid });
    }, windowId);
    await sleep(500);
    if (!(await popupOpen())) throw new Error("The toolbar popup didn't open");
  }
  mark("popup");
  await sleep(2000);

  mark("sortClick");
  const sorted = await act({ type: "sort", windowId, threshold: 0.8 });
  if (!sorted.ok) throw new Error(`Sort failed: ${sorted.error}`);
  mark("sorted");
  await sleep(3500);
  mark("leftAlone");
  await sleep(6000);

  await sw.evaluate(async (wid) => {
    for (const g of await chrome.tabGroups.query({ windowId: wid })) await chrome.tabGroups.update(g.id, { collapsed: true });
  }, windowId);
  mark("collapsed");
  await sleep(3500);

  const undone = await act({ type: "undo", windowId });
  if (!undone.ok) throw new Error(`Undo failed: ${undone.error}`);
  mark("undone");
  if (!HEADLESS && !(await popupOpen())) console.warn("  (the toolbar popup closed during the run: check the video)");
  await sleep(4500);
  mark("end");

  if (recorder) {
    recorder.stdin?.write("q");
    await new Promise((r) => recorder!.once("exit", r));
    recorder = null;
  }

  const report = (await sw.evaluate(async (wid) => (await chrome.storage.session.get(`report:${wid}`))[`report:${wid}`], windowId)) as SortReport | undefined;
  if (!report) throw new Error("No sort report found");
  const log = { mock: MOCK, classifier: report.classifierId, events, bounds, screen: screenInfo, metrics: report.metrics, at: new Date().toISOString() };
  writeFileSync(join(OUT, `${PREFIX}run-log.json`), JSON.stringify(log, null, 2));
  console.log(`[demo] measured: ${JSON.stringify(report.metrics)}`);

  if (!RECORD) {
    console.log("[demo] not recording: flow check done.");
  } else {
    await ctx.close();
    await edit(raw, log, report, { mock: MOCK, keepRaw: args["keep-raw"] === true });
  }
} finally {
  if (recorder) recorder.kill("SIGKILL");
  await ctx.close().catch(() => undefined);
  removeProfile();
  // The raw capture is the whole screen: never leave it behind, even when editing failed.
  if (!args["keep-raw"]) rmSync(raw, { force: true });
}

