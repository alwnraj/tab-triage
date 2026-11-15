/**
 * The TypeSafe key for dev scripts: TYPESAFE_API_KEY from the environment, else from a
 * gitignored .env file in the repo root. Tolerates `KEY= "value"` (spaces, quotes) and
 * `export KEY=value`. Never prints, logs or returns anything but the key itself.
 */
import { existsSync, readFileSync } from "node:fs";

export function typesafeKey(): string {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(".env")) return "";
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[1]!;
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1).trim();
    return v;
  }
  return "";
}
