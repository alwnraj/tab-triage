/**
 * npm run eval:label [-- --from path/to/tabs-export.json] [--browser "Google Chrome"]
 *
 * Writes eval/labeled.json: one row per open tab with hostname, a 120-char title and
 * `"label": null` for you to fill in with a group id or "none".
 *
 * Sources:
 *  - --from: the file from Options → "Export open tabs for labelling" (works everywhere).
 *  - default on macOS: reads the open tabs of a running Chromium-family browser via
 *    AppleScript (read-only; macOS will ask you to allow Terminal to control it). It never
 *    opens or reads the browser profile on disk.
 *
 * Only hostname + title leave this script; URLs are reduced immediately and never written.
 * eval/labeled.json is gitignored because it holds your real titles.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isLocalHost, safeTitle, truncateTitle, webHostname } from "../src/core/privacy.js";
import { DEFAULT_GROUPS } from "../src/settings.js";

const { values: args } = parseArgs({ options: { from: { type: "string" }, browser: { type: "string", default: "Google Chrome" }, force: { type: "boolean", default: false } } });
const OUT = "eval/labeled.json";

if (existsSync(OUT) && !args.force) {
  console.error(`${OUT} already exists (maybe with your labels). Pass --force to overwrite.`);
  process.exit(1);
}

let raw: Array<{ url?: string; site?: string; title: string }>;
if (args.from) {
  raw = (JSON.parse(readFileSync(args.from, "utf8")) as { tabs: Array<{ site: string; title: string }> }).tabs;
} else if (process.platform === "darwin") {
  const app = args.browser!;
  if (!/^[\w .-]+$/.test(app)) throw new Error("bad --browser name");
  // Tab-separated url \t title per line. Read-only AppleScript.
  const script = `
    set out to ""
    tell application "${app}"
      repeat with w in windows
        if mode of w is not "incognito" then
          repeat with t in tabs of w
            set out to out & (URL of t) & tab & (title of t) & linefeed
          end repeat
        end if
      end repeat
    end tell
    return out`;
  const txt = execFileSync("osascript", ["-e", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  raw = txt
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [url, ...rest] = line.split("\t");
      return { url, title: rest.join("\t") };
    });
} else {
  console.error("On this platform, export tabs from the extension's Options page and pass --from <file>.");
  process.exit(1);
}

const seen = new Set<string>();
const tabs: Array<{ site: string; title: string; label: null }> = [];
for (const r of raw) {
  const site = r.site ?? webHostname(r.url);
  if (!site || isLocalHost(site)) continue;
  const title = safeTitle(truncateTitle(r.title), site);
  const k = site + "\n" + title;
  if (seen.has(k)) continue;
  seen.add(k);
  tabs.push({ site, title, label: null });
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _instructions: `Set each "label" to one of: ${DEFAULT_GROUPS.map((g) => g.id).join(", ")}, or "none" if no group should hold it. Leave null to skip a row. Delete rows you don't want evaluated. Do not commit this file.`,
      groups: DEFAULT_GROUPS,
      tabs,
    },
    null,
    1,
  ) + "\n",
);
console.log(`Wrote ${tabs.length} tabs to ${OUT} (hostname + title only). Fill in the labels, then run \`npm run eval\`.`);
