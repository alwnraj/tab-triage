/**
 * npx tsx store/make-assets.ts
 *
 * Chrome Web Store images, made from the real-classifier demo recording
 * (demo/out/tab-triage-demo.mp4 + run-log.json from `npm run demo`) and the real
 * Options page:
 *   store/screenshot-1..5.png  1280×800
 *   store/promo-small.png      440×280
 *   store/promo-marquee.png    1400×560
 *   store/store-icon.png       128×128 (96×96 artwork, transparent padding)
 * Frames are cropped above the demo's own captions. Refuses mock recordings.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { chromiumPath, launchWithExtension } from "../scripts/browser.js";

const OUT = "store";
const TMP = join(OUT, ".tmp");
const video = "demo/out/tab-triage-demo.mp4";
const log = JSON.parse(readFileSync("demo/out/run-log.json", "utf8")) as { mock: boolean; events: Record<string, number> };
if (log.mock) throw new Error("Store images must come from a real-classifier recording (run `npm run demo`).");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// Where each step sits in the edited video (mirrors demo/edit.ts: 3 s title card, classify sped up to ~2.5 s).
const e = log.events as Required<Record<"messy" | "popup" | "sortClick" | "sorted" | "leftAlone" | "collapsed" | "undone" | "end", number>>;
const classify = e.sorted - e.sortClick;
const speed = classify > 3 ? classify / 2.5 : 1;
const durs = [e.popup - e.messy, e.sortClick + 0.3 - e.popup, (e.sorted - (e.sortClick + 0.3)) / speed, e.leftAlone - e.sorted, e.collapsed - e.leftAlone, e.undone - e.collapsed, e.end - e.undone];
const start = (i: number) => 3 + durs.slice(0, i).reduce((a, b) => a + b, 0);
const at = { messy: start(0) + durs[0]! * 0.6, sorted: start(3) + durs[3]! * 0.7, collapsed: start(5) + durs[5]! * 0.6, undone: start(6) + durs[6]! * 0.6 };

function frame(name: string, t: number, crop = "crop=1920:860:0:0"): string {
  const f = join(TMP, `${name}.png`);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", crop, f]);
  return f;
}
const b64 = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;

const shots = {
  sorted: frame("sorted", at.sorted),
  messy: frame("messy", at.messy),
  collapsed: frame("collapsed", at.collapsed),
  undone: frame("undone", at.undone),
  // The popup itself, larger: it sits at the right of the 1920-wide frame.
  popup: frame("popup", at.sorted, "crop=520:896:1120:124"),
};

// The real Options page, from a fresh profile with the release build.
execFileSync("node", ["scripts/package.mjs"], { stdio: "ignore" });
const opt = join(TMP, "options.png");
{
  const { ctx, extId, profileDir } = await launchWithExtension({ headless: true, viewport: { width: 800, height: 1000 } });
  try {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/options.html`);
    await p.click("#accept");
    await p.evaluate(() => document.querySelector("h2")?.closest("section")?.scrollIntoView());
    await p.screenshot({ path: opt, clip: { x: 0, y: 0, width: 800, height: 1000 } });
  } finally {
    await ctx.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

const FONT = `-apple-system, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage();
async function render(html: string, w: number, h: number, path: string) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box} html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:${FONT};
    background:radial-gradient(1200px 600px at 20% 0%,#2a2540 0%,#16151d 60%);color:#f1f0f7}
    h1{font-size:40px;font-weight:750;letter-spacing:-.5px;margin:0} p{font-size:21px;color:#b9b6c8;margin:10px 0 0}
    .shot{border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:block}
  </style>${html}`);
  await page.waitForLoadState("load");
  await page.screenshot({ path });
}
const full = (title: string, sub: string, img: string) =>
  `<div style="display:flex;flex-direction:column;height:800px">
     <div style="padding:44px 50px 0"><h1>${title}</h1><p>${sub}</p></div>
     <div style="flex:1;display:flex;align-items:center;justify-content:center"><img class="shot" src="${b64(img)}" style="width:1180px"></div></div>`;

await render(full("Sorts your tabs into groups, only when it's sure", "Real Chrome tab groups, made by a calibrated classifier. One click, one window.", shots.sorted), 1280, 800, join(OUT, "screenshot-1.png"));
await render(
  `<div style="display:flex;gap:56px;padding:56px 64px;align-items:center;height:800px">
     <div style="flex:1"><h1>Not sure? It leaves the tab alone.</h1>
       <p>Every tab shows its probability. Tabs below your threshold stay exactly where they are, with the reason why.</p>
       <p style="margin-top:22px">No account and no API key: install it, accept the one-screen consent, press Sort.</p></div>
     <img class="shot" src="${b64(shots.popup)}" style="height:690px"></div>`,
  1280, 800, join(OUT, "screenshot-2.png"),
);
await render(full("Before: tabs in no order", "tab-triage only looks at the tabs in the current window.", shots.messy), 1280, 800, join(OUT, "screenshot-3.png"));
await render(full("Undo puts every tab back", "Order and groups, including the groups you made yourself, restored from a snapshot.", shots.undone), 1280, 800, join(OUT, "screenshot-4.png"));
await render(
  `<div style="display:flex;gap:48px;padding:52px 60px;height:800px">
     <div style="width:400px;flex:none;padding-top:20px"><h1>You choose the groups. You see what's sent.</h1>
       <p>Describe each group in plain words. The Options page shows the exact request: a hostname and a title, nothing else.</p></div>
     <img class="shot" src="${b64(opt)}" style="width:557px;height:696px;object-fit:cover;object-position:top"></div>`,
  1280, 800, join(OUT, "screenshot-5.png"),
);
await render(
  `<div style="height:280px;display:flex;flex-direction:column;justify-content:center;padding:0 34px;gap:14px">
     <div style="display:flex;gap:8px">${["#1a73e8", "#188038", "#fa903e", "#d93025", "#a142f4"].map((c) => `<div style="width:46px;height:10px;border-radius:5px;background:${c}"></div>`).join("")}</div>
     <div style="font-size:46px;font-weight:800;letter-spacing:-1px">tab-triage</div>
     <div style="font-size:19px;color:#c9c6d8;line-height:1.35">Sorts your tabs into groups,<br>only when it's sure. Undo anytime.</div></div>`,
  440, 280, join(OUT, "promo-small.png"),
);
await render(
  `<div style="display:flex;align-items:center;gap:64px;height:560px;padding:0 80px">
     <div style="flex:1;display:flex;flex-direction:column;gap:20px">
       <div style="display:flex;gap:10px">${["#1a73e8", "#188038", "#fa903e", "#d93025", "#a142f4"].map((c) => `<div style="width:64px;height:14px;border-radius:7px;background:${c}"></div>`).join("")}</div>
       <div style="font-size:84px;font-weight:800;letter-spacing:-2px;line-height:1">tab-triage</div>
       <div style="font-size:30px;color:#c9c6d8;line-height:1.35">Sorts your tabs into Chrome tab groups,<br>only when it's sure. Undo anytime.</div>
     </div>
     <img class="shot" src="${b64(shots.popup)}" style="height:470px"></div>`,
  1400, 560, join(OUT, "promo-marquee.png"),
);
await browser.close();

// Store icon: the 128px icon's artwork at 96×96, centred on a transparent 128×128 canvas
// (Chrome Web Store icon guidelines). Needs dist/ from `npm run package`.
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", "dist/icons/icon128.png", "-vf", "scale=96:96:flags=lanczos,format=rgba,pad=128:128:16:16:color=0x00000000", join(OUT, "store-icon.png")]);

rmSync(TMP, { recursive: true, force: true });
console.log("Wrote store/screenshot-1..5.png, promo-small.png, promo-marquee.png and store-icon.png");
