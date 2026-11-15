/**
 * Shared helper: launch a Chromium with a FRESH temporary profile and the
 * unpacked extension from dist/. Never touches your real browser profile.
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Worker } from "playwright";

/** Prefer CHROMIUM_PATH, then Playwright's bundled build, then any cached Chrome for Testing. */
export function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const p = chromium.executablePath();
    if (existsSync(p)) return p;
  } catch {}
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const mac = join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (existsSync(mac)) return mac;
    const linux = join(cache, d, "chrome-linux/chrome");
    if (existsSync(linux)) return linux;
  }
  return undefined;
}

export interface Launched {
  ctx: BrowserContext;
  sw: Worker;
  extId: string;
  profileDir: string;
}

export async function launchWithExtension(opts: { headless: boolean; args?: string[]; viewport?: { width: number; height: number } | null }): Promise<Launched> {
  const dist = join(process.cwd(), "dist");
  if (!existsSync(join(dist, "manifest.json"))) throw new Error("dist/ missing: run `npm run build` first");
  const profileDir = mkdtempSync(join(tmpdir(), "tab-triage-profile-"));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless,
    executablePath: chromiumPath(),
    viewport: opts.viewport === undefined ? { width: 1280, height: 800 } : opts.viewport,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-features=Translate,ChromeWhatsNewUI",
      ...(opts.args ?? []),
    ],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
  const extId = new URL(sw.url()).host;
  return { ctx, sw, extId, profileDir };
}
