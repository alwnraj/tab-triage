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
  activeTabId: number | null;
}

/** Build from already-fetched tabs so the snapshot is the state right before we move anything. */
export async function takeSnapshot(b: BrowserAdapter, windowId: number, now = Date.now(), tabs?: TabLike[]): Promise<Snapshot> {
  const [ts, groups] = await Promise.all([tabs ?? b.tabsInWindow(windowId), b.groupsInWindow(windowId)]);
  return {
    windowId,
    at: now,
    tabs: ts.map(({ id, index, groupId, pinned }) => ({ id, index, groupId, pinned })),
    groups,
    activeTabId: ts.find((t) => t.active)?.id ?? null,
  };
}

export async function applyPlan(b: BrowserAdapter, windowId: number, steps: readonly PlanStep[], collapse: boolean): Promise<void> {
  for (const s of steps) {
    const gid = await b.group(s.tabIds, windowId, s.existingGroupId);
    await b.updateGroup(gid, { title: s.group.name, color: s.group.color, collapsed: collapse });
  }
}

/**
 * Restore tabs and groups to the snapshot.
 *
 * Chrome keeps every group contiguous: moving one member away from its group
 * ungroups it, and dropping a loose tab inside a group joins it. So we never
 * move single grouped tabs. Instead:
 *   1. loose-again: ungroup tabs that were loose before;
 *   2. regroup: put tabs back in their original group (recreating it if Chrome deleted it);
 *   3. reorder by UNITS (a loose tab, or a whole group via tabGroups.move), left to right,
 *      each placed right after the already-finished prefix, so a move never lands inside a group;
 *   4. restore group title/colour/collapsed and the active tab, then re-query to verify.
 */
export async function restoreSnapshot(b: BrowserAdapter, snap: Snapshot): Promise<{ restored: number; missing: number; exact: boolean }> {
  const nowTabs = await b.tabsInWindow(snap.windowId);
  const alive = new Map(nowTabs.map((t) => [t.id, t]));
  const tabs = snap.tabs.filter((t) => alive.has(t.id)).sort((x, y) => x.index - y.index);
  const missing = snap.tabs.length - tabs.length;

  // 1.
  await b.ungroup(tabs.filter((t) => t.groupId === -1 && alive.get(t.id)!.groupId !== -1).map((t) => t.id));

  // 2.
  const liveGroups = new Set((await b.groupsInWindow(snap.windowId)).map((g) => g.id));
  const idMap = new Map<number, number>(); // snapshot group id -> current group id
  const byOld = new Map<number, number[]>();
  for (const t of tabs) if (t.groupId !== -1) byOld.set(t.groupId, [...(byOld.get(t.groupId) ?? []), t.id]);
  for (const [oldId, ids] of byOld) {
    const cur = await b.tabsInWindow(snap.windowId);
    const misplaced = ids.filter((id) => cur.find((t) => t.id === id)?.groupId !== oldId);
    if (liveGroups.has(oldId) && !misplaced.length) {
      idMap.set(oldId, oldId);
      continue;
    }
    const gid = await b.group(liveGroups.has(oldId) ? misplaced : ids, snap.windowId, liveGroups.has(oldId) ? oldId : undefined);
    idMap.set(oldId, gid);
  }

  // 3.
  const units: Array<{ kind: "tab"; id: number } | { kind: "group"; id: number; size: number }> = [];
  for (const t of tabs) {
    if (t.groupId === -1) units.push({ kind: "tab", id: t.id });
    else {
      const gid = idMap.get(t.groupId)!;
      const last = units[units.length - 1];
      if (last?.kind === "group" && last.id === gid) last.size++;
      else units.push({ kind: "group", id: gid, size: 1 });
    }
  }
  const pinnedCount = nowTabs.filter((t) => t.pinned && !snap.tabs.some((s) => s.id === t.id)).length;
  let at = pinnedCount;
  for (const u of units) {
    if (u.kind === "tab") {
      await b.moveTabs([u.id], at);
      at += 1;
    } else {
      await b.moveGroup(u.id, at);
      // Order inside the group: moving a tab to a slot within its own group keeps it in the group.
      const members = tabs.filter((t) => t.groupId !== -1 && idMap.get(t.groupId) === u.id).map((t) => t.id);
      for (let k = 0; k < members.length; k++) {
        const cur = await b.tabsInWindow(snap.windowId);
        if (cur.find((t) => t.id === members[k])?.index !== at + k) await b.moveTabs([members[k]!], at + k);
      }
      at += u.size;
    }
  }

  // 4.
  for (const g of snap.groups) {
    const gid = idMap.get(g.id) ?? (liveGroups.has(g.id) ? g.id : undefined);
    if (gid !== undefined) await b.updateGroup(gid, { title: g.title ?? "", color: g.color, collapsed: g.collapsed });
  }
  if (snap.activeTabId !== null && alive.has(snap.activeTabId)) await b.activate(snap.activeTabId);

  const check = await b.tabsInWindow(snap.windowId);
  const order = check.filter((t) => tabs.some((x) => x.id === t.id)).map((t) => t.id);
  const exact =
    order.join(",") === tabs.map((t) => t.id).join(",") &&
    tabs.every((t) => {
      const c = check.find((x) => x.id === t.id)!;
      return t.groupId === -1 ? c.groupId === -1 : c.groupId === idMap.get(t.groupId);
    });
  return { restored: tabs.length, missing, exact };
}
