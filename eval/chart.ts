import type { Bin, ThresholdPoint } from "./metrics.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Self-contained SVG (no fonts, scripts or external refs): left panel is
 * accuracy and coverage vs threshold, right panel is the reliability diagram.
 */
export function chartSvg(points: ThresholdPoint[], choiceBins: Bin[], noulBins: Bin[], title: string, banner: string | null): string {
  const W = 960;
  const H = 440;
  const pad = { l: 56, r: 20, t: banner ? 78 : 56, b: 56 };
  const pw = (W - pad.l * 2 - pad.r * 2 - 40) / 2;
  const ph = H - pad.t - pad.b;
  const ax = (x0: number, label: string, xlab: string, ylab: string, xmin: number, xmax: number, ticks: number[]) => {
    const out: string[] = [];
    out.push(`<rect x="${x0}" y="${pad.t}" width="${pw}" height="${ph}" fill="none" stroke="#c9ced6"/>`);
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ph - (i / 4) * ph;
      out.push(`<line x1="${x0}" x2="${x0 + pw}" y1="${y}" y2="${y}" stroke="#eceef2"/>`);
      out.push(`<text x="${x0 - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#5f6672">${(i * 25).toString()}%</text>`);
    }
    for (const v of ticks) {
      const x = x0 + ((v - xmin) / (xmax - xmin || 1)) * pw;
      out.push(`<text x="${x}" y="${pad.t + ph + 16}" text-anchor="middle" font-size="11" fill="#5f6672">${v.toFixed(2)}</text>`);
    }
    out.push(`<text x="${x0 + pw / 2}" y="${pad.t - 10}" text-anchor="middle" font-size="13" font-weight="600" fill="#1b1d22">${esc(label)}</text>`);
    out.push(`<text x="${x0 + pw / 2}" y="${pad.t + ph + 36}" text-anchor="middle" font-size="11" fill="#5f6672">${esc(xlab)}</text>`);
    out.push(`<text transform="translate(${x0 - 42} ${pad.t + ph / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="#5f6672">${esc(ylab)}</text>`);
    return out.join("");
  };
  const x1 = pad.l;
  const x2 = pad.l + pw + pad.r + 40 + pad.l;
  const tmin = points[0]?.threshold ?? 0.5;
  const tmax = points[points.length - 1]?.threshold ?? 0.95;
  const px = (t: number) => x1 + ((t - tmin) / (tmax - tmin || 1)) * pw;
  const py = (v: number) => pad.t + ph - v * ph;
  const line = (vals: Array<[number, number | null]>, color: string, dash = "") => {
    const pts = vals.filter((v): v is [number, number] => v[1] !== null);
    if (!pts.length) return "";
    const d = pts.map(([t, v], i) => `${i ? "L" : "M"}${px(t).toFixed(1)},${py(v).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" ${dash ? `stroke-dasharray="${dash}"` : ""}/>` +
      pts.map(([t, v]) => `<circle cx="${px(t).toFixed(1)}" cy="${py(v).toFixed(1)}" r="3" fill="${color}"/>`).join("");
  };
  const rx = (p: number) => x2 + p * pw;
  const ry = (v: number) => pad.t + ph - v * ph;
  const rel = (bins: Bin[], color: string) =>
    bins
      .filter((b) => b.n)
      .map((b) => `<circle cx="${rx(b.meanPredicted).toFixed(1)}" cy="${ry(b.observed).toFixed(1)}" r="${Math.min(12, 3 + Math.sqrt(b.n))}" fill="${color}" fill-opacity="0.55" stroke="${color}"><title>${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: n=${b.n}, predicted ${(b.meanPredicted * 100).toFixed(0)}%, observed ${(b.observed * 100).toFixed(0)}%</title></circle>`)
      .join("");

  const legend = (x: number, items: Array<[string, string, string?]>) =>
    items
      .map(([c, t, dash], i) => `<line x1="${x}" x2="${x + 18}" y1="${H - 12}" y2="${H - 12}" stroke="${c}" stroke-width="3" ${dash ? `stroke-dasharray="${dash}"` : ""} transform="translate(${i * 150} 0)"/><text x="${x + 24 + i * 150}" y="${H - 8}" font-size="11" fill="#1b1d22">${esc(t)}</text>`)
      .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<text x="${W / 2}" y="22" text-anchor="middle" font-size="15" font-weight="700" fill="#1b1d22">${esc(title)}</text>
${banner ? `<rect x="${W / 2 - 300}" y="32" width="600" height="24" rx="4" fill="#fdecea"/><text x="${W / 2}" y="49" text-anchor="middle" font-size="12" font-weight="700" fill="#8a1c12">${esc(banner)}</text>` : ""}
${ax(x1, "Accuracy and coverage vs threshold", "threshold", "rate", tmin, tmax, [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].filter((v) => v >= tmin && v <= tmax))}
${line(points.map((p) => [p.threshold, p.accuracy]), "#1a73e8")}
${line(points.map((p) => [p.threshold, p.coverage]), "#fa903e", "6 4")}
${ax(x2, "Reliability (is 0.9 right ~90% of the time?)", "predicted probability", "observed frequency", 0, 1, [0, 0.2, 0.4, 0.6, 0.8, 1])}
<line x1="${rx(0)}" y1="${ry(0)}" x2="${rx(1)}" y2="${ry(1)}" stroke="#9aa0a6" stroke-dasharray="4 4"/>
${rel(choiceBins, "#1a73e8")}
${rel(noulBins, "#188038")}
${legend(x1, [["#1a73e8", "accuracy"], ["#fa903e", "coverage", "6 4"]])}
${legend(x2, [["#1a73e8", "Choice top prob"], ["#188038", "companion Noul"]])}
</svg>
`;
}
