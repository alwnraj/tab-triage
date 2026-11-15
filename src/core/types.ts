/** Chrome's tab-group colors. */
export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** A user-defined group (Options page). */
export interface GroupDef {
  /** Stable id (generated once, never shown to the model). */
  id: string;
  name: string;
  color: GroupColor;
  /** Plain-language criterion sent to the model. Empty => domain-only group. */
  description: string;
  /** Optional hostnames; a tab on one of these (or a subdomain) is grouped without any API call. */
  domains: string[];
}

/** A group as the model sees it: a non-numeric key plus its description. */
export interface ModelGroup {
  key: string; // e.g. "g_research"
  groupId: string;
  description: string;
}

/** The only per-tab data that may leave the machine. */
export interface TabInput {
  site: string; // hostname only
  title: string; // truncated to TITLE_MAX
}

export type Order = "fwd" | "rev";

/** What the classifier returned for one tab in one option order. Cached as-is. */
export interface RawAnswer {
  /** Key of the Choice's selected option. */
  choice: string;
  /** Probability per option key. Read by key, never by position. */
  probabilities: Record<string, number>;
  /** Companion Noul: P(the tab fits one of the groups). */
  noul: number;
  /** Billable input tokens for the call that produced this (0 on cache hit when reported). */
  inputTokens: number;
  /** Model id that answered (e.g. "jev-1.14.0" or "mock"). */
  model: string;
}

export type DecisionReason =
  | "domain"
  | "confident"
  | "order-agree"
  | "no-fit"
  | "low-prob"
  | "order-disagree"
  | "needs-reverse"
  | "error";

export interface Decision {
  /** Group id to place the tab in, or null to leave it alone. */
  groupId: string | null;
  /** Group the model leaned toward, even when not grouped (for display). */
  leaningGroupId: string | null;
  /** Top Choice probability (1 for domain matches). */
  probability: number;
  /** Companion Noul (1 for domain matches). */
  noul: number;
  reason: DecisionReason;
}

export type SkipReason = "pinned" | "not-web" | "local" | "blocklisted" | "already-grouped";

/** Minimal tab shape the core logic needs; mirrors chrome.tabs.Tab. */
export interface TabLike {
  id: number;
  index: number;
  windowId: number;
  groupId: number; // -1 when ungrouped
  pinned: boolean;
  active?: boolean;
  url?: string;
  title?: string;
}

export interface GroupLike {
  id: number;
  windowId: number;
  title?: string;
  color: GroupColor;
  collapsed: boolean;
}
