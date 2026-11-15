import { EDIT_RETRY_DELAY_MS, EDIT_RETRY_MAX } from "../core/config.js";
import type { GroupColor, GroupLike, TabLike } from "../core/types.js";

/** Everything the core needs from the browser. The chrome-backed version is below; tests use a fake. */
export interface BrowserAdapter {
  tabsInWindow(windowId: number): Promise<TabLike[]>;
  groupsInWindow(windowId: number): Promise<GroupLike[]>;
  /** Group tabs into an existing group, or a new one in windowId. Returns the group id. */
  group(tabIds: number[], windowId: number, groupId?: number): Promise<number>;
  ungroup(tabIds: number[]): Promise<void>;
  updateGroup(groupId: number, props: { title?: string; color?: GroupColor; collapsed?: boolean }): Promise<void>;
  /** Move tabs (as a block) to an index. Chrome may join or leave groups depending on where they land. */
  moveTabs(tabIds: number[], index: number): Promise<void>;
  /** Move a whole group so its first tab lands at index. */
  moveGroup(groupId: number, index: number): Promise<void>;
  activate(tabId: number): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chrome refuses tab edits while the user is dragging a tab; retry after ~50 ms. */
export async function withEditRetry<T>(fn: () => Promise<T>, delay = EDIT_RETRY_DELAY_MS, max = EDIT_RETRY_MAX): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i >= max || !/cannot be edited right now/i.test(msg)) throw e;
      await sleep(delay);
    }
  }
}

export const chromeAdapter: BrowserAdapter = {
  async tabsInWindow(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    return tabs
      .filter((t) => typeof t.id === "number")
      .map((t) => ({
        id: t.id!,
        index: t.index,
        windowId: t.windowId,
        groupId: t.groupId,
        pinned: t.pinned,
        active: t.active,
        url: t.url,
        title: t.title,
      }));
  },
  async groupsInWindow(windowId) {
    const gs = await chrome.tabGroups.query({ windowId });
    return gs.map((g) => ({ id: g.id, windowId: g.windowId, title: g.title, color: g.color as GroupColor, collapsed: g.collapsed }));
  },
  group(tabIds, windowId, groupId) {
    const ids = tabIds as [number, ...number[]];
    return withEditRetry(() =>
      groupId !== undefined ? chrome.tabs.group({ tabIds: ids, groupId }) : chrome.tabs.group({ tabIds: ids, createProperties: { windowId } }),
    );
  },
  async ungroup(tabIds) {
    if (!tabIds.length) return;
    await withEditRetry(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]));
  },
  async updateGroup(groupId, props) {
    await withEditRetry(() => chrome.tabGroups.update(groupId, props));
  },
  async moveTabs(tabIds, index) {
    await withEditRetry(() => chrome.tabs.move(tabIds as [number, ...number[]], { index }));
  },
  async moveGroup(groupId, index) {
    await withEditRetry(() => chrome.tabGroups.move(groupId, { index }));
  },
  async activate(tabId) {
    await withEditRetry(() => chrome.tabs.update(tabId, { active: true }));
  },
};
