import type { SortReport } from "./core/sort.js";

export type Request =
  | { type: "sort"; windowId: number; threshold: number }
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
  if (r.type === "sort") {
    const t = r.threshold;
    if (typeof t !== "number" || !(t >= 0.5 && t <= 0.99)) return null;
    return { type: "sort", windowId, threshold: t };
  }
  if (r.type === "undo") return { type: "undo", windowId };
  if (r.type === "status") return { type: "status", windowId };
  return null;
}
