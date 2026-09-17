#!/usr/bin/env node
/**
 * verify-routes-render.mjs — does every screen actually render in a browser?
 *
 * WHY THIS EXISTS
 * `d0d93ff` shipped a Review screen that was blank on every visit. Its commit message reads
 * "verified: typecheck and build clean, built bundle boots" — all three were true, and none of
 * them opens a page. A `useMutation` had been declared *below* the screen's early returns, so
 * the loading render ran one hook fewer than the loaded render; React's hook-count invariant
 * fired the moment the data arrived (minified error #310) and unmounted the whole root. The
 * report looked broken too, because after that tear-down no client-side navigation renders
 * anything until a hard reload.
 *
 * The same pass found two silent defects from the same commit: `uploadId` was read from
 * `window.location.search`, which is not reactive, while wouter's `useLocation` tracks only the
 * pathname — so a query-string-only navigation re-rendered nothing. The new period switcher
 * moved the URL to December and kept showing January's money.
 *
 * WHAT IT DOES
 * Serves the **real built bundle** (`dist/public`) against a stub API, drives it with headless
 * Chrome over the DevTools Protocol, and fails on any uncaught exception or console error — plus
 * three behavioural assertions that reproduce the defects above rather than merely asserting the
 * fix. No database, no credentials, no network.
 *
 * RUN IT:  npm run build  &&  node scripts/verify-routes-render.mjs
 * Exit code 0 = every route rendered clean. Non-zero = something is broken; read the output.
 */
import express from "express";
import { spawn } from "child_process";
import WebSocket from "ws";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist", "public");
const PORT = Number(process.env.SMOKE_PORT ?? 2198);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT ?? 9332);

const JAN = "11111111-1111-1111-1111-111111111111";
const DEC = "22222222-2222-2222-2222-222222222222";

const failures = [];
const fail = (m) => { failures.push(m); console.error("  x " + m); };
const pass = (m) => console.log("  ok " + m);

// ---------------------------------------------------------------- stub API
if (!fs.existsSync(DIST)) {
  console.error(`No build at ${DIST}. Run "npm run build" first.`);
  process.exit(2);
}

const node = (o) => ({
  parentId: null, level: 1, displayOrder: 0, sourcePath: o.label, suggestedCategory: null,
  confidence: "high", mappingStatus: "mapped", excludedReason: null, fromMemory: false,
  isRollup: 0, ...o,
});

const JAN_PERIOD = "aaaaaaaa-1111-1111-1111-111111111111";
const DEC_PERIOD = "aaaaaaaa-2222-2222-2222-222222222222";

const app = express();
let uploadsFixture = [
  {
    id: JAN, filename: "smoke-2026-01.pdf", monthStart: "2026-01-01T00:00:00.000Z",
    uploadedAt: "2026-02-01T00:00:00.000Z", status: "parsed",
    periods: [{ id: JAN_PERIOD, label: "January 2026", periodType: "month", periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-01-31T00:00:00.000Z", monthsCovered: 1, confirmed: true, displayOrder: 0 }],
    needsPeriodConfirmation: false,
  },
  {
    id: DEC, filename: "smoke-2025-12.pdf", monthStart: "2025-12-01T00:00:00.000Z",
    uploadedAt: "2026-01-01T00:00:00.000Z", status: "mapped",
    periods: [{ id: DEC_PERIOD, label: "December 2025", periodType: "month", periodStart: "2025-12-01T00:00:00.000Z", periodEnd: "2025-12-31T00:00:00.000Z", monthsCovered: 1, confirmed: true, displayOrder: 0 }],
    needsPeriodConfirmation: false,
  },
];
// Paid access gating: flipped by the access section near the end, so every earlier check runs
// against the open-signup app exactly as before.
let stubAccess = { gateEnabled: false, ended: false, signedOut: false };
app.get("/api/auth/config", (_q, r) => r.json({ accessGateEnabled: stubAccess.gateEnabled, purchaseUrl: "https://go.taxsherpa.com/hvac-workshop/register" }));
app.get("/api/user", (_q, r) => {
  if (stubAccess.signedOut) return r.status(401).json({ error: "Not authenticated" });
  if (stubAccess.ended) {
    return r.status(403).json({
      error: "access_expired", email: "smoke@example.com", endedAt: "2026-11-28T00:00:00.000Z",
      startsAt: null, purchaseUrl: "https://go.taxsherpa.com/hvac-workshop/register",
    });
  }
  r.json({ id: "u1", email: "smoke@example.com" });
});
app.get("/api/uploads", (_q, r) => r.json(uploadsFixture));
app.get("/api/uploads/:id/nodes", (req, r) => {
  const isDec = req.params.id === DEC;
  const periodId = isDec ? DEC_PERIOD : JAN_PERIOD;
  const periods = (uploadsFixture.find(u => u.id === req.params.id) || {}).periods || [];
  r.json({
    periodId,
    periods,
    nodes: [
      node({ id: "n1", label: "Income", level: 0, amountCents: null, mappedCategory: null, confidence: null, mappingStatus: null }),
      node({ id: "n2", label: "Title Fees", amountCents: 1234500, mappedCategory: "revenue", fromMemory: true }),
      node({ id: "n3", label: "Total Income", level: 0, amountCents: 1234500, isRollup: 1, mappedCategory: null, confidence: null, mappingStatus: null }),
      node({ id: "n4", label: "Advertising", amountCents: 45000, mappedCategory: "cac", confidence: "needs_review" }),
      node({ id: "n5", label: "Misc", amountCents: 900, mappedCategory: "opex_systems", mappingStatus: "excluded", excludedReason: "user" }),
    ],
  });
});
app.get("/api/uploads/:id/report", (req, r) => {
  const isDec = req.params.id === DEC;
  const revenue = isDec ? 9000 : 12345;
  const grossProfit = isDec ? 7000 : 10345;
  const periodId = isDec ? DEC_PERIOD : JAN_PERIOD;
  const periods = (uploadsFixture.find(u => u.id === req.params.id) || {}).periods || [];
  r.json({
    metrics: {
      revenue, grossProfit, fulfillment: revenue - grossProfit, fulfillmentCogs: 1200,
      fulfillmentServices: 800, cac: 450, opexSystems: 300, opexPeople: 900,
      operationalNetProfit: grossProfit - 1650, taxStrategy: 1000,
      taxableNetProfit: grossProfit - 2650, fulfillmentPct: 16.2, cacPct: 4.4,
      opexSystemsPct: 2.9, opexPeoplePct: 8.7, operationalNetProfitPct: 84.1,
      taxStrategyPct: 9.7, taxableNetProfitPct: 74.4,
    },
    benchmarks: {},
    variances: [{ category: "OpEx People", current: 8.7, target: 10, variance: -1.3, status: "healthy" }],
    tier: "under-250k",
    periodBasis: "Monthly P&L annualized from 1 month",
    tieringSource: "own",
    period: periods[0] ?? null,
    periods,
    upload: {
      monthStart: isDec ? "2025-12-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
      filename: isDec ? "smoke-2025-12.pdf" : "smoke-2026-01.pdf",
    },
  });
});
const metrics = (isDec) => {
  const revenue = isDec ? 9000 : 12345;
  const grossProfit = isDec ? 7000 : 10345;
  return {
    revenue, grossProfit, fulfillment: revenue - grossProfit, fulfillmentCogs: 1200,
    fulfillmentServices: 800, cac: 450, opexSystems: 300, opexPeople: 900,
    operationalNetProfit: grossProfit - 1650, taxStrategy: 1000,
    taxableNetProfit: grossProfit - 2650, fulfillmentPct: 16.2, cacPct: 4.4,
    opexSystemsPct: 2.9, opexPeoplePct: 8.7, operationalNetProfitPct: 84.1,
    taxStrategyPct: 9.7, taxableNetProfitPct: 74.4,
  };
};
// Phase 2.7 — mode defaults (mom/qoq/ytd) each get a stub response; qoq and ytd are stubbed as
// deliberately unavailable (this fixture doesn't have 6+ contiguous months or two years of
// data), which exercises the "reason" branch of the mode picker the same way Phase 2.6's annual
// toggle test exercises its own unavailable branch.
const comparisonDeltas = () => ({
  revenue: { amountDelta: 3345, allocationDelta: null },
  fulfillmentCogs: { amountDelta: 0, allocationDelta: null },
  fulfillmentServices: { amountDelta: 0, allocationDelta: null },
  fulfillment: { amountDelta: 3345, allocationDelta: 0 },
  grossProfit: { amountDelta: 3345, allocationDelta: null },
  cac: { amountDelta: 0, allocationDelta: 0 },
  opexSystems: { amountDelta: 0, allocationDelta: 0 },
  opexPeople: { amountDelta: 0, allocationDelta: 0 },
  operationalNetProfit: { amountDelta: 3345, allocationDelta: 0 },
  taxStrategy: { amountDelta: 0, allocationDelta: 0 },
  taxableNetProfit: { amountDelta: 3345, allocationDelta: 0 },
});
app.get("/api/comparisons", (req, r) => {
  const mode = req.query.mode;
  if (mode === "qoq") return r.status(404).json({ available: false, mode: "qoq", reason: "Need at least 6 complete confirmed monthly statements to compute two rolling 3-month quarters (found 2)." });
  if (mode === "ytd") return r.status(404).json({ available: false, mode: "ytd", reason: "This year (2026): No confirmed monthly statements on file for 2026 yet." });
  r.json({
    mode: mode === "mom" ? "mom" : "custom",
    periods: [
      { uploadId: DEC, periodId: DEC_PERIOD, periodLabel: "December 2025", periodBasis: "Monthly P&L annualized from 1 month", metrics: metrics(true) },
      { uploadId: JAN, periodId: JAN_PERIOD, periodLabel: "January 2026", periodBasis: "Monthly P&L annualized from 1 month", metrics: metrics(false) },
    ],
    comparisons: [{
      fromUploadId: DEC,
      toUploadId: JAN,
      fromLabel: "December 2025",
      toLabel: "January 2026",
      deltas: comparisonDeltas(),
      variances: [],
    }],
    variancesVsFirst: [],
  });
});
// Phase 2.6 — annual/YTD construction. One deliberately-unavailable case (full-year 2026, no
// confirmed annual upload on file) and one available case (YTD 2026, built from January), so the
// smoke pass exercises both the "unavailable, with a reason" branch and the normal report render
// the toggle switches into — the exact two branches a React hook-order bug could hide behind.
app.get("/api/reports/annual", (req, r) => {
  const year = Number(req.query.year);
  const mode = req.query.mode;
  if (mode === "full-year") {
    return r.status(404).json({ available: false, reason: `No confirmed annual P&L on file for ${year} — upload one, or view year-to-date instead.` });
  }
  r.json({
    available: true,
    year,
    mode,
    source: "monthly-history",
    metrics: metrics(false),
    benchmarks: {},
    variances: [],
    tier: "under-250k",
    periodBasis: "YTD P&L annualized from 1 month (January 2026, 1 confirmed monthly statement)",
    sourcePeriodIds: [JAN_PERIOD],
  });
});
app.delete("/api/uploads/:id", (req, r) => {
  uploadsFixture = uploadsFixture.filter((upload) => upload.id !== req.params.id);
  r.json({ success: true });
});
app.use("/api", (_q, r) => r.status(404).json({ error: "stub: not implemented" }));
app.use(express.static(DIST));
app.use((_q, r) => r.sendFile(path.join(DIST, "index.html")));

const server = await new Promise((res) => { const s = app.listen(PORT, () => res(s)); });
const base = `http://localhost:${PORT}`;

// ---------------------------------------------------------------- browser
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c));
}

const chromePath = findChrome();
if (!chromePath) {
  console.error("No Chrome or Edge found. Set CHROME_PATH to a Chromium binary and re-run.");
  server.close();
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-smoke-"));
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

async function debuggerUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Chrome did not expose a debugging port");
}

const ws = new WebSocket(await debuggerUrl(), { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
let errors = [];
const send = (method, params = {}, sessionId) =>
  new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });

await new Promise((r) => ws.on("open", r));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    errors.push((d.exception?.description || d.text || "").split("\n").slice(0, 2).join(" "));
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").split("\n")[0]);
  }
});

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);

const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;
const settle = () => new Promise((r) => setTimeout(r, Number(process.env.SMOKE_SETTLE_MS ?? 2000)));

/** Navigate, wait, and report anything the page threw. Returns its visible text. */
async function visit(label, url) {
  errors = [];
  await send("Page.navigate", { url }, sessionId);
  await settle();
  const text = (await evaluate("document.body.innerText")) ?? "";
  console.log(`\n${label}  ->  ${url.replace(base, "")}`);
  for (const e of errors) fail(`${label}: ${e}`);
  // A React tear-down leaves #root empty, which is the "white screen" a user reports.
  const rootLen = await evaluate("document.getElementById('root').innerHTML.length");
  if (!rootLen) fail(`${label}: #root is empty — the page rendered nothing`);
  else if (!errors.length) pass(`${label} rendered (${rootLen} chars, no console errors)`);
  return text;
}

console.log(`Serving ${DIST} on ${base}\nDriving ${path.basename(chromePath)} headless\n${"-".repeat(70)}`);

// 1. Every route renders at all. This is what caught the blank Review screen: the crash only
//    happens on the *second* render, once the query resolves, so the page must be given time to
//    load its data rather than merely be navigated to.
const upload = await visit("/upload", `${base}/upload`);
if (!/Upload Your P&L/.test(upload)) fail("/upload: heading missing");

const review = await visit("/review", `${base}/review?uploadId=${JAN}`);
if (!/Review & Map/.test(review)) fail("/review: heading missing");
if (!/Title Fees/.test(review)) fail("/review: node data never reached the page");

const report = await visit("/dashboard", `${base}/dashboard?uploadId=${JAN}`);
if (!/ClearPath Report/.test(report)) fail("/dashboard: heading missing");
if (!/January 2026/.test(report)) fail("/dashboard: wrong reporting period rendered");

// Phase 2.6 — the annual/YTD toggle on the same report screen. The unavailable branch (no
// confirmed annual upload) and the normal-render branch (YTD from monthly history) are two
// different code paths through the same component; a hook declared below an early return would
// only show up on whichever branch actually re-renders after data arrives, so both are visited.
const annualView = await visit("/dashboard (Full Year, unavailable)", `${base}/dashboard?uploadId=${JAN}&view=annual&year=2026`);
if (!/No full year on file for 2026/.test(annualView)) fail("/dashboard annual view: unavailable message did not render");

const ytdView = await visit("/dashboard (Year-to-Date)", `${base}/dashboard?uploadId=${JAN}&view=ytd&year=2026`);
if (!/Year-to-Date 2026/.test(ytdView)) fail("/dashboard YTD view: heading missing");
if (!/YTD P&L annualized from 1 month/.test(ytdView)) fail("/dashboard YTD view: period-basis text missing");

// Reported by Neal against the live site (2026-09-06): clicking "Full Year" from a 2025 report
// jumped to 2026 instead of building 2025's full year, because the toggle defaulted to the most
// recent year across ALL uploads rather than the year of the upload actually being viewed. Here
// DEC (December 2025) is the older of the two fixture uploads while JAN (January 2026) is the
// newest, so this reproduces the exact shape: viewing December and clicking Full Year with no
// `year` in the URL yet must default to 2025, not 2026.
await visit("/dashboard (December, before clicking Full Year)", `${base}/dashboard?uploadId=${DEC}`);
console.log("\nFull Year toggle defaults to the viewed upload's year, not the newest upload's year");
errors = [];
const clickedFullYear = await evaluate(`(() => { const b = document.querySelector('[data-testid="button-view-annual"]'); if (!b) return false; b.click(); return true; })()`);
if (!clickedFullYear) fail("Full Year toggle: button missing");
else {
  await settle();
  const search = await evaluate("location.search");
  if (!search.includes("year=2025")) fail(`Full Year toggle: defaulted to the wrong year while viewing December 2025 (${search})`);
  else pass(`Full Year toggle defaulted to 2025 while viewing a December 2025 report (${search})`);
  for (const e of errors) fail("Full Year toggle: " + e);
}

const compare = await visit("/compare", `${base}/compare`);
if (!/Period Comparison/.test(compare)) fail("/compare: heading missing");

// Phase 2.7 — the page now defaults to Month-over-Month and fetches it immediately (no period
// picker needed), which is itself a code path a hook-order bug could hide behind: the results
// table renders on first load, not only after a user selects something.
if (!/Comparison Results/.test(compare)) fail("/compare: default Month-over-Month mode did not render results on load");
else pass("/compare defaulted to Month-over-Month and rendered results without any selection");

console.log("\ncomparison mode: Rolling Quarter-over-Quarter (stubbed unavailable)");
errors = [];
const clickedQoq = await evaluate(`(() => { const b = document.querySelector('[data-testid="button-mode-qoq"]'); if (!b) return false; b.click(); return true; })()`);
if (!clickedQoq) fail("comparison mode: QoQ button missing");
else {
  await settle();
  const text = await evaluate("document.body.innerText");
  if (!/rolling 3-month quarters/.test(text)) fail("comparison mode: QoQ unavailable reason did not render");
  else pass("comparison mode: QoQ unavailable reason rendered instead of a crash");
  for (const e of errors) fail("comparison mode QoQ: " + e);
}

console.log("\ncomparison mode: Custom (December vs January, by period)");
errors = [];
const clickedCustom = await evaluate(`(() => { const b = document.querySelector('[data-testid="button-mode-custom"]'); if (!b) return false; b.click(); return true; })()`);
if (!clickedCustom) fail("comparison mode: Custom button missing");
await settle();
const selectedComparisonPeriods = await evaluate(
  `(() => {
    const dec = document.querySelector('[data-testid="checkbox-period-${DEC_PERIOD}"]');
    const jan = document.querySelector('[data-testid="checkbox-period-${JAN_PERIOD}"]');
    if (!dec || !jan) return false;
    dec.click();
    jan.click();
    return true;
  })()`,
);
if (!selectedComparisonPeriods) fail("comparison selection: December and January period checkboxes were not available");
else {
  await settle();
  const text = await evaluate("document.body.innerText");
  if (!/Comparison Results/.test(text)) fail("comparison selection: results table did not render");
  // Phase 2.5: the comparison grid renders the server's periodLabel (e.g. "December 2025"), not
  // the client's own abbreviated format — Phase 2.7 keeps that convention for the new
  // period-level picker.
  if (!/December 2025/.test(text)) fail("comparison selection: December column missing");
  if (!/January 2026/.test(text)) fail("comparison selection: January column missing");
  for (const e of errors) fail("comparison selection: " + e);
  if (!errors.length && /Comparison Results/.test(text)) pass("comparison rendered after selecting December and January by period");
}
const settings = await visit("/settings", `${base}/settings`);
if (!/Privacy Policy/.test(settings) || !/Terms of Service/.test(settings)) {
  fail("/settings: Phase 4.1 footer legal links missing");
} else {
  pass("/settings: footer legal links present");
}

// Phase 4.1 — the Privacy Policy and Terms of Service must render real content (not the app
// shell) at their own routes, reachable without a session, since a signed-out visitor is exactly
// who needs to read them before the app is ever promoted.
const privacy = await visit("/privacy", `${base}/privacy`);
if (!/Privacy Policy/.test(privacy)) fail("/privacy: heading missing");
if (!/retained indefinitely by default/.test(privacy)) fail("/privacy: retention terms missing");
if (!/Tax Sherpa and its affiliates may contact you/.test(privacy)) fail("/privacy: marketing consent scope missing");
if (!/Online Tax Solutions Group LLC/.test(privacy)) fail("/privacy: legal entity missing");

const terms = await visit("/terms", `${base}/terms`);
if (!/Terms of Service/.test(terms)) fail("/terms: heading missing");
if (!/not tax, legal, financial, or accounting advice/.test(terms)) fail("/terms: advice disclaimer missing");
if (!/Georgia/.test(terms)) fail("/terms: governing law missing");

// 2. A query-string-only navigation must actually re-render. Before the fix the URL changed and
//    the page did not, so December's URL showed January's figures.
await visit("/dashboard (again, for the switcher)", `${base}/dashboard?uploadId=${JAN}`);
console.log("\nperiod switcher (query-string-only navigation)");
errors = [];
await evaluate(`document.querySelector('[data-testid="select-period"]')?.click()`);
await new Promise((r) => setTimeout(r, 600));
const switched = await evaluate(
  `(() => { const o = Array.from(document.querySelectorAll('[role="option"]'))
      .find(x => x.textContent.includes("December")); if (!o) return false; o.click(); return true; })()`,
);
if (!switched) fail("period switcher: December option not offered");
else {
  await settle();
  const search = await evaluate("location.search");
  const text = await evaluate("document.body.innerText");
  if (!search.includes(DEC)) fail(`period switcher: URL did not change (${search})`);
  else if (!/December 2025/.test(text)) fail("period switcher: URL moved to December but the page still shows " + (/January 2026/.test(text) ? "January" : "something else"));
  else pass("period switcher re-rendered the page for the new period");
  for (const e of errors) fail("period switcher: " + e);
}

// 3. /dashboard with nothing selected must land on the newest month, not sit on the empty state.
const bare = await visit("/dashboard (no uploadId)", `${base}/dashboard`);
if (/No statements yet/.test(bare)) fail("/dashboard: redirected to the latest month in the URL but kept rendering the empty state");
else if (!/January 2026/.test(bare)) fail("/dashboard: did not default to the most recent period");
else pass("/dashboard defaulted to the most recent period");

// 4. Deleting an upload from the report must update the upload list immediately. With
//    React Query's staleTime set to Infinity, navigating back to /upload used to show the
//    deleted period from cache until a full browser refresh.
await visit("/dashboard (delete source)", `${base}/dashboard?uploadId=${JAN}`);
console.log("\ndelete upload invalidates upload history");
errors = [];
await evaluate("window.confirm = () => true");
const clickedDelete = await evaluate(`(() => { const b = document.querySelector('[data-testid="button-delete"]'); if (!b) return false; b.click(); return true; })()`);
if (!clickedDelete) fail("delete upload: delete button missing");
else {
  await settle();
  const path = await evaluate("location.pathname");
  const text = await evaluate("document.body.innerText");
  if (path !== "/upload") fail(`delete upload: did not navigate back to /upload (${path})`);
  if (/smoke-2026-01\.pdf/.test(text) || /January 2026/.test(text)) {
    fail("delete upload: Upload History still showed the deleted January period without a refresh");
  } else if (!/smoke-2025-12\.pdf/.test(text)) {
    fail("delete upload: remaining December period disappeared too");
  } else {
    pass("delete upload removed the period from Upload History without a refresh");
  }
  for (const e of errors) fail("delete upload: " + e);
}

// Phase 4.3 — accessibility controls must be reachable from every route (including the ones
// outside the app shell) and must actually change what's on screen, not just flip an attribute.
console.log("\naccessibility: control reachable outside the app shell (/auth)");
await visit("/auth", `${base}/auth`);
const a11yButtonOnAuth = await evaluate(`!!document.querySelector('[data-testid="button-accessibility-menu"]')`);
if (!a11yButtonOnAuth) fail("/auth: accessibility menu button missing outside the app shell");
else pass("/auth: accessibility menu button present");

console.log("\naccessibility: color/contrast, font, and size controls actually change the page");
await visit("/dashboard (accessibility)", `${base}/dashboard?uploadId=${JAN}`);
errors = [];
const opened = await evaluate(`(() => { const b = document.querySelector('[data-testid="button-accessibility-menu"]'); if (!b) return false; b.click(); return true; })()`);
if (!opened) fail("accessibility menu: trigger button missing");
else {
  await settle();
  const clickedHighContrast = await evaluate(`(() => { const b = document.querySelector('[data-testid="toggle-color-high-contrast"]'); if (!b) return false; b.click(); return true; })()`);
  if (!clickedHighContrast) fail("accessibility menu: high-contrast toggle missing");
  else {
    await settle();
    const contrastAttr = await evaluate("document.documentElement.getAttribute('data-contrast')");
    if (contrastAttr !== "high") fail(`accessibility menu: high-contrast attribute did not apply (${contrastAttr})`);
    else pass("accessibility menu: high-contrast mode applied");

    // The stoplight bands must still show a text label under high contrast, and the unlit
    // bands must be more than a bare 12%-opacity tint against the near-white background.
    const bandCheck = await evaluate(`(() => {
      const bands = Array.from(document.querySelectorAll('[role="img"][aria-label*="target"]'));
      if (!bands.length) return { found: false };
      const first = bands[0];
      const labels = Array.from(first.children).map(c => c.textContent.trim());
      return { found: true, labels };
    })()`);
    if (!bandCheck?.found) fail("accessibility menu: no stoplight meter present to check under high contrast");
    else if (bandCheck.labels.length !== 5 || bandCheck.labels.some((l) => !l)) {
      fail(`accessibility menu: stoplight band labels missing under high contrast (${JSON.stringify(bandCheck.labels)})`);
    } else pass(`accessibility menu: all five stoplight band labels present under high contrast (${bandCheck.labels.join(", ")})`);
  }

  const clickedSerif = await evaluate(`(() => { const b = document.querySelector('[data-testid="toggle-font-serif"]'); if (!b) return false; b.click(); return true; })()`);
  if (!clickedSerif) fail("accessibility menu: serif font toggle missing");
  else {
    await settle();
    const fontAttr = await evaluate("document.documentElement.getAttribute('data-font')");
    const bodyFont = await evaluate("getComputedStyle(document.body).fontFamily");
    if (fontAttr !== "serif") fail(`accessibility menu: font attribute did not apply (${fontAttr})`);
    else if (!/Georgia/.test(bodyFont)) fail(`accessibility menu: body font did not switch to serif (${bodyFont})`);
    else pass(`accessibility menu: serif font applied (${bodyFont})`);
  }

  const clickedXL = await evaluate(`(() => { const b = document.querySelector('[data-testid="toggle-size-x-large"]'); if (!b) return false; b.click(); return true; })()`);
  if (!clickedXL) fail("accessibility menu: extra-large text toggle missing");
  else {
    await settle();
    const rootFontPx = await evaluate("parseFloat(getComputedStyle(document.documentElement).fontSize)");
    if (!(rootFontPx > 18)) fail(`accessibility menu: root font size did not scale up for XL text (${rootFontPx}px)`);
    else pass(`accessibility menu: root font size scaled to ${rootFontPx}px for XL text`);
  }

  for (const e of errors) fail("accessibility menu: " + e);
}

console.log("\naccessibility: choice survives a reload (localStorage + no-flash inline script)");
await visit("/dashboard (accessibility, after reload)", `${base}/dashboard?uploadId=${JAN}`);
const persisted = await evaluate(
  "({ contrast: document.documentElement.getAttribute('data-contrast'), font: document.documentElement.getAttribute('data-font'), size: document.documentElement.getAttribute('data-fontsize') })",
);
if (persisted?.contrast !== "high" || persisted?.font !== "serif" || persisted?.size !== "x-large") {
  fail(`accessibility menu: settings did not persist across navigation/reload (${JSON.stringify(persisted)})`);
} else pass("accessibility menu: high-contrast + serif + XL persisted across reload");

// Paid access gating — the two screens that change when ACCESS_GATE_ENABLED is on. Both are
// early returns in the router/auth page, exactly where a hook-order bug hides.
console.log("\naccess gating: sign-in page wording with the gate on");
// Signed out: a signed-in visitor to /auth is (correctly) redirected into the app.
stubAccess = { gateEnabled: true, ended: false, signedOut: true };
const gatedAuth = await visit("/auth (gate on)", `${base}/auth`);
if (!/comes with a Tax Sherpa workshop ticket/.test(gatedAuth)) fail("/auth (gate on): paid-access wording missing");
else pass("/auth (gate on): says access comes with a workshop ticket");
if (/one is created the first time you sign in/.test(gatedAuth)) fail("/auth (gate on): still promises open signup");

console.log("\naccess gating: a session whose access ended sees the access-ended screen, not the app");
stubAccess = { gateEnabled: true, ended: true, signedOut: false };
const ended = await visit("/upload (access ended)", `${base}/upload`);
if (!/Your access has ended/.test(ended)) fail("access ended: heading missing");
if (!/November 28, 2026/.test(ended)) fail("access ended: end date missing or in the wrong timezone");
if (/Upload Your P&L/.test(ended)) fail("access ended: the app rendered behind the access-ended screen");
const renewHref = await evaluate(`document.querySelector('[data-testid="button-renew-access"]')?.getAttribute('href') ?? null`);
if (renewHref !== "https://go.taxsherpa.com/hvac-workshop/register") fail(`access ended: renew button missing or wrong link (${renewHref})`);
else if (/Your access has ended/.test(ended) && /November 28, 2026/.test(ended)) pass("access ended: screen, end date and renew link rendered");
const onAuthPath = await evaluate("location.pathname");
if (onAuthPath !== "/upload") fail(`access ended: redirected to ${onAuthPath} instead of staying put (sign-in loop risk)`);
stubAccess = { gateEnabled: false, ended: false, signedOut: false };

// ---------------------------------------------------------------- teardown
console.log("\n" + "-".repeat(70));
chrome.kill();
server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* windows file locks */ }

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\nAll routes rendered clean.");
process.exit(0);
