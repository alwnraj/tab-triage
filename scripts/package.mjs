// npm run package: builds the store release and zips it for the Chrome Web Store.
//   release/tab-triage-<version>.zip   (gitignored; upload it in the developer dashboard)
// Refuses to package anything that could ship by mistake: a non-HTTPS or placeholder
// service, extra host permissions, or a version mismatch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";

const fail = (msg) => {
  console.error(`package: ${msg}`);
  process.exit(1);
};

execFileSync("node", ["scripts/build.mjs"], { stdio: "inherit", env: { ...process.env, TAB_TRIAGE_RELEASE: "1" } });

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== pkg.version) fail(`manifest ${manifest.version} ≠ package.json ${pkg.version}`);
const hosts = manifest.host_permissions ?? [];
if (hosts.length !== 1) fail(`expected exactly one host permission, got ${JSON.stringify(hosts)}`);
const host = new URL(hosts[0].replace(/\*$/, ""));
if (host.protocol !== "https:" || /\.invalid$|^localhost$|^127\./.test(host.hostname)) fail(`service host ${host.origin} isn't a real HTTPS service`);
const perms = [...(manifest.permissions ?? [])].sort().join(",");
if (perms !== "storage,tabGroups,tabs") fail(`unexpected permissions: ${perms}`);
if (manifest.description.length > 132) fail(`description is ${manifest.description.length} chars (store limit 132)`);
for (const f of ["background.js", "popup.html", "options.html", "icons/icon128.png"]) statSync(`dist/${f}`);

mkdirSync("release", { recursive: true });
const zip = `release/tab-triage-${manifest.version}.zip`;
rmSync(zip, { force: true });
execFileSync("zip", ["-qrX", `../${zip}`, "."], { cwd: "dist" });
const buf = readFileSync(zip);
console.log(`\n${zip}  ${(buf.length / 1024).toFixed(0)} KB  sha256 ${createHash("sha256").update(buf).digest("hex").slice(0, 16)}…`);
console.log(`service: ${host.origin}  permissions: ${perms}  version: ${manifest.version}`);
