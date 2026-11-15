import type { BrowserAdapter } from "../browser/adapter.js";
import type { GroupDef, GroupLike, TabLike } from "./types.js";

export interface PlanStep {
  group: GroupDef;
  tabIds: number[];
  /** Existing group in this window with the same title, reused instead of creating a duplicate. */
  existingGroupId?: number;
}

/** Pure: turn per-tab group choices into one step per target group, in the user's group order. */
export function buildPlan(
  choices: ReadonlyArray<{ tabId: number; groupId: string | null }>,
  groups: readonly GroupDef[],
  existing: readonly GroupLike[],
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const g of groups) {
    const tabIds = choices.filter((c) => c.groupId === g.id).map((c) => c.tabId);
    if (!tabIds.length) continue;
    const match = existing.find((e) => (e.title ?? "").trim().toLowerCase() === g.name.trim().toLowerCase());
    steps.push({ group: g, tabIds, ...(match ? { existingGroupId: match.id } : {}) });
  }
  return steps;
}

export interface Snapshot {
  windowId: number;
  at: number;
  tabs: Array<Pick<TabLike, "id" | "index" | "groupId" | "pinned">>;
  groups: GroupLike[];
}

export async function takeSnapshot(b: BrowserAdapter, windowId: number, now = Date.now()): Promise<Snapshot> {
  const [tabs, groups] = await Promise.all([b.tabsInWindow(windowId), b.groupsInWindow(windowId)]);
  return {
    windowId,
    at: now,
    tabs: tabs.map(({ id, index, groupId, pinned }) => ({ id, index, groupId, pinned })),
    groups,
  };
}

export async function applyPlan(b: BrowserAdapter, windowId: number, steps: readonly PlanStep[], collapse: boolean): Promise<void> {
  for (const s of steps) {
    const gid = await b.group(s.tabIds, windowId, s.existingGroupId);
    await b.updateGroup(gid, { title: s.group.name, color: s.group.color, collapsed: collapse });
  }
}

/**
 * Restore tabs (and groups we touched) to the snapshot. Tolerates tabs closed
 * since, and recreates groups Chrome deleted when we emptied them.
 */
export async function restoreSnapshot(b: BrowserAdapter, snap: Snapshot): Promise<{ restored: number; missing: number }> {
  const nowTabs = await b.tabsInWindow(snap.windowId);
  const alive = new Map(nowTabs.map((t) => [t.id, t]));
  const tabs = snap.tabs.filter((t) => alive.has(t.id));
  const missing = snap.tabs.length - tabs.length;

  // 1. Tabs that were loose go back to being loose.
  const wereLoose = tabs.filter((t) => t.groupId === -1 && alive.get(t.id)!.groupId !== -1).map((t) => t.id);
  await b.ungroup(wereLoose);

  // 2. Tabs that were in a group go back to it (recreating it if Chrome removed it).
  const liveGroups = new Set((await b.groupsInWindow(snap.windowId)).map((g) => g.id));
  const byOldGroup = new Map<number, number[]>();
  for (const t of tabs) {
    if (t.groupId === -1 || alive.get(t.id)!.groupId === t.groupId) continue;
    byOldGroup.set(t.groupId, [...(byOldGroup.get(t.groupId) ?? []), t.id]);
  }
  for (const [oldId, ids] of byOldGroup) {
    const meta = snap.groups.find((g) => g.id === oldId);
    const gid = await b.group(ids, snap.windowId, liveGroups.has(oldId) ? oldId : undefined);
    if (meta) await b.updateGroup(gid, { title: meta.title ?? "", color: meta.color, collapsed: meta.collapsed });
  }

  // 3. Original order, ascending, so earlier moves don't shift later targets.
  for (const t of [...tabs].sort((x, y) => x.index - y.index)) await b.move(t.id, t.index);

  // 4. Groups that existed before keep their original title/colour/collapsed state.
  const after = new Set((await b.groupsInWindow(snap.windowId)).map((g) => g.id));
  for (const g of snap.groups) if (after.has(g.id)) await b.updateGroup(g.id, { title: g.title ?? "", color: g.color, collapsed: g.collapsed });

  return { restored: tabs.length, missing };
}
