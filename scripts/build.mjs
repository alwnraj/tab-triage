// Builds dist/ (load it with chrome://extensions → Load unpacked).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const out = "dist";
// The hosted service the extension calls. Override for a local or staging server:
//   TAB_TRIAGE_SERVICE=http://localhost:8787 npm run build
const SERVICE = new URL(process.env.TAB_TRIAGE_SERVICE ?? "https://tab-triage-pi.vercel.app").origin;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/icons`, { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    popup: "src/popup/popup.ts",
    options: "src/options/options.ts",
  },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  define: { __SERVICE_URL__: JSON.stringify(SERVICE) },
});

for (const [from, to] of [
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  ["src/options/options.html", "options.html"],
  ["src/options/options.css", "options.css"],
  ["src/ui/common.css", "common.css"],
]) cpSync(from, `${out}/${to}`);

// The manifest's only host permission is the service the build points at.
const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
manifest.host_permissions = [`${SERVICE}/*`];
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Service: ${SERVICE}`);

// --- Icons: drawn in code so the repo has no binary assets to maintain. ---
// A rounded square with three coloured "tab group" bars of decreasing length.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const bars = [
    [0.22, 0.86, [26, 115, 232]],
    [0.45, 0.7, [24, 128, 56]],
    [0.68, 0.55, [250, 144, 62]],
  ];
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // rounded-rect mask
      const dx = Math.max(r - x - 0.5, x + 0.5 - (size - r), 0);
      const dy = Math.max(r - y - 0.5, y + 0.5 - (size - r), 0);
      const inside = Math.hypot(dx, dy) <= r;
      let col = [32, 33, 36];
      const fy = (y + 0.5) / size;
      const fx = (x + 0.5) / size;
      for (const [top, len, c] of bars) if (fy >= top && fy < top + 0.14 && fx >= 0.16 && fx < 0.16 + len * 0.7) col = c;
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(px)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const s of [16, 32, 48, 128]) writeFileSync(`${out}/icons/icon${s}.png`, png(s));
console.log("Built dist/ — load it via chrome://extensions → Developer mode → Load unpacked.");
