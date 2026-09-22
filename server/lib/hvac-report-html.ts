import type { HvacScorecard } from "./hvac-benchmarks";

/**
 * The printable HVAC report behind "Export PDF".
 *
 * Why this file exists: the export used to build the generic "ClearPath Basecamp Report", the
 * framework the dashboard stopped showing when this became an HVAC product. A buyer saw the HVAC
 * scorecard on screen and took home a different report (found 2026-09-22 in Mark's testing).
 *
 * It is HTML, not a PDF binary: the browser's own "Save as PDF" renders it, which keeps the text
 * selectable and avoids shipping a headless browser just to print one page.
 */
export function buildHvacReportHtml(opts: {
  periodLabel: string;
  periodBasisText: string;
  revenue: number | null;
  hvac: HvacScorecard;
  ownerCompInOpex?: boolean;
}): string {
  const { periodLabel, periodBasisText, revenue, hvac, ownerCompInOpex } = opts;
  const money = (v: number | null) =>
    v === null ? "—" : `$${Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

  const STATUS_TEXT: Record<string, string> = {
    ahead: "Ahead of best-in-class",
    "on-track": "Between average and best-in-class",
    behind: "Behind average",
    unknown: "Not scored",
  };

  const rows = hvac.scores
    .map(
      (s) => `
      <tr class="${s.status}">
        <td class="label">${esc(s.label)}</td>
        <td class="num">${pct(s.actual)}</td>
        <td class="num">${pct(s.average)}</td>
        <td class="num">${pct(s.exceptional)}</td>
        <td class="stand"><span class="pill ${s.status}">${STATUS_TEXT[s.status] ?? s.status}</span>
          ${s.interpretation ? `<p>${esc(s.interpretation)}</p>` : ""}</td>
      </tr>`,
    )
    .join("");

  const borrowed = hvac.borrowedTierLabel
    ? `<p class="note">Scored against the ${esc(hvac.borrowedTierLabel)} column: the industry report
       doesn't publish a band below it.</p>`
    : "";

  const ownerNote = ownerCompInOpex
    ? `<p class="note">Owner pay appears to sit inside operating expenses. The benchmarks exclude it,
       so overhead here reads higher than the comparison assumes.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClearPath HVAC Report — ${esc(periodLabel)}</title>
<style>
  :root { --ink:#111827; --muted:#5B6B80; --line:#E3E8EF; --gold:#C9A84C; --navy:#0B1E4E; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
    max-width: 900px; margin: 0 auto; padding: 32px 24px 56px; line-height: 1.5; }
  h1 { font-size: 1.7rem; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
  .card { flex: 1 1 200px; border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .card span { display: block; color: var(--muted); font-size: .82rem; }
  .card strong { font-size: 1.35rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.label { font-weight: 600; }
  td.stand p { margin: 6px 0 0; color: var(--muted); font-size: .88rem; }
  .pill { display: inline-block; font-size: .78rem; font-weight: 700; padding: 3px 9px; border-radius: 999px; }
  .pill.ahead { background:#DCFCE7; color:#14532D; }
  .pill.on-track { background:#DBEAFE; color:#1E3A8A; }
  .pill.behind { background:#FEE2E2; color:#7F1D1D; }
  .pill.unknown { background:#F1F5F9; color:#475569; }
  .note { background:#FFF8E6; border-left:4px solid var(--gold); padding:10px 14px; color:#5B4A18;
    font-size:.9rem; margin: 18px 0 0; }
  footer { margin-top: 36px; color: var(--muted); font-size: .82rem; border-top: 1px solid var(--line); padding-top: 14px; }
  @media print { body { padding: 0; } .pill { border: 1px solid currentColor; } }
</style></head>
<body>
  <h1>ClearPath HVAC Report</h1>
  <p class="sub">${esc(periodLabel)} · ${esc(periodBasisText)}</p>

  <div class="cards">
    <div class="card"><span>Revenue</span><strong>${money(revenue)}</strong></div>
    <div class="card"><span>Annualised revenue</span><strong>${money(hvac.annualRevenue)}</strong></div>
    <div class="card"><span>Revenue tier</span><strong>${esc(hvac.tierLabel)}</strong></div>
  </div>

  <h2>Your numbers against HVAC shops your size</h2>
  <p class="sub">Every line is a percentage of revenue. <strong>Average</strong> is what a typical HVAC shop
    in this revenue band runs at. <strong>Best-in-class</strong> is the top quartile — the column you're
    scored against.</p>

  <table>
    <thead><tr>
      <th>Category</th><th class="num">You</th><th class="num">Average</th>
      <th class="num">Best-in-class</th><th>Where you stand</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${borrowed}
  ${ownerNote}

  <footer>Built by ClearPath HVAC from the P&amp;L you uploaded. Benchmarks come from the HVAC industry
    report for shops in this revenue band, not from a generic small-business average.</footer>
</body></html>`;
}
