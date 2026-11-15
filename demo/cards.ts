/** Title card, caption overlays and end card, rendered to PNG by Chromium (this ffmpeg build has no drawtext). */
import type { Page } from "playwright";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const FONT = `-apple-system, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

async function shot(page: Page, html: string, path: string, transparent: boolean) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:1920px;height:1080px;font-family:${FONT};${transparent ? "background:transparent" : "background:#101418;color:#f1f3f4"}}
  </style>${html}`);
  await page.screenshot({ path, omitBackground: transparent });
}

export async function titleCard(page: Page, path: string, mode: string) {
  await shot(
    page,
    `<div style="height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:28px">
      <div style="display:flex;gap:14px">${["#1a73e8", "#188038", "#fa903e", "#d93025", "#a142f4"].map((c) => `<div style="width:90px;height:18px;border-radius:9px;background:${c}"></div>`).join("")}</div>
      <div style="font-size:112px;font-weight:800;letter-spacing:-2px">tab-triage</div>
      <div style="font-size:40px;color:#bdc1c6">Sorts tabs into groups, only when a calibrated model is confident.</div>
      <div style="font-size:28px;color:#9aa0a6;margin-top:16px">Real extension · real Chromium tab strip · ${esc(mode)}</div>
    </div>`,
    path,
    false,
  );
}

export async function caption(page: Page, path: string, text: string, sub?: string, mock = false) {
  await shot(
    page,
    // Centred over the page area left of the popup window (which covers about the right 35%
    // of the frame), so the caption never hides the popup's latency/cost footer.
    `<div style="position:absolute;left:0;right:700px;bottom:56px;display:flex;justify-content:center">
      <div style="background:rgba(16,20,24,.88);color:#fff;border-radius:18px;padding:22px 40px;max-width:1140px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35)">
        <div style="font-size:46px;font-weight:700">${esc(text)}</div>
        ${sub ? `<div style="font-size:30px;color:#c4c7c5;margin-top:8px">${esc(sub)}</div>` : ""}
      </div>
    </div>
    ${mock ? `<div style="position:absolute;left:24px;top:150px;background:#c5221f;color:#fff;font-size:26px;font-weight:800;letter-spacing:1px;border-radius:10px;padding:8px 16px">MOCK · REHEARSAL, NOT THE MODEL</div>` : ""}`,
    path,
    true,
  );
}

export interface EndNumbers {
  latencyS: string;
  cost: string;
  sortedPct: string;
  grouped: number;
  eligible: number;
  calls: number;
  classifier: string;
  mock: boolean;
}

export async function endCard(page: Page, path: string, n: EndNumbers) {
  const stat = (big: string, small: string) =>
    `<div style="text-align:center;min-width:360px"><div style="font-size:96px;font-weight:800">${esc(big)}</div><div style="font-size:30px;color:#bdc1c6">${esc(small)}</div></div>`;
  await shot(
    page,
    `<div style="height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:56px">
      <div style="font-size:44px;color:#bdc1c6">Measured on this run</div>
      <div style="display:flex;gap:40px">
        ${stat(n.latencyS, "to classify and sort")}
        ${stat(n.cost, "estimated API cost")}
        ${stat(n.sortedPct, `sorted (${n.grouped} of ${n.eligible} tabs)`)}
      </div>
      <div style="font-size:28px;color:#9aa0a6">${esc(`${n.calls} API calls · classifier: ${n.classifier}`)}</div>
      ${n.mock ? `<div style="font-size:34px;font-weight:800;color:#ffb4ab">MOCK CLASSIFIER — REHEARSAL ONLY, NOT REAL NUMBERS</div>` : ""}
      <div style="font-size:30px;color:#e8eaed">Undo restores every tab · github.com/alwnraj/tab-triage</div>
    </div>`,
    path,
    false,
  );
}
