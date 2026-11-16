import type { SortReport } from "./core/sort.js";

export type Request =
  | { type: "sort"; windowId: number }
  | { type: "undo"; windowId: number }
  | { type: "status"; windowId: number };

export type Response =
  | { ok: true; report: SortReport | null; running: boolean; canUndo: boolean }
  | { ok: false; error: string; report?: SortReport | null; running?: boolean; canUndo?: boolean };

/** Validate an incoming message's shape (the worker trusts nothing). */
export function parseRequest(m: unknown): Request | null {
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  if (!Number.isSafeInteger(r.windowId) || (r.windowId as number) < 0) return null;
  const windowId = r.windowId as number;
  // The threshold is a setting (Options page), read by the worker, so it isn't part of the message.
  if (r.type === "sort") return { type: "sort", windowId };
  if (r.type === "undo") return { type: "undo", windowId };
  if (r.type === "status") return { type: "status", windowId };
  return null;
}
