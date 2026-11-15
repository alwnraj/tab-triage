import { MAX_DESCRIPTION, MAX_GROUPS, TITLE_MAX } from "../core/config.js";
import { truncateTitle } from "../core/privacy.js";
import type { ModelGroup, Order, RawAnswer } from "../core/types.js";

/**
 * What the extension sends to the hosted service, and what it gets back. The
 * service builds the TypeSafe questions itself (src/providers/request.ts), so it
 * only accepts this narrow shape: it can't be used as a general TypeSafe proxy.
 */
export interface HostedRequest {
  v: 1;
  site: string;
  title: string;
  groups: Array<{ key: string; description: string }>;
  order: Order;
}
/** A validated request, with groups in the shape buildRequest() takes. */
export interface ParsedHostedRequest extends Omit<HostedRequest, "groups"> {
  groups: ModelGroup[];
}
export type HostedAnswer = RawAnswer;

export const INSTALL_HEADER = "x-tab-triage-install";
/** Set on 503s so the client can tell "paused for today" (don't retry) from a server error. */
export const ERROR_HEADER = "x-tab-triage-error";

const HOST_RE = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const KEY_RE = /^[a-z0-9_]{1,48}$/;
export const INSTALL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validate an incoming body. Returns the cleaned request or a short reason (never echoes the input). */
export function parseHostedRequest(body: unknown): { ok: true; req: ParsedHostedRequest } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "body" };
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return { ok: false, reason: "version" };
  if (typeof b.site !== "string" || !HOST_RE.test(b.site)) return { ok: false, reason: "site" };
  if (typeof b.title !== "string" || b.title.length > TITLE_MAX * 4) return { ok: false, reason: "title" };
  if (b.order !== "fwd" && b.order !== "rev") return { ok: false, reason: "order" };
  if (!Array.isArray(b.groups) || b.groups.length < 1 || b.groups.length > MAX_GROUPS) return { ok: false, reason: "groups" };
  const seen = new Set<string>();
  const groups: ModelGroup[] = [];
  for (const g of b.groups as unknown[]) {
    const x = g as Record<string, unknown> | null;
    if (!x || typeof x.key !== "string" || !KEY_RE.test(x.key) || seen.has(x.key)) return { ok: false, reason: "group key" };
    if (typeof x.description !== "string" || !x.description.trim() || x.description.length > MAX_DESCRIPTION)
      return { ok: false, reason: "group description" };
    seen.add(x.key);
    // groupId is local to the extension and never needed by the service.
    groups.push({ key: x.key, groupId: x.key, description: x.description });
  }
  return { ok: true, req: { v: 1, site: b.site, title: truncateTitle(b.title), groups, order: b.order } };
}

/** Validate the service's answer against the groups we asked about. */
export function parseHostedAnswer(body: unknown, groups: readonly ModelGroup[]): HostedAnswer | null {
  const b = body as Partial<HostedAnswer> | null;
  const inRange = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  if (!b || typeof b.choice !== "string" || !groups.some((g) => g.key === b.choice)) return null;
  if (!inRange(b.noul) || !b.probabilities || typeof b.probabilities !== "object") return null;
  const probabilities: Record<string, number> = {};
  for (const g of groups) {
    const p = (b.probabilities as Record<string, unknown>)[g.key];
    probabilities[g.key] = inRange(p) ? p : 0;
  }
  const tokens = typeof b.inputTokens === "number" && Number.isFinite(b.inputTokens) && b.inputTokens >= 0 ? b.inputTokens : 0;
  return { choice: b.choice, probabilities, noul: b.noul, inputTokens: tokens, model: typeof b.model === "string" ? b.model : "unknown" };
}
