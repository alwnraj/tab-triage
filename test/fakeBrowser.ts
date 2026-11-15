import type { BrowserAdapter } from "../src/browser/adapter.js";
import type { GroupColor, GroupLike, TabLike } from "../src/core/types.js";

/**
 * In-memory model of one Chrome window's tab strip, built to be as strict as
 * Chrome where our code depends on it:
 *  - pinned tabs come first and are never grouped;
 *  - every group is contiguous (checked after EVERY operation; violation throws);
 *  - a new group forms at the leftmost selected tab; tabs added to an existing
 *    group join at its start if they were left of it, else at its end;
 *  - a group that loses its last tab is deleted;
 *  - tabs.move: a tab dropped strictly inside a group joins it; a grouped tab
 *    moved away from its group leaves it;
 *  - ungrouping a tab from the middle of a group moves it to the group's right edge;
 *  - unknown tab/group ids throw.
 */
export class FakeBrowser implements BrowserAdapter {
  tabs: TabLike[] = [];
  groups: GroupLike[] = [];
  nextGroup = 100;
  /** Make the next N edits throw Chrome's drag error. */
  busy = 0;
  /** Throw on the Nth group() call (1-based), to test rollback. */
  failGroupCall = 0;
  groupCalls = 0;

  constructor(
    private windowId: number,
    specs: Array<Partial<TabLike> & { url: string; title: string }>,
  ) {
    const pinned = specs.filter((s) => s.pinned);
    const rest = specs.filter((s) => !s.pinned);
    this.tabs = [...pinned, ...rest].map((s) => ({ windowId, groupId: -1, pinned: false, ...s, id: 0, index: 0 }));
    // Ids follow the spec order so tests can refer to them by position in the spec list.
    const ordered = [...pinned, ...rest];
    this.tabs.forEach((t, i) => (t.id = specs.indexOf(ordered[i]!) + 1));
    if (this.tabs[0]) this.tabs[0].active = true;
    this.reindex();
  }

  private check() {
    if (this.busy > 0) {
      this.busy--;
      throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
    }
  }
  private tab(id: number) {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    return t;
  }
  private reindex() {
    this.tabs.forEach((t, i) => (t.index = i));
    this.groups = this.groups.filter((g) => this.tabs.some((t) => t.groupId === g.id));
    // Invariants Chrome guarantees.
    let seenUnpinned = false;
    for (const t of this.tabs) {
      if (!t.pinned) seenUnpinned = true;
      else if (seenUnpinned) throw new Error("FakeBrowser invariant: pinned tab after unpinned");
      if (t.pinned && t.groupId !== -1) throw new Error("FakeBrowser invariant: pinned tab in a group");
    }
    for (const g of this.groups) {
      const idx = this.tabs.filter((t) => t.groupId === g.id).map((t) => t.index);
      if (Math.max(...idx) - Math.min(...idx) + 1 !== idx.length) throw new Error(`FakeBrowser invariant: group ${g.id} not contiguous`);
    }
  }
  private span(gid: number) {
    const idx = this.tabs.filter((t) => t.groupId === gid).map((t) => this.tabs.indexOf(t));
    return { first: Math.min(...idx), last: Math.max(...idx) };
  }

  async tabsInWindow(windowId: number) {
    return this.tabs.filter((t) => t.windowId === windowId).map((t) => ({ ...t }));
  }
  async groupsInWindow(windowId: number) {
    return this.groups.filter((g) => g.windowId === windowId).map((g) => ({ ...g }));
  }

  async group(tabIds: number[], windowId: number, groupId?: number) {
    this.check();
    this.groupCalls++;
    if (this.failGroupCall && this.groupCalls === this.failGroupCall) throw new Error("boom");
    const moving = tabIds.map((id) => this.tab(id));
    if (moving.some((t) => t.pinned)) throw new Error("Cannot group pinned tabs.");
    if (groupId !== undefined && !this.groups.some((g) => g.id === groupId)) throw new Error(`No group with id: ${groupId}.`);
    const gid = groupId ?? this.nextGroup++;
    if (groupId === undefined) this.groups.push({ id: gid, windowId, title: "", color: "grey", collapsed: false });
    const groupFirstBefore = groupId !== undefined ? this.span(gid).first : -1;
    const leftOfGroup = moving.filter((t) => groupId !== undefined && this.tabs.indexOf(t) < groupFirstBefore);
    const rightOfGroup = moving.filter((t) => !leftOfGroup.includes(t));
    const anchorIdx = Math.min(...moving.map((t) => this.tabs.indexOf(t)));
    // Remove the moving tabs (their old groups may become non-contiguous only transiently).
    this.tabs = this.tabs.filter((t) => !moving.includes(t));
    for (const t of moving) t.groupId = gid;
    if (groupId === undefined) {
      const at = this.tabs.filter((t) => t.index < anchorIdx).length;
      this.tabs.splice(at, 0, ...moving);
    } else {
      const members = this.tabs.filter((t) => t.groupId === gid);
      const first = this.tabs.indexOf(members[0]!);
      this.tabs.splice(first, 0, ...leftOfGroup);
      const last = this.tabs.indexOf(members[members.length - 1]!);
      this.tabs.splice(last + 1, 0, ...rightOfGroup);
    }
    this.reindex();
    return gid;
  }

  async ungroup(tabIds: number[]) {
    this.check();
    for (const id of tabIds) {
      const t = this.tab(id);
      if (t.groupId === -1) continue;
      const { last } = this.span(t.groupId);
      this.tabs.splice(this.tabs.indexOf(t), 1);
      t.groupId = -1;
      this.tabs.splice(last, 0, t); // right edge of what's left of the group
      this.reindex();
    }
  }

  async updateGroup(groupId: number, props: { title?: string; color?: GroupColor; collapsed?: boolean }) {
    this.check();
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) throw new Error(`No group with id: ${groupId}.`);
    Object.assign(g, props);
  }

  async moveTabs(tabIds: number[], index: number) {
    this.check();
    const moving = tabIds.map((id) => this.tab(id));
    this.tabs = this.tabs.filter((t) => !moving.includes(t));
    const at = Math.min(index, this.tabs.length);
    const left = this.tabs[at - 1];
    const right = this.tabs[at];
    this.tabs.splice(at, 0, ...moving);
    for (const t of moving) {
      if (left && right && left.groupId !== -1 && left.groupId === right.groupId) t.groupId = left.groupId; // dropped inside a group
      else if (t.groupId !== -1 && left?.groupId !== t.groupId && right?.groupId !== t.groupId) t.groupId = -1; // left its group
    }
    // Chrome never lets a group split: anything still separated from its group is ungrouped.
    for (const g of this.groups) {
      const members = this.tabs.filter((t) => t.groupId === g.id);
      if (!members.length) continue;
      const first = this.tabs.indexOf(members[0]!);
      for (let i = first; i < first + members.length; i++) if (this.tabs[i]!.groupId !== g.id) {
        for (const m of members) if (this.tabs.indexOf(m) > i) m.groupId = -1;
        break;
      }
    }
    this.reindex();
  }

  async moveGroup(groupId: number, index: number) {
    this.check();
    if (!this.groups.some((g) => g.id === groupId)) throw new Error(`No group with id: ${groupId}.`);
    const block = this.tabs.filter((t) => t.groupId === groupId);
    this.tabs = this.tabs.filter((t) => t.groupId !== groupId);
    const at = Math.min(index, this.tabs.length);
    const left = this.tabs[at - 1];
    const right = this.tabs[at];
    if (left && right && left.groupId !== -1 && left.groupId === right.groupId) throw new Error("Cannot move the group into the middle of another group.");
    this.tabs.splice(at, 0, ...block);
    this.reindex();
  }

  async activate(tabId: number) {
    this.check();
    const t = this.tab(tabId);
    for (const x of this.tabs) x.active = x === t;
  }

  strip() {
    return this.tabs.map((t) => `${t.id}${t.groupId === -1 ? "" : "@" + t.groupId}`).join(" ");
  }
  /** Strip with group ids replaced by group titles, for comparisons across recreated groups. */
  look() {
    return this.tabs
      .map((t) => {
        const g = this.groups.find((x) => x.id === t.groupId);
        return `${t.id}${g ? `@${g.title}/${g.color}/${g.collapsed ? "c" : "o"}` : ""}${t.active ? "*" : ""}`;
      })
      .join(" ");
  }
}
