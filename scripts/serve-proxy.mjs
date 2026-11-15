// Runs the built hosted service locally (after `node scripts/build-proxy.mjs`), for
// testing the extension against it without deploying:
//   node --env-file-if-exists=.env scripts/serve-proxy.mjs        # http://localhost:8787
//   TAB_TRIAGE_SERVICE=http://localhost:8787 npm run build          # point the extension at it
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const out = ".vercel/output";
const { default: classify } = await import(new URL(`../${out}/functions/api/classify.func/index.js`, import.meta.url).href);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/api/classify") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
    });
    const r = await classify(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const page = url.pathname === "/" ? "index.html" : ["/privacy", "/install"].includes(url.pathname) ? `${url.pathname.slice(1)}.html` : url.pathname.slice(1);
  const file = normalize(join(out, "static", page));
  if (!file.startsWith(join(out, "static")) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
}).listen(PORT, () => console.log(`tab-triage service on http://localhost:${PORT} (key ${process.env.TYPESAFE_API_KEY ? "set" : "NOT set"})`));
