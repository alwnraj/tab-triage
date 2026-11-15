// A minimal, dependency-free zip writer (deflate), so packaging works anywhere Node
// runs, including Vercel's build image, which may have no `zip` command.
// Deterministic: fixed timestamps and sorted entries give byte-identical zips for identical input.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

/**
 * Zip a directory's files into one Buffer.
 * @param {string} dir directory whose contents become the zip root
 * @param {Record<string, Buffer|string>} [overrides] relative path → replacement contents
 * @param {string} [prefix] folder name to put everything under inside the zip
 */
export function zipDir(dir, overrides = {}, prefix = "") {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1; // 2026-01-01
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of walk(dir)) {
    const rel = relative(dir, file).split(sep).join("/");
    const name = Buffer.from(prefix ? `${prefix}/${rel}` : rel);
    const data = Buffer.from(overrides[rel] ?? readFileSync(file));
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(8, 8); // deflate
    h.writeUInt16LE(DOS_TIME, 10);
    h.writeUInt16LE(DOS_DATE, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    local.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIME, 12);
    c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(0o100644 * 0x10000, 38); // regular file, rw-r--r-- (multiply: << would go negative)
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
