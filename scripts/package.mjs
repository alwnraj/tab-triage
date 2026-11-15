// npm run package: builds the release and writes
//   release/tab-triage-<version>.zip           Chrome Web Store upload (no manifest "key")
//   release/tab-triage-<version>-download.zip  website download for "Load unpacked": manifest
//                                              "key" pins the extension id (scripts/download-key.json)
// `node scripts/package.mjs --download-to <dir>` writes only the download zip, as <dir>/tab-triage.zip
// (the Vercel build uses this to serve it from the site).
// Refuses to package anything that could ship by mistake: a non-HTTPS or placeholder
// service, extra permissions, or a version mismatch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { zipDir } from "./zip.mjs";

const { values: args } = parseArgs({ options: { "download-to": { type: "string" } } });
const fail = (msg) => {
  console.error(`package: ${msg}`);
  process.exit(1);
};

execFileSync("node", ["scripts/build.mjs"], { stdio: "inherit", env: { ...process.env, TAB_TRIAGE_RELEASE: "1" } });

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== pkg.version) fail(`manifest ${manifest.version} ≠ package.json ${pkg.version}`);
if ("key" in manifest) fail("dist/manifest.json must not contain a key (the store rejects it)");
const hosts = manifest.host_permissions ?? [];
if (hosts.length !== 1) fail(`expected exactly one host permission, got ${JSON.stringify(hosts)}`);
const host = new URL(hosts[0].replace(/\*$/, ""));
if (host.protocol !== "https:" || /\.invalid$|^localhost$|^127\./.test(host.hostname)) fail(`service host ${host.origin} isn't a real HTTPS service`);
const perms = [...(manifest.permissions ?? [])].sort().join(",");
if (perms !== "storage,tabGroups,tabs") fail(`unexpected permissions: ${perms}`);
if (manifest.description.length > 132) fail(`description is ${manifest.description.length} chars (store limit 132)`);
for (const f of ["background.js", "popup.html", "options.html", "icons/icon128.png"]) statSync(`dist/${f}`);

const { key, id } = JSON.parse(readFileSync("scripts/download-key.json", "utf8"));
const downloadManifest = JSON.stringify({ ...manifest, key }, null, 2) + "\n";
const download = zipDir("dist", { "manifest.json": downloadManifest }, "tab-triage");
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

if (args["download-to"]) {
  mkdirSync(args["download-to"], { recursive: true });
  writeFileSync(`${args["download-to"]}/tab-triage.zip`, download);
  console.log(`${args["download-to"]}/tab-triage.zip  ${(download.length / 1024).toFixed(0)} KB  id ${id}`);
} else {
  mkdirSync("release", { recursive: true });
  const store = zipDir("dist");
  const storeZip = `release/tab-triage-${manifest.version}.zip`;
  const dlZip = `release/tab-triage-${manifest.version}-download.zip`;
  writeFileSync(storeZip, store);
  writeFileSync(dlZip, download);
  console.log(`\n${storeZip}  ${(store.length / 1024).toFixed(0)} KB  sha256 ${sha(store)}…  (Chrome Web Store)`);
  console.log(`${dlZip}  ${(download.length / 1024).toFixed(0)} KB  sha256 ${sha(download)}…  (website download, id ${id})`);
  console.log(`service: ${host.origin}  permissions: ${perms}  version: ${manifest.version}`);
}
