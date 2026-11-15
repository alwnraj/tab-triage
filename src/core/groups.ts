import { hostMatches } from "./privacy.js";
import type { GroupDef, ModelGroup, Order } from "./types.js";

/**
 * Option keys sent to the model. Always prefixed with "g_" so they are never
 * integer-like: JS objects put integer-like keys first regardless of insertion
 * order, which would silently defeat the order-reversal check.
 */
export function slugKey(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  // Option names are sent to the model, so keep them plain words ("research"). Only an
  // all-digit name needs a prefix: JS orders integer-like object keys first, which would
  // silently undo the reversed-order re-ask.
  if (!base) return "group";
  return /^\d+$/.test(base) ? `g_${base}` : base;
}

/** Groups the model can choose between (those with a description), with unique keys. */
export function toModelGroups(groups: readonly GroupDef[]): ModelGroup[] {
  const used = new Set<string>();
  const out: ModelGroup[] = [];
  for (const g of groups) {
    const description = g.description.trim();
    if (!description) continue; // domain-only group
    const base = slugKey(g.name);
    let key = base;
    for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
    used.add(key);
    out.push({ key, groupId: g.id, description });
  }
  return out;
}

export function ordered(groups: readonly ModelGroup[], order: Order): ModelGroup[] {
  return order === "fwd" ? [...groups] : [...groups].reverse();
}

/** Deterministic step 1: the first group whose domain list contains the host. */
export function matchDomain(site: string, groups: readonly GroupDef[]): GroupDef | null {
  for (const g of groups) if (g.domains.some((d) => hostMatches(site, d))) return g;
  return null;
}
