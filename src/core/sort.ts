import type { BrowserAdapter } from "../browser/adapter.js";
import type { Classifier } from "../providers/classifier.js";
import type { AnswerCache } from "./cache.js";
import { PRICE_USD_PER_INPUT_TOKEN } from "./config.js";
import { classifyTabs, type RunMetrics, type TabResult } from "./pipeline.js";
import { applyPlan, buildPlan, restoreSnapshot, type Snapshot, takeSnapshot } from "./plan.js";
import { toTabInput } from "./privacy.js";
import type { GroupDef } from "./types.js";

export interface SortRequest {
  windowId: number;
  threshold: number;
  collapse: boolean;
  groups: readonly GroupDef[];
  blocklist: readonly string[];
}

export interface SortReport {
  ok: boolean;
  /** One plain-language line for the popup when ok is false or something was skipped. */
  message: string | null;
  classifierId: string;
  mock: boolean;
  results: TabResult[];
  metrics: RunMetrics & { latencyMs: number; estCostUsd: number; sortedPct: number; movedTabs: number; staleTabs: number };
  at: number;
}

export interface SortDeps {
  browser: BrowserAdapter;
  classifier: Classifier;
  cache: AnswerCache;
  /** Must persist durably BEFORE any tab moves (Undo depends on it). */
  saveSnapshot: (s: Snapshot) => Promise<void>;
  now?: () => number;
}

/**
 * The whole Sort run: snapshot → classify everything → (only if nothing failed)
 * re-validate → save snapshot → apply. A failed apply is rolled back.
 */
export async function runSort(req: SortRequest, d: SortDeps): Promise<SortReport> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const snap = await takeSnapshot(d.browser, req.windowId, t0);
  const tabs = await d.browser.tabsInWindow(req.windowId);
  await d.cache.prune().catch(() => 0);

  const out = await classifyTabs({
    tabs,
    groups: req.groups,
    blocklist: req.blocklist,
    threshold: req.threshold,
    classifier: d.classifier,
    cache: d.cache,
  });

  const finish = (ok: boolean, message: string | null, movedTabs: number, staleTabs: number): SortReport => {
    const latencyMs = now() - t0;
    const sortedPct = out.metrics.eligible ? movedTabs / out.metrics.eligible : 0;
    return {
      ok,
      message,
      classifierId: d.classifier.id,
      mock: d.classifier.isMock,
      results: out.results,
      metrics: {
        ...out.metrics,
        latencyMs,
        estCostUsd: out.metrics.inputTokens * PRICE_USD_PER_INPUT_TOKEN,
        sortedPct,
        movedTabs,
        staleTabs,
      },
      at: t0,
    };
  };

  if (out.error) return finish(false, `${out.error.message} No tabs were moved.`, 0, 0);

  // Tabs may have closed, navigated or moved windows while we waited. Only move
  // tabs that still look exactly like what we classified.
  const fresh = new Map((await d.browser.tabsInWindow(req.windowId)).map((t) => [t.id, t]));
  let staleTabs = 0;
  const choices: { tabId: number; groupId: string | null }[] = [];
  for (const r of out.results) {
    if (!r.decision?.groupId) continue;
    const t = fresh.get(r.tabId);
    const el = t ? toTabInput(t, req.blocklist) : null;
    const original = tabs.find((x) => x.id === r.tabId);
    const origEl = original ? toTabInput(original, req.blocklist) : null;
    if (!el?.ok || !origEl?.ok || el.input.site !== origEl.input.site || el.input.title !== origEl.input.title) {
      staleTabs++;
      continue;
    }
    choices.push({ tabId: r.tabId, groupId: r.decision.groupId });
  }

  const steps = buildPlan(choices, req.groups, snap.groups);
  const moved = steps.reduce((n, s) => n + s.tabIds.length, 0);
  if (!moved) {
    const extra = out.metrics.tabErrors ? ` ${out.metrics.tabErrors} tab(s) were rejected by the API and left alone.` : "";
    return finish(true, ("Nothing passed the threshold, so no tabs were moved." + extra).trim(), 0, staleTabs);
  }

  await d.saveSnapshot(snap);
  try {
    await applyPlan(d.browser, req.windowId, steps, req.collapse);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    try {
      await restoreSnapshot(d.browser, snap);
      return finish(false, `Chrome refused a tab move (${why}). Changes were rolled back.`, 0, staleTabs);
    } catch {
      return finish(false, `Chrome refused a tab move (${why}) and the rollback was incomplete. Use Undo.`, 0, staleTabs);
    }
  }

  const notes: string[] = [];
  if (out.metrics.tabErrors) notes.push(`${out.metrics.tabErrors} tab(s) were rejected by the API and left alone.`);
  if (staleTabs) notes.push(`${staleTabs} tab(s) changed during the run and were left alone.`);
  return finish(true, notes.length ? notes.join(" ") : null, moved, staleTabs);
}
