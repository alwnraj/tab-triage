import type { BrowserAdapter } from "../src/browser/adapter.js";
import type { GroupColor, GroupLike, TabLike } from "../src/core/types.js";

/**
 * In-memory model of one Chrome window's tab strip. Mirrors the Chrome
 * behaviours the code relies on: grouped tabs are contiguous, a group that
 * loses its last tab is deleted, and tabs.move shifts neighbours.
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

  constructor(windowId: number, specs: Array<Partial<TabLike> & { url: string; title: string }>) {
    this.tabs = specs.map((s, i) => ({ id: i + 1, index: i, windowId, groupId: -1, pinned: false, ...s }));
  }

  private check() {
    if (this.busy > 0) {
      this.busy--;
      throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
    }
  }
  private reindex() {
    this.tabs.forEach((t, i) => (t.index = i));
    this.groups = this.groups.filter((g) => this.tabs.some((t) => t.groupId === g.id));
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
    let gid = groupId;
    if (gid === undefined) {
      gid = this.nextGroup++;
      this.groups.push({ id: gid, windowId, title: "", color: "grey", collapsed: false });
    } else if (!this.groups.some((g) => g.id === gid)) throw new Error(`No group with id: ${gid}.`);
    // Pull tabs out and append them after the group's last tab (or at the end).
    const moving = this.tabs.filter((t) => tabIds.includes(t.id));
    this.tabs = this.tabs.filter((t) => !tabIds.includes(t.id));
    const lastIdx = this.tabs.map((t) => t.groupId).lastIndexOf(gid);
    const at = lastIdx === -1 ? this.tabs.length : lastIdx + 1;
    moving.forEach((t) => (t.groupId = gid!));
    this.tabs.splice(at, 0, ...moving);
    this.reindex();
    return gid;
  }
  async ungroup(tabIds: number[]) {
    this.check();
    for (const t of this.tabs) if (tabIds.includes(t.id)) t.groupId = -1;
    this.reindex();
  }
  async updateGroup(groupId: number, props: { title?: string; color?: GroupColor; collapsed?: boolean }) {
    this.check();
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) throw new Error(`No group with id: ${groupId}.`);
    Object.assign(g, props);
  }
  async move(tabId: number, index: number) {
    this.check();
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t) throw new Error(`No tab with id: ${tabId}.`);
    this.tabs = this.tabs.filter((x) => x !== t);
    this.tabs.splice(Math.min(index, this.tabs.length), 0, t);
    this.reindex();
  }
  strip() {
    return this.tabs.map((t) => `${t.id}${t.groupId === -1 ? "" : "@" + t.groupId}`).join(" ");
  }
}
