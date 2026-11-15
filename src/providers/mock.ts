import type { ModelGroup, Order, RawAnswer, TabInput } from "../core/types.js";
import type { Classifier } from "./classifier.js";

const STOP = new Set(
  "a an and are as at be by for from in into is it of on or that the this to with about any page pages site sites tab tabs".split(" "),
);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Keyword-overlap classifier for tests and demo rehearsal. NOT a model:
 * its "probabilities" are a softmax over keyword hits and mean nothing.
 * Every run that uses it is labelled MOCK in the UI, logs and video captions.
 */
export class MockClassifier implements Classifier {
  readonly id = "mock";
  readonly model = "mock";
  readonly isMock = true;
  /** Optional simulated latency per call. */
  constructor(private readonly delayMs = 0) {}

  async classify(input: TabInput, groups: readonly ModelGroup[], order: Order): Promise<RawAnswer> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const text = new Set(words(`${input.site.replace(/\./g, " ")} ${input.title}`));
    const hits = groups.map((g) => words(g.description + " " + g.key.slice(2)).filter((w) => text.has(w)).length);
    // Mimic the documented first-option lean: whichever option is listed first gets a small bonus,
    // so reversing the order can genuinely change the top answer and exercise the re-ask path.
    const first = (order === "fwd" ? groups[0] : groups[groups.length - 1])?.key;
    const exps = groups.map((g, i) => Math.exp(2.2 * hits[i]! + (g.key === first ? 0.35 : 0)));
    const z = exps.reduce((a, b) => a + b, 0) || 1;
    const probabilities: Record<string, number> = {};
    groups.forEach((g, i) => (probabilities[g.key] = Math.round((exps[i]! / z) * 1000) / 1000));
    let choice = groups[0]?.key ?? "";
    for (const g of groups) if ((probabilities[g.key] ?? 0) > (probabilities[choice] ?? 0)) choice = g.key;
    const maxHits = Math.max(0, ...hits);
    const noul = maxHits === 0 ? 0.1 : maxHits === 1 ? 0.75 : 0.95;
    return { choice, probabilities, noul, inputTokens: 0, model: "mock" };
  }
}
