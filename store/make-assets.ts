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

// --- Hand-drawn look: paper, a handwriting font, ink arrows and frames, marker scribbles. ---
const INK = "#2b2a28";
const PAPER = "#fbf8f1";
const GROUP_COLORS = ["#1a73e8", "#188038", "#fa903e", "#d93025", "#a142f4"];

/** Seeded random so every run draws the same wobbles. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Pt = [number, number];
/** A smooth path through points, each nudged a little, like a pen line. */
function wobble(points: Pt[], seed: number, jitter = 2.2): string {
  const r = rng(seed);
  const p = points.map(([x, y]) => [x + (r() - 0.5) * jitter, y + (r() - 0.5) * jitter] as Pt);
  let d = `M${p[0]![0].toFixed(1)},${p[0]![1].toFixed(1)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i]![0] + p[i + 1]![0]) / 2;
    const my = (p[i]![1] + p[i + 1]![1]) / 2;
    d += ` Q${p[i]![0].toFixed(1)},${p[i]![1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const last = p[p.length - 1]!;
  return d + ` L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
}
/** Points along a curve from a to b, bowed sideways by `bend`. */
function curve(a: Pt, b: Pt, bend: number, n = 9): Pt[] {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const [nx, ny] = [-dy, dx];
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const s = Math.sin(Math.PI * t) * bend;
    return [a[0] + dx * t + nx * s, a[1] + dy * t + ny * s] as Pt;
  });
}
function arrow(a: Pt, b: Pt, bend: number, seed: number): string {
  const pts = curve(a, b, bend);
  const [px, py] = pts[pts.length - 2]!;
  const ang = Math.atan2(b[1] - py, b[0] - px);
  const head = (da: number) => [b, [b[0] - 18 * Math.cos(ang + da), b[1] - 18 * Math.sin(ang + da)] as Pt];
  const line = (d: string, w = 3) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  return line(wobble(pts, seed)) + line(wobble(head(0.45), seed + 1, 1)) + line(wobble(head(-0.45), seed + 2, 1));
}
/** A sketched rectangle: four slightly wobbly strokes that overshoot at the corners. */
function inkFrame(x: number, y: number, w: number, h: number, seed: number): string {
  const o = 7; // gap between image and line
  const e = 9; // overshoot past the corners
  const [l, t, r, btm] = [x - o, y - o, x + w + o, y + h + o];
  const sides: Pt[][] = [
    [[l - e, t + 1], [(l + r) / 2, t - 1.5], [r + e, t]],
    [[r, t - e], [r + 1.5, (t + btm) / 2], [r - 1, btm + e]],
    [[r + e, btm], [(l + r) / 2, btm + 1.5], [l - e, btm - 1]],
    [[l + 1, btm + e], [l - 1.5, (t + btm) / 2], [l, t - e]],
  ];
  return sides
    .map((pts, i) => `<path d="${wobble(pts, seed + i, 2)}" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>`)
    .join("");
}
/** Five short marker strokes in the tab-group colours. */
function scribbles(x: number, y: number, len: number, gap: number, width: number, seed: number): string {
  return GROUP_COLORS.map((c, i) => {
    const x0 = x + i * (len + gap);
    const r = rng(seed + i);
    const pts: Pt[] = [[x0, y + r() * 4], [x0 + len * 0.5, y - 2 + r() * 4], [x0 + len, y + r() * 4]];
    return `<path d="${wobble(pts, seed + i, 2)}" fill="none" stroke="${c}" stroke-width="${width}" stroke-linecap="round" opacity="0.85"/>`;
  }).join("");
}
const img = (f: string, x: number, y: number, w: number, h: number) =>
  `<img src="${b64(f)}" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;object-fit:cover;object-position:top left">`;
const text = (t: string, x: number, y: number, size: number, extra = "") =>
  `<div style="position:absolute;left:${x}px;top:${y}px;font-size:${size}px;line-height:1.05;${extra}">${t}</div>`;

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage();
async function render(w: number, h: number, body: string, svg: string, path: string) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=block" rel="stylesheet">
    <style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${PAPER};color:${INK};font-family:Caveat,cursive}
    body{position:relative}</style>${body}
    <svg width="${w}" height="${h}" style="position:absolute;inset:0">${svg}</svg>`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path });
}

// Full-window frames are 1920×860; shown at 1100 wide (×0.573), top-left at (90, 236).
const FW = 1100;
const FH = Math.round((860 * FW) / 1920);
const [FX, FY] = [90, 236];

await render(1280, 800,
  text("sorts your tabs into groups", 90, 48, 64, "font-weight:700") + text("…only the ones it's sure about", 110, 124, 40) +
    text("and tells you about the rest", 860, 92, 34) + img(shots.sorted, FX, FY, FW, FH),
  arrow([470, 180], [400, FY - 16], 0.25, 11) + arrow([1010, 136], [930, FY - 16], 0.12, 21) + inkFrame(FX, FY, FW, FH, 31),
  join(OUT, "screenshot-1.png"));

// The popup crop is 520×896; shown 640 tall.
const PH = 640;
const PW = Math.round((520 * PH) / 896);
const [PX, PY] = [760, 80];
await render(1280, 800,
  text("not sure?", 90, 210, 72, "font-weight:700") + text("it leaves the tab alone,<br>and tells you why", 96, 300, 46) +
    text("no account, no api key.<br>just press sort.", 96, 560, 34, "opacity:.8") + img(shots.popup, PX, PY, PW, PH),
  arrow([560, 340], [PX - 14, PY + 190], -0.12, 41) + inkFrame(PX, PY, PW, PH, 51),
  join(OUT, "screenshot-2.png"));

await render(1280, 800,
  text("before: thirty tabs, no order", 90, 60, 64, "font-weight:700") + img(shots.messy, FX, FY, FW, FH),
  arrow([700, 112], [540, FY - 16], 0.22, 61) + inkFrame(FX, FY, FW, FH, 71),
  join(OUT, "screenshot-3.png"));

await render(1280, 800,
  text("undo puts every tab back", 90, 48, 64, "font-weight:700") + text("even the groups you made yourself", 110, 124, 40) +
    img(shots.undone, FX, FY, FW, FH),
  arrow([520, 180], [450, FY - 16], 0.25, 81) + inkFrame(FX, FY, FW, FH, 91),
  join(OUT, "screenshot-4.png"));

// The Options crop is 800×1000; shown 640 tall.
const OH = 640;
const OW = Math.round((800 * OH) / 1000);
const [OX, OY] = [660, 80];
await render(1280, 800,
  text("you write the groups.", 90, 230, 60, "font-weight:700") + text("and you can see exactly<br>what gets sent", 96, 310, 44) +
    img(opt, OX, OY, OW, OH),
  arrow([520, 400], [OX - 18, OY + 150], -0.15, 101) + inkFrame(OX, OY, OW, OH, 111),
  join(OUT, "screenshot-5.png"));

await render(440, 280,
  text("tab-triage", 40, 62, 84, "font-weight:700") + text("sorts your tabs, only when it's sure", 44, 200, 30),
  scribbles(46, 170, 50, 14, 9, 121),
  join(OUT, "promo-small.png"));

const MH = 470;
const MW = Math.round((520 * MH) / 896);
await render(1400, 560,
  text("tab-triage", 100, 150, 130, "font-weight:700") + text("sorts your tabs into groups,<br>only when it's sure. undo anytime.", 106, 340, 44) +
    img(shots.popup, 1400 - 120 - MW, 45, MW, MH),
  scribbles(108, 305, 78, 18, 13, 131) + inkFrame(1400 - 120 - MW, 45, MW, MH, 141),
  join(OUT, "promo-marquee.png"));
await browser.close();

// Store icon: the 128px icon's artwork at 96×96, centred on a transparent 128×128 canvas
// (Chrome Web Store icon guidelines). Needs dist/ from `npm run package`.
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", "dist/icons/icon128.png", "-vf", "scale=96:96:flags=lanczos,format=rgba,pad=128:128:16:16:color=0x00000000", join(OUT, "store-icon.png")]);

rmSync(TMP, { recursive: true, force: true });
console.log("Wrote store/screenshot-1..5.png, promo-small.png, promo-marquee.png and store-icon.png");
