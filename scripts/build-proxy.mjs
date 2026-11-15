// Builds the hosted service in Vercel's Build Output API format (.vercel/output):
//   functions/api/classify.func  the Edge Function (proxy/edge.ts, bundled)
//   static/                      the landing and privacy pages (site/)
// Vercel runs this as the project's build command (see vercel.json). Locally:
//   node scripts/build-proxy.mjs
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

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
writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/privacy", dest: "/privacy.html" },
        { handle: "filesystem" },
        { src: "/api/classify", dest: "/api/classify" },
      ],
    },
    null,
    2,
  ),
);
console.log(`Built ${out}`);
