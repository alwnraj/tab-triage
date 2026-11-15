/**
 * npm run eval [-- --data eval/labeled.json] [--synthetic] [--mock] [--max-calls 100]
 *
 * One pass over the API collects BOTH option orders for every model-routed tab;
 * the threshold sweep then happens in code, so trying 10 thresholds costs nothing extra.
 * Aggregates → eval/results/<name>.{csv,svg,json} (committable).
 * Per-row answers → eval/out/ (gitignored; contains titles).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MODEL_ID, PRICE_USD_PER_INPUT_TOKEN } from "../src/core/config.js";
import { matchDomain, toModelGroups } from "../src/core/groups.js";
import { safeTitle, truncateTitle } from "../src/core/privacy.js";
import type { GroupDef, Order, RawAnswer } from "../src/core/types.js";
import { type Classifier, ClassifierError } from "../src/providers/classifier.js";
import { MockClassifier } from "../src/providers/mock.js";
import { TypeSafeClassifier } from "../src/providers/typesafe.js";
import { DEFAULT_GROUPS } from "../src/settings.js";
import { chartSvg } from "./chart.js";
import { calibrationPairs, type EvalRow, orderStats, reliability, sweep } from "./metrics.js";

const { values: args } = parseArgs({
  options: {
    data: { type: "string" },
    synthetic: { type: "boolean", default: false },
    mock: { type: "boolean", default: false },
    "max-calls": { type: "string", default: "100" },
    groups: { type: "string" },
  },
});

const synthetic = args.synthetic === true;
const dataPath = args.data ?? (synthetic ? "eval/synthetic.dev.json" : "eval/labeled.json");
const maxCalls = Number(args["max-calls"]);
const THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

interface DataFile {
  groups?: GroupDef[] | string;
  tabs: Array<{ site: string; title: string; label: string | null }>;
}

let data: DataFile;
try {
  data = JSON.parse(readFileSync(dataPath, "utf8"));
} catch {
  console.error(`Can't read ${dataPath}. Run \`npm run eval:label\` first (or pass --synthetic for the dev set).`);
  process.exit(1);
}
const groups: GroupDef[] = args.groups
  ? JSON.parse(readFileSync(args.groups, "utf8"))
  : Array.isArray(data.groups)
    ? data.groups
    : DEFAULT_GROUPS;
const ids = new Set([...groups.map((g) => g.id), "none"]);
const labelled = data.tabs.filter((t) => t.label !== null && t.label !== undefined && t.label !== "");
const unknown = labelled.filter((t) => !ids.has(t.label!));
if (unknown.length) {
  console.error(`Unknown labels: ${[...new Set(unknown.map((t) => t.label))].join(", ")}. Use a group id (${[...ids].join(", ")}).`);
  process.exit(1);
}
if (!labelled.length) {
  console.error(`No labelled rows in ${dataPath}: fill in "label" for each tab first.`);
  process.exit(1);
}

const modelGroups = toModelGroups(groups);
const rows: EvalRow[] = labelled.map((t) => {
  const site = t.site.toLowerCase();
  const title = safeTitle(truncateTitle(t.title), site);
  const dom = matchDomain(site, groups);
  return dom
    ? { site, title, label: t.label!, source: "domain", domainGroup: dom.id }
    : { site, title, label: t.label!, source: "model" };
});
const modelRows = rows.filter((r) => r.source === "model");

// --- Classifier and hard call budget ---
const mock = args.mock === true;
let attempts = 0;
let classifier: Classifier;
if (mock) classifier = new MockClassifier();
else {
  const key = process.env.TYPESAFE_API_KEY ?? "";
  if (!key) {
    console.error("TYPESAFE_API_KEY is not set. Export it in your shell (never commit it), or use --mock for a pipeline check.");
    process.exit(1);
  }
  const worstCase = modelRows.length * 2 * 3; // 2 orders × up to 3 attempts
  const planned = modelRows.length * 2;
  if (planned > maxCalls) {
    console.error(
      `This run needs ${planned} requests (${modelRows.length} tabs × 2 orders; up to ${worstCase} attempts with retries), over --max-calls ${maxCalls}. ` +
        `Re-run with --max-calls ${planned} if that's OK.`,
    );
    process.exit(1);
  }
  classifier = new TypeSafeClassifier({
    apiKey: key,
    onAttempt: () => {
      if (++attempts > maxCalls) throw new ClassifierError("budget");
    },
  });
}

const banner = synthetic
  ? "SYNTHETIC DEV DATA — NOT A REAL RESULT" + (mock ? " (MOCK CLASSIFIER)" : "")
  : mock
    ? "MOCK CLASSIFIER — NOT A REAL RESULT"
    : null;

console.log(`${banner ? `[${banner}] ` : ""}${rows.length} labelled tabs (${modelRows.length} via model, ${rows.length - modelRows.length} via domain table), classifier ${classifier.id}`);

let inputTokens = 0;
const t0 = Date.now();
const latencies: number[] = [];
async function ask(r: EvalRow, order: Order): Promise<RawAnswer> {
  const s = Date.now();
  const a = await classifier.classify({ site: r.site, title: r.title }, modelGroups, order);
  latencies.push(Date.now() - s);
  inputTokens += a.inputTokens;
  return a;
}
let i = 0;
const CONC = 4;
try {
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (i < modelRows.length) {
        const r = modelRows[i++]!;
        r.fwd = await ask(r, "fwd");
        r.rev = await ask(r, "rev");
        process.stdout.write(".");
      }
    }),
  );
} catch (e) {
  console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
process.stdout.write("\n");

const points = sweep(rows, modelGroups, THRESHOLDS);
const pairs = calibrationPairs(rows, modelGroups);
const choiceRel = reliability(pairs.choice);
const noulRel = reliability(pairs.noul);
const ord = orderStats(modelRows, modelGroups);
const domainRows = rows.filter((r) => r.source === "domain");
const domainAcc = domainRows.length ? domainRows.filter((r) => r.domainGroup === r.label).length / domainRows.length : null;
const sorted = [...latencies].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;

const name = synthetic ? `synthetic${mock ? "-mock" : ""}` : mock ? "labeled-mock" : "labeled";
mkdirSync("eval/results", { recursive: true });
mkdirSync("eval/out", { recursive: true });

const csv = [
  ...(banner ? [`# ${banner}`] : []),
  `# classifier=${classifier.id} rows=${rows.length} model_rows=${modelRows.length} domain_rows=${domainRows.length} generated=${new Date().toISOString()}`,
  "threshold,coverage,accuracy,grouped,correct,eligible,false_groupings",
  ...points.map((p) => [p.threshold, p.coverage.toFixed(4), p.accuracy === null ? "" : p.accuracy.toFixed(4), p.grouped, p.correct, p.eligible, p.falseGroupings].join(",")),
  "",
  "kind,bin_lo,bin_hi,n,mean_predicted,observed",
  ...choiceRel.bins.map((b) => ["choice", b.lo.toFixed(1), b.hi.toFixed(1), b.n, b.n ? b.meanPredicted.toFixed(4) : "", b.n ? b.observed.toFixed(4) : ""].join(",")),
  ...noulRel.bins.map((b) => ["noul", b.lo.toFixed(1), b.hi.toFixed(1), b.n, b.n ? b.meanPredicted.toFixed(4) : "", b.n ? b.observed.toFixed(4) : ""].join(",")),
].join("\n");
writeFileSync(`eval/results/${name}.csv`, csv + "\n");
writeFileSync(
  `eval/results/${name}.svg`,
  chartSvg(points, choiceRel.bins, noulRel.bins, `tab-triage eval — ${classifier.id} — ${rows.length} tabs`, banner),
);
const summary = {
  banner,
  classifier: classifier.id,
  model: mock ? "mock" : MODEL_ID,
  rows: rows.length,
  modelRows: modelRows.length,
  domainRows: domainRows.length,
  domainAccuracy: domainAcc,
  eceChoice: choiceRel.ece,
  eceNoul: noulRel.ece,
  order: ord,
  inputTokens,
  estCostUsd: inputTokens * PRICE_USD_PER_INPUT_TOKEN,
  apiAttempts: attempts,
  medianLatencyMs: p50,
  wallMs: Date.now() - t0,
  points,
};
writeFileSync(`eval/results/${name}.json`, JSON.stringify(summary, null, 2) + "\n");
writeFileSync(`eval/out/${name}.rows.json`, JSON.stringify(rows, null, 1)); // contains titles: gitignored

const fmt = (x: number | null) => (x === null ? "  -  " : `${(x * 100).toFixed(1).padStart(5)}%`);
console.log(`\n threshold  coverage  accuracy  (n grouped)`);
for (const p of points) console.log(`   ${p.threshold.toFixed(2)}     ${fmt(p.coverage)}    ${fmt(p.accuracy)}   (${p.grouped})`);
console.log(`\nECE Choice ${choiceRel.ece.toFixed(3)} · ECE Noul ${noulRel.ece.toFixed(3)} · domain-table accuracy ${fmt(domainAcc)} (n=${domainRows.length})`);
console.log(
  `Order check: ${ord.pairs} pairs, identical distributions ${fmt(ord.identicalRate)}, top-choice flips ${fmt(ord.choiceFlipRate)}` +
    (ord.identicalRate === 1 ? "  ⚠ reversing never changed anything: the server may not honour key order" : ""),
);
console.log(`Tokens ${inputTokens} · est. $${(inputTokens * PRICE_USD_PER_INPUT_TOKEN).toFixed(5)} · median latency ${p50} ms`);
console.log(`Wrote eval/results/${name}.{csv,svg,json}${banner ? `  [${banner}]` : ""}`);
