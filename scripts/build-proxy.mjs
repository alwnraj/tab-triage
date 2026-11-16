// Builds the hosted service in Vercel's Build Output API format (.vercel/output):
//   functions/api/classify.func  the Edge Function (proxy/edge.ts, bundled)
//   static/                      the landing and privacy pages (site/)
// Vercel runs this as the project's build command (see vercel.json). Locally:
//   node scripts/build-proxy.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = ".vercel/output";
rmSync(out, { recursive: true, force: true });
const fn = `${out}/functions/api/classify.func`;
mkdirSync(fn, { recursive: true });

await build({
  entryPoints: ["proxy/edge.ts"],
  outfile: `${fn}/index.js`,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  legalComments: "none",
  logLevel: "info",
});
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({ runtime: "edge", entrypoint: "index.js" }, null, 2));

cpSync("site", `${out}/static`, { recursive: true });
// The extension download for the install page: a release build with the pinned id (scripts/package.mjs).
execFileSync("node", ["scripts/package.mjs", "--download-to", `${out}/static/download`], { stdio: "inherit" });
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(`${out}/static/download/version.json`, JSON.stringify({ version }) + "\n");
writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/(.*)$", headers: { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }, continue: true },
        { src: "^/privacy$", dest: "/privacy.html" },
        { src: "^/install$", dest: "/install.html" },
        {
          src: "^/download/tab-triage\\.zip$",
          headers: { "content-disposition": 'attachment; filename="tab-triage.zip"', "cache-control": "public, max-age=300" },
          continue: true,
        },
        { handle: "filesystem" },
      ],
    },
    null,
    2,
  ),
);
console.log(`Built ${out}`);
