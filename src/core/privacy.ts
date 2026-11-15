import { TITLE_MAX } from "./config.js";
import type { SkipReason, TabInput, TabLike } from "./types.js";

/** Lowercased hostname with any trailing dot removed; null for anything that isn't http(s). */
export function webHostname(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return host || null;
}

/** Normalise a user-entered domain ("https://www.Foo.com/x" -> "www.foo.com"). */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) return "";
  if (s.includes("://")) s = webHostname(s) ?? "";
  s = s.replace(/^\*\./, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return s;
}

/** True if host equals domain or is a subdomain of it. "bank.com" matches "www.bank.com", not "notbank.com". */
export function hostMatches(host: string, domain: string): boolean {
  const d = normalizeDomain(domain);
  if (!d) return false;
  return host === d || host.endsWith("." + d);
}

/** Truncate by code points so we never split a surrogate pair. */
export function truncateTitle(title: string | undefined, max = TITLE_MAX): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length <= max ? clean : chars.slice(0, max).join("");
}

/**
 * Hosts that only make sense on your own machine or network: localhost, IP
 * literals, single-label intranet names, and private suffixes. Never sent.
 */
export function isLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  if (host.startsWith("[") || host.includes(":")) return true; // IPv6
  if (!host.includes(".")) return true; // intranet single label
  return /\.(local|internal|lan|home|corp|intranet|test|invalid|example)$/.test(host);
}

export type Eligibility = { ok: true; input: TabInput } | { ok: false; reason: SkipReason };

/**
 * Decide whether a tab may be considered at all and, if so, reduce it to the
 * only fields that may leave the machine: hostname and a truncated title.
 */
export function toTabInput(tab: TabLike, blocklist: readonly string[]): Eligibility {
  if (tab.pinned) return { ok: false, reason: "pinned" };
  if (tab.groupId !== -1) return { ok: false, reason: "already-grouped" };
  const site = webHostname(tab.url);
  if (!site) return { ok: false, reason: "not-web" };
  if (isLocalHost(site)) return { ok: false, reason: "local" };
  if (blocklist.some((d) => hostMatches(site, d))) return { ok: false, reason: "blocklisted" };
  return { ok: true, input: { site, title: truncateTitle(tab.title) } };
}
