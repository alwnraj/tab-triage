/** Cut, caption and encode the raw screen capture. Separate from run.ts so it can be tested on a synthetic clip. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import type { SortReport } from "../src/core/sort.js";
import { chromiumPath } from "../scripts/browser.js";
import { caption, endCard, titleCard } from "./cards.js";

const OUT = "demo/out";
function run(cmd: string, a: string[]) {
  return execFileSync(cmd, a, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
}

export interface RunLog {
  events: Record<string, number>;
  bounds: { left: number; top: number; width: number; height: number };
  screen: { w: number };
}

export async function edit(raw: string, log: RunLog, report: SortReport, opts: { mock: boolean; keepRaw?: boolean }) {
  // Either signal marks the run as a rehearsal; the committed assets need both to say "real".
  const MOCK = opts.mock || report.mock;
  if (!MOCK && !/^(typesafe|hosted):/.test(report.classifierId)) throw new Error(`Refusing to write the published demo from classifier ${report.classifierId}`);
  const PREFIX = MOCK ? "rehearsal-" : "";
  console.log("[demo] editing…");
  const [rw] = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", raw]).trim().split(",").map(Number);
  const k = rw! / log.screen.w; // physical pixels per CSS pixel
  const even = (n: number) => Math.round(n / 2) * 2;
  const b = log.bounds;
  const crop = `crop=${even(b.width * k)}:${even(b.height * k)}:${even(b.left * k)}:${even(b.top * k)},scale=1920:1080:flags=lanczos,setsar=1`;
  const e = log.events;
  const mode = report.mock ? "MOCK classifier (rehearsal)" : `real classifier: TypeSafe ${report.classifierId.replace(/^(typesafe|hosted):/, "")}`;

  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage();
  const tmp = join(OUT, "tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  // Captioned segments; the classifying wait is sped up and labelled so.
  const classify = e.sorted! - e.sortClick!;
  const speed = classify > 3 ? classify / 2.5 : 1;
  const segs: Array<{ from: number; to: number; speed: number; text: string; sub?: string }> = [
    { from: e.messy!, to: e.popup!, speed: 1, text: `${report.results.length} open tabs. No order.`, sub: mode },
    { from: e.popup!, to: e.sortClick! + 0.3, speed: 1, text: "Open tab-triage from the toolbar", sub: "one request per tab: Choice + companion Noul" },
    { from: e.sortClick! + 0.3, to: e.sorted!, speed, text: speed > 1 ? `Classifying… (sped up ${speed.toFixed(1)}×)` : "Classifying…", sub: mode },
    { from: e.sorted!, to: e.leftAlone!, speed: 1, text: "Confident tabs hop into colored groups", sub: "threshold 0.8 on both the Choice and the Noul" },
    { from: e.leftAlone!, to: e.collapsed!, speed: 1, text: "Not sure? Left alone, with its probability", sub: "ungrouped beats wrongly grouped" },
    { from: e.collapsed!, to: e.undone!, speed: 1, text: "Collapse the groups", sub: mode },
    { from: e.undone!, to: e.end!, speed: 1, text: "Undo puts every tab back", sub: "order and groups restored from a snapshot" },
  ];
  const files: string[] = [];
  await titleCard(page, join(tmp, "title.png"), mode);
  run("ffmpeg", ["-y", "-loop", "1", "-t", "3", "-i", join(tmp, "title.png"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", join(tmp, "s00.mp4")]);
  files.push("s00.mp4");
  for (const [i, s] of segs.entries()) {
    const cap = join(tmp, `c${i}.png`);
    await caption(page, cap, s.text, s.sub, MOCK);
    const f = `s${String(i + 1).padStart(2, "0")}.mp4`;
    run("ffmpeg", [
      "-y", "-ss", s.from.toFixed(3), "-to", s.to.toFixed(3), "-i", raw, "-i", cap,
      "-filter_complex", `[0:v]${crop},setpts=(PTS-STARTPTS)/${s.speed.toFixed(4)},fps=30[v];[v][1:v]overlay=0:0,format=yuv420p[o]`,
      "-map", "[o]", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "medium", join(tmp, f),
    ]);
    files.push(f);
  }
  const m = report.metrics;
  const cost = m.estCostUsd === 0 ? "$0" : m.estCostUsd < 0.001 ? `$${m.estCostUsd.toFixed(5)}` : `$${m.estCostUsd.toFixed(4)}`;
  await endCard(page, join(tmp, "end.png"), {
    latencyS: `${(m.latencyMs / 1000).toFixed(1)} s`,
    cost,
    sortedPct: `${Math.round(m.sortedPct * 100)}%`,
    grouped: m.movedTabs,
    eligible: m.eligible,
    calls: m.apiCalls,
    classifier: report.classifierId,
    mock: report.mock,
  });
  run("ffmpeg", ["-y", "-loop", "1", "-t", "5", "-i", join(tmp, "end.png"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", join(tmp, "s99.mp4")]);
  files.push("s99.mp4");

  // Frame check: the tab strip must be in frame. Saved for a human (and Claude) to look at.
  run("ffmpeg", ["-y", "-ss", (e.sorted! + 1.5).toFixed(2), "-i", raw, "-frames:v", "1", "-vf", crop, join(OUT, `${PREFIX}frame-check.png`)]);
  await browser.close();

  writeFileSync(join(tmp, "list.txt"), files.map((f) => `file '${f}'`).join("\n") + "\n");
  const mp4 = join(OUT, `${PREFIX}tab-triage-demo.mp4`);
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", join(tmp, "list.txt"), "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
  const dur = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).trim());

  // GIF (< 10 MB) and poster frame. Real runs write the committed assets; rehearsals stay in out/.
  const gif = MOCK ? join(OUT, "rehearsal-demo.gif") : "demo/demo.gif";
  const poster = MOCK ? join(OUT, "rehearsal-poster.png") : "demo/poster.png";
  const posterT = 3 + (segs[0]!.to - segs[0]!.from) + (segs[1]!.to - segs[1]!.from) + (segs[2]!.to - segs[2]!.from) / segs[2]!.speed + 1.5;
  run("ffmpeg", ["-y", "-ss", posterT.toFixed(2), "-i", mp4, "-frames:v", "1", "-vf", "scale=1280:-2", poster]);
  for (const [w, fps] of [[960, 10], [800, 8], [640, 8]] as const) {
    run("ffmpeg", ["-y", "-i", mp4, "-vf", `fps=${fps},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, gif]);
    if (statSync(gif).size < 10 * 1024 * 1024) break;
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`[demo] ${mp4} (${dur.toFixed(1)} s${dur < 30 || dur > 45 ? " ⚠ outside 30–45 s" : ""})`);
  console.log(`[demo] ${gif} (${(statSync(gif).size / 1e6).toFixed(1)} MB), ${poster}`);
  console.log(`[demo] check ${join(OUT, `${PREFIX}frame-check.png`)} to confirm the tab strip is visible and nothing else is in frame.`);
  if (existsSync(raw) && !opts.keepRaw) console.log("[demo] raw capture will be deleted");
}
