import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { db } from "./db";
import { uploads, plNodes, categoryMappings, rules, reports, periods, plNodePeriodAmounts } from "@shared/schema";
import type { PeriodType } from "@shared/schema";
import { parseCSV } from "./lib/csv-parser";
import { parsePDF, MultiColumnPDFError } from "./lib/pdf-parser";
import { scoreMetrics as scoreHvacMetrics } from "./lib/hvac-benchmarks";
import { buildHvacReportHtml } from "./lib/hvac-report-html";
import { detectOwnerCompInOpex } from "./lib/hvac-accounts";
import {
  loadPeriodMetrics,
  loadPeriodNodes,
  loadMultiPeriodMetrics,
  getUploadPeriods,
  getTier,
  getBenchmarks,
  calculateVariances,
  resolveTieringBasis,
  resolveAnnualConstruction,
  resolveMonthOverMonth,
  resolveRollingQuarterOverQuarter,
  resolveYtdOverYtd,
  calculateComparisonVariances,
  type Metrics,
  type Benchmarks,
  type Variance,
  type ComparisonPeriodResult,
  type ComparisonModeResult,
} from "./lib/rollups";
import { CATEGORY_ORDER, categoryLabel, METRIC_LABELS, METRIC_ORDER } from "@shared/categories";
import { formatMonthSlug, formatPeriodRange, describePeriodBasis } from "@shared/period";
import { recordMappingChoice, lookupRemembered } from "./lib/mapping-memory";
import { registerAccessWebhook } from "./access-webhook";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { z } from "zod";

// Every category the client may send. Previously this route took whatever string arrived and
// let Postgres reject it with a 500; an unknown category is a client error, not a server one.
const mapNodeSchema = z.object({
  category: z.enum(CATEGORY_ORDER as [string, ...string[]]),
  confidence: z.enum(["high", "medium", "needs_review"]).optional(),
  status: z.enum(["mapped", "excluded"]).optional(),
  excludedReason: z.string().max(500).optional(),
  createRule: z.boolean().optional(),
  ruleScope: z.enum(["category_label", "category_path", "category_regex"]).optional(),
  scopeValue: z.string().optional(),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const isCSV = file.mimetype === 'text/csv' || file.originalname.endsWith('.csv');
    const isPDF = file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf');
    if (isCSV || isPDF) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and PDF files are allowed'));
    }
  },
});

/**
 * Signed in AND, when the access gate is on, holding active access. `req.accessEnded` is set
 * by the session middleware in server/auth.ts; it is never set while the gate is off.
 */
function requireAuth(req: any, res: any, next: any) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.accessEnded) {
    return res.status(403).json({ error: "access_expired" });
  }
  next();
}

/**
 * Signed in, whether or not access is still active. Only for the self-serve data purge:
 * someone whose access ended must still be able to delete their own financial data.
 */
function requireSignedIn(req: any, res: any, next: any) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * Resolve which period a report/export request is about: the `?periodId=` query param if it
 * belongs to this upload, otherwise the upload's first (chronologically earliest) period.
 * Every report-producing route (on-screen, CSV export, PDF export) shares this so they agree.
 */
async function resolveReportPeriod(uploadId: string, req: any) {
  const uploadPeriods = await getUploadPeriods(uploadId);
  const requestedPeriodId = typeof req.query.periodId === "string" ? req.query.periodId : undefined;
  const period = uploadPeriods.find(p => p.id === requestedPeriodId) ?? uploadPeriods[0];
  return { period, uploadPeriods };
}

/**
 * Renders the report HTML shared by the single-period PDF export and Phase 2.6's annual/YTD
 * PDF export — one template, so a constructed annual figure is presented identically to a
 * monthly one rather than via a second copy of this markup that could drift from it.
 */
function buildReportHtml(opts: {
  title: string;
  periodLabel: string;
  periodBasisText: string;
  tier: string;
  metrics: Metrics;
  benchmarks: Benchmarks;
  variances: Variance[];
}): string {
  const { title, periodLabel, periodBasisText, tier, metrics, benchmarks, variances } = opts;
  const formatCurrency = (val: number) => `$${val.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  const formatPercent = (val: number | null) => (val === null ? '—' : `${val.toFixed(1)}%`);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title} - ${periodLabel}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: #1a1a1a; margin-bottom: 10px; }
    h2 { color: #333; margin-top: 30px; border-bottom: 2px solid #eee; padding-bottom: 5px; }
    .metric { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
    .metric-label { font-weight: 600; }
    .metric-value { font-size: 18px; font-weight: 700; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
    .indent .metric-label { padding-left: 20px; font-weight: 400; color: #555; }
    .calculated { background: #fafafa; border-bottom: 2px solid #ddd; }
    .note { font-size: 13px; color: #666; margin: 4px 0 12px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p><strong>Period:</strong> ${periodLabel}</p>
  <p><strong>Generated:</strong> ${new Date().toISOString().split('T')[0]}</p>
  <p><strong>Tier:</strong> ${tier} <small>(by annualized Gross Profit — ${periodBasisText})</small></p>

  <h2>Operating Performance (Basecamp)</h2>
  <div class="metric">
    <span class="metric-label">Revenue</span>
    <span class="metric-value">${formatCurrency(metrics.revenue)}</span>
  </div>
  <div class="metric indent">
    <span class="metric-label">Fulfillment — COGS</span>
    <span class="metric-value">${formatCurrency(metrics.fulfillmentCogs)}</span>
  </div>
  <div class="metric indent">
    <span class="metric-label">Fulfillment — Services</span>
    <span class="metric-value">${formatCurrency(metrics.fulfillmentServices)}</span>
  </div>
  <div class="metric">
    <span class="metric-label">Fulfillment (total)</span>
    <span class="metric-value">${formatCurrency(metrics.fulfillment)} <small>(${formatPercent(metrics.fulfillmentPct)} of revenue)</small></span>
  </div>
  <div class="metric calculated">
    <span class="metric-label">Gross Profit</span>
    <span class="metric-value">${formatCurrency(metrics.grossProfit)}</span>
  </div>
  <div class="metric">
    <span class="metric-label">Customer Acquisition (CAC)</span>
    <span class="metric-value">${formatCurrency(metrics.cac)} <small>(${formatPercent(metrics.cacPct)})</small></span>
  </div>
  <div class="metric">
    <span class="metric-label">OpEx Systems</span>
    <span class="metric-value">${formatCurrency(metrics.opexSystems)} <small>(${formatPercent(metrics.opexSystemsPct)})</small></span>
  </div>
  <div class="metric">
    <span class="metric-label">OpEx People</span>
    <span class="metric-value">${formatCurrency(metrics.opexPeople)} <small>(${formatPercent(metrics.opexPeoplePct)})</small></span>
  </div>
  <div class="metric calculated">
    <span class="metric-label">Operational Net Profit <small>(Owner Benefit)</small></span>
    <span class="metric-value">${formatCurrency(metrics.operationalNetProfit)} <small>(${formatPercent(metrics.operationalNetProfitPct)} vs target ${benchmarks.operationalNetProfit.target}%)</small></span>
  </div>

  <h2>Profit Conversion (Ascent)</h2>
  <p class="note">An individual's tax situation is holistic, not isolated to the business — so
  Ascent Moves carries no target percentage here. The only goal is to legally minimize Taxable
  Net Profit.</p>
  <div class="metric">
    <span class="metric-label">Operational Net Profit</span>
    <span class="metric-value">${formatCurrency(metrics.operationalNetProfit)}</span>
  </div>
  <div class="metric indent">
    <span class="metric-label">Ascent Moves / Tax Strategy</span>
    <span class="metric-value">${formatCurrency(metrics.taxStrategy)} <small>(${formatPercent(metrics.taxStrategyPct)} of gross profit)</small></span>
  </div>
  <div class="metric calculated">
    <span class="metric-label">Taxable Net Profit</span>
    <span class="metric-value">${formatCurrency(metrics.taxableNetProfit)} <small>(${formatPercent(metrics.taxableNetProfitPct)})</small></span>
  </div>

  ${variances.length > 0 ? `
  <h2>Where to Look First</h2>
  ${variances.map(v => `
  <div class="metric">
    <span class="metric-label">${v.category} <small>(${v.status})</small></span>
    <span class="metric-value">${v.current} <small>vs target ${v.target}</small></span>
  </div>`).join('')}
  ` : '<h2>Where to Look First</h2><p class="note">No categories are outside their benchmark range this month.</p>'}

  <div class="footer">
    <p>Generated by ClearPath HVAC | This report is for financial planning purposes only</p>
  </div>
</body>
</html>
`;
}

export async function registerRoutes(app: Express): Promise<Server> {
  registerAccessWebhook(app);

  app.get("/api/uploads", requireAuth, async (req, res) => {
    try {
      const userUploads = await db.select()
        .from(uploads)
        .where(eq(uploads.userId, req.user!.id));

      const uploadIds = userUploads.map(u => u.id);
      const allPeriods = uploadIds.length
        ? await db.select().from(periods).where(inArray(periods.uploadId, uploadIds)).orderBy(periods.displayOrder)
        : [];
      const periodsByUpload = new Map<string, typeof allPeriods>();
      for (const p of allPeriods) {
        const list = periodsByUpload.get(p.uploadId) ?? [];
        list.push(p);
        periodsByUpload.set(p.uploadId, list);
      }

      res.json(userUploads.map(upload => {
        const uploadPeriods = periodsByUpload.get(upload.id) ?? [];
        return {
          id: upload.id,
          filename: upload.originalFilename,
          // Backward-compatible alias; new code should prefer `periods`.
          monthStart: upload.monthStart,
          uploadedAt: upload.createdAt,
          status: upload.status,
          periods: uploadPeriods.map(p => ({
            id: p.id,
            label: p.label,
            periodType: p.periodType,
            periodStart: p.periodStart,
            periodEnd: p.periodEnd,
            monthsCovered: p.monthsCovered,
            confirmed: p.confirmed,
            displayOrder: p.displayOrder,
          })),
          needsPeriodConfirmation: uploadPeriods.some(p => !p.confirmed),
        };
      }));
    } catch (error: any) {
      console.error('Get uploads error:', error);
      res.status(500).json({ error: "Failed to fetch uploads" });
    }
  });

  app.post("/api/uploads", requireAuth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const userId = req.user!.id;
      const isPDF = req.file.mimetype === 'application/pdf' || req.file.originalname.endsWith('.pdf');

      // Common shape both parsers normalize into: a list of periods to create, and — per node —
      // one amount per period, in the same order. CSV can produce several periods (one per
      // detected column); PDF always produces exactly one (multi-column PDFs are rejected
      // before reaching here — see MultiColumnPDFError below).
      let periodsToCreate: {
        label: string;
        periodType: PeriodType;
        periodStart: Date;
        periodEnd: Date;
        monthsCovered: number;
        confirmed: boolean;
      }[];
      let parsedNodes: {
        tempId: string;
        label: string;
        level: number;
        displayOrder: number;
        amounts: (number | null)[];
        isRollup: boolean;
        sourcePath: string;
        parentTempId?: string;
        suggestedCategory?: any;
        confidence?: any;
      }[];
      let errors: string[];
      let pageResults: any[] | undefined;

      if (isPDF) {
        console.log("Processing PDF file...");
        try {
          const pdfResult = await parsePDF(req.file.buffer);
          periodsToCreate = [{
            label: formatPeriodRange(pdfResult.periodStart, pdfResult.periodEnd, pdfResult.periodType),
            periodType: pdfResult.periodType,
            periodStart: pdfResult.periodStart,
            periodEnd: pdfResult.periodEnd,
            monthsCovered: pdfResult.monthsCovered,
            confirmed: pdfResult.periodConfident,
          }];
          parsedNodes = pdfResult.nodes.map(n => ({ ...n, amounts: [n.amountCents] }));
          errors = pdfResult.errors;
          pageResults = pdfResult.pageResults;
        } catch (error: any) {
          if (error instanceof MultiColumnPDFError) {
            return res.status(422).json({
              error: error.message,
              code: "MULTI_COLUMN_PDF",
              routeTo: "csv",
            });
          }
          throw error;
        }
      } else {
        const fileContent = req.file.buffer.toString('utf-8');
        const csvResult = parseCSV(fileContent);
        periodsToCreate = csvResult.periods.map(p => ({
          label: p.label,
          periodType: p.periodType,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          monthsCovered: p.monthsCovered,
          confirmed: p.confident,
        }));
        parsedNodes = csvResult.nodes;
        errors = csvResult.errors;
      }

      const [newUpload] = await db.insert(uploads).values({
        userId,
        originalFilename: req.file.originalname,
        monthStart: periodsToCreate[0].periodStart,
        status: "parsed",
      }).returning();

      const insertedPeriods = [];
      for (let i = 0; i < periodsToCreate.length; i++) {
        const p = periodsToCreate[i];
        const [row] = await db.insert(periods).values({
          uploadId: newUpload.id,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          periodType: p.periodType,
          monthsCovered: p.monthsCovered,
          label: p.label,
          displayOrder: i,
          confirmed: p.confirmed,
        }).returning();
        insertedPeriods.push(row);
      }

      const tempIdToDbId = new Map<string, string>();

      // What has this user decided about these same lines before? A previous decision of their
      // own beats any keyword guess, so it is applied first and the heuristics only fill gaps.
      const remembered = await lookupRemembered(
        userId,
        parsedNodes
          // Mappable leaves only. A structural header carries no amount in ANY period, cannot
          // be mapped in the UI, and a mapping on one would count toward nothing while
          // inflating the "times applied" figures.
          .filter(n => !n.isRollup && n.amounts.some(a => a !== null && a !== undefined))
          .map(n => ({ label: n.label, sourcePath: n.sourcePath })),
      );
      let rememberedApplied = 0;

      for (const node of parsedNodes) {
        const [insertedNode] = await db.insert(plNodes).values({
          uploadId: newUpload.id,
          parentId: node.parentTempId ? tempIdToDbId.get(node.parentTempId) : null,
          label: node.label,
          level: node.level,
          displayOrder: node.displayOrder,
          isRollup: node.isRollup ? 1 : 0,
          sourcePath: node.sourcePath,
        }).returning();

        tempIdToDbId.set(node.tempId, insertedNode.id);

        for (let i = 0; i < insertedPeriods.length; i++) {
          const amount = node.amounts[i];
          if (amount !== null && amount !== undefined) {
            await db.insert(plNodePeriodAmounts).values({
              nodeId: insertedNode.id,
              periodId: insertedPeriods[i].id,
              amountCents: amount,
            });
          }
        }

        if (!node.isRollup) {
          const mappable = node.amounts.some(a => a !== null && a !== undefined);
          const memory = mappable ? remembered.get(node.sourcePath) : undefined;
          if (memory) {
            rememberedApplied++;
            await db.insert(categoryMappings).values({
              nodeId: insertedNode.id,
              clearpathCategory: memory.category,
              confidence: memory.confidence,
              status: memory.status,
              ruleId: memory.ruleId,
            });
          } else if (node.suggestedCategory) {
            await db.insert(categoryMappings).values({
              nodeId: insertedNode.id,
              clearpathCategory: node.suggestedCategory,
              confidence: node.confidence || "needs_review",
            });
          }
        }
      }

      const response: any = {
        uploadId: newUpload.id,
        filename: newUpload.originalFilename,
        monthStart: newUpload.monthStart,
        periods: insertedPeriods.map(p => ({
          id: p.id,
          label: p.label,
          periodType: p.periodType,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          monthsCovered: p.monthsCovered,
          confirmed: p.confirmed,
        })),
        // Build requirement #2: when the parser couldn't trust its own read of the period, the
        // upload flow must force user confirmation before treating the upload as finalized.
        needsPeriodConfirmation: insertedPeriods.some(p => !p.confirmed),
        nodeCount: parsedNodes.length,
        rememberedCount: rememberedApplied,
        errors,
      };

      if (pageResults) {
        response.pageResults = pageResults;
      }

      res.json(response);
    } catch (error: any) {
      console.error('Upload error:', error);
      res.status(400).json({ error: error.message || "Failed to process file" });
    }
  });

  /**
   * Confirm (and optionally correct) one period's classification. Used when the parser could
   * not trust its own read of the period type/range (build requirement #2) — the Upload flow
   * shows a confirmation step and calls this before treating the upload as finalized. Also
   * usable to correct a wrongly-classified but "confident" guess.
   */
  const confirmPeriodSchema = z.object({
    periodType: z.enum(["month", "quarter", "year_to_date", "annual", "custom", "unknown"]).optional(),
    periodStart: z.string().optional(),
    periodEnd: z.string().optional(),
    monthsCovered: z.number().int().positive().optional(),
  });

  app.post("/api/uploads/:id/periods/:periodId/confirm", requireAuth, async (req, res) => {
    try {
      const { id: uploadId, periodId } = req.params;

      const [owned] = await db.select({ id: uploads.id })
        .from(uploads)
        .where(and(eq(uploads.id, uploadId), eq(uploads.userId, req.user!.id)));
      if (!owned) return res.status(404).json({ error: "Upload not found" });

      const parsed = confirmPeriodSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid period confirmation", details: parsed.error.flatten() });
      }

      const updates: Record<string, any> = { confirmed: true };
      if (parsed.data.periodType) updates.periodType = parsed.data.periodType;
      if (parsed.data.periodStart) updates.periodStart = new Date(parsed.data.periodStart);
      if (parsed.data.periodEnd) updates.periodEnd = new Date(parsed.data.periodEnd);
      if (parsed.data.monthsCovered) updates.monthsCovered = parsed.data.monthsCovered;

      const [updated] = await db.update(periods)
        .set(updates)
        .where(and(eq(periods.id, periodId), eq(periods.uploadId, uploadId)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Period not found" });

      // Keep the display alias in sync with the (possibly now-corrected) first period, per the
      // schema comment on uploads.monthStart: never let it silently disagree with `periods`.
      const uploadPeriods = await getUploadPeriods(uploadId);
      if (uploadPeriods[0]) {
        await db.update(uploads).set({ monthStart: uploadPeriods[0].periodStart }).where(eq(uploads.id, uploadId));
      }

      res.json({ success: true, period: updated });
    } catch (error: any) {
      console.error('Confirm period error:', error);
      res.status(500).json({ error: "Failed to confirm period" });
    }
  });

  app.get("/api/uploads/:id/periods", requireAuth, async (req, res) => {
    try {
      const uploadId = req.params.id;
      const [owned] = await db.select({ id: uploads.id })
        .from(uploads)
        .where(and(eq(uploads.id, uploadId), eq(uploads.userId, req.user!.id)));
      if (!owned) return res.status(404).json({ error: "Upload not found" });

      const uploadPeriods = await getUploadPeriods(uploadId);
      res.json(uploadPeriods);
    } catch (error: any) {
      console.error('Get periods error:', error);
      res.status(500).json({ error: "Failed to fetch periods" });
    }
  });

  app.get("/api/uploads/:id/nodes", requireAuth, async (req, res) => {
    try {
      const uploadId = req.params.id;

      const [upload] = await db.select()
        .from(uploads)
        .where(and(eq(uploads.id, uploadId), eq(uploads.userId, req.user!.id)));

      if (!upload) {
        return res.status(404).json({ error: "Upload not found" });
      }

      // Mapping is per-node, not per-period, but the amount shown on the review screen still
      // needs to come from ONE period — default to the upload's first (chronologically
      // earliest) period; a multi-period upload's client can pass ?periodId= to see another
      // column's amounts against the same mapping.
      const uploadPeriods = await getUploadPeriods(uploadId);
      const requestedPeriodId = typeof req.query.periodId === "string" ? req.query.periodId : undefined;
      const periodId = uploadPeriods.find(p => p.id === requestedPeriodId)?.id ?? uploadPeriods[0]?.id;

      const nodesWithMappings = await db.select({
        id: plNodes.id,
        parentId: plNodes.parentId,
        label: plNodes.label,
        level: plNodes.level,
        displayOrder: plNodes.displayOrder,
        amountCents: plNodePeriodAmounts.amountCents,
        isRollup: plNodes.isRollup,
        sourcePath: plNodes.sourcePath,
        category: categoryMappings.clearpathCategory,
        confidence: categoryMappings.confidence,
        mappingStatus: categoryMappings.status,
        excludedReason: categoryMappings.excludedReason,
        ruleId: categoryMappings.ruleId,
      })
        .from(plNodes)
        .leftJoin(categoryMappings, eq(plNodes.id, categoryMappings.nodeId))
        .leftJoin(plNodePeriodAmounts, and(
          eq(plNodePeriodAmounts.nodeId, plNodes.id),
          periodId ? eq(plNodePeriodAmounts.periodId, periodId) : undefined,
        ))
        .where(eq(plNodes.uploadId, uploadId))
        .orderBy(plNodes.displayOrder);

      const nodes = nodesWithMappings.map(node => ({
        id: node.id,
        parentId: node.parentId,
        label: node.label,
        level: node.level,
        displayOrder: node.displayOrder,
        amountCents: node.amountCents ?? null,
        isRollup: node.isRollup,
        sourcePath: node.sourcePath,
        suggestedCategory: null,
        mappedCategory: node.category,
        confidence: node.confidence,
        // "excluded" is a third state alongside mapped and unmapped. The review UI must show
        // these rows, visibly marked, so the user can see and undo what they took out.
        mappingStatus: node.mappingStatus ?? null,
        excludedReason: node.excludedReason ?? null,
        // Non-null when this mapping came from a previous month's decision rather than the
        // keyword heuristics — the review screen says so, so the user knows why it's pre-filled.
        fromMemory: node.ruleId !== null,
      }));

      res.json({ periodId: periodId ?? null, periods: uploadPeriods, nodes });
    } catch (error: any) {
      console.error('Get nodes error:', error);
      res.status(500).json({ error: "Failed to fetch nodes" });
    }
  });

  app.post("/api/nodes/:id/map", requireAuth, async (req, res) => {
    try {
      const nodeId = req.params.id;

      const parsed = mapNodeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid mapping", details: parsed.error.flatten() });
      }
      const { category, confidence, status, excludedReason, createRule, ruleScope, scopeValue } = parsed.data;

      const nodeWithUpload = await db.select({
        node: plNodes,
        upload: uploads,
      })
        .from(plNodes)
        .innerJoin(uploads, eq(plNodes.uploadId, uploads.id))
        .where(and(eq(plNodes.id, nodeId), eq(uploads.userId, req.user!.id)));
      
      if (nodeWithUpload.length === 0) {
        return res.status(404).json({ error: "Node not found" });
      }

      const { node } = nodeWithUpload[0];

      await db.delete(categoryMappings).where(eq(categoryMappings.nodeId, nodeId));

      await db.insert(categoryMappings).values({
        nodeId,
        clearpathCategory: category as any,
        confidence: (confidence || "medium") as any,
        // Excluding a line is recorded here, as mapping state. It deliberately does NOT
        // rewrite the node's parse-time `isRollup` flag, so the parser's guess and the user's
        // override stay separately legible — and the category is kept, so putting the line
        // back is a one-field change.
        status: (status || "mapped") as any,
        excludedReason: status === "excluded" ? (excludedReason ?? null) : null,
      });

      // Remember it. Every user decision is recorded — including an exclusion, which is as
      // much a decision as a category and recurs every month when a QuickBooks subtotal is the
      // cause. This replaces the old `createRule` flag, which the client never sent, so no rule
      // was ever created and the feature had no effect.
      await recordMappingChoice({
        userId: req.user!.id,
        label: node.label,
        sourcePath: node.sourcePath,
        category: category as any,
        status: (status || "mapped") as any,
      });

      // The old opt-in rule path, kept for any caller that still passes it explicitly.
      if (createRule && ruleScope && scopeValue) {
        await db.insert(rules).values({
          userId: req.user!.id,
          scope: ruleScope,
          scopeValue,
          clearpathCategory: category as any,
          status: (status || "mapped") as any,
          priority: 50,
        }).onConflictDoUpdate({
          target: [rules.userId, rules.scope, rules.scopeValue],
          set: { clearpathCategory: category as any, updatedAt: new Date() },
        });
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error('Map error:', error);
      res.status(500).json({ error: "Failed to save category mapping" });
    }
  });

  /**
   * Mark an upload's mapping as reviewed and confirmed.
   *
   * Two things happen, and they are the same act from the user's point of view: every current
   * mapping is recorded as a remembered choice, and the upload is marked `mapped` so it stops
   * asking to be reviewed.
   *
   * Why this exists rather than recording silently: `POST /api/nodes/:id/map` only fires when
   * the user *changes* a line, so a line where the heuristics guessed right and the user simply
   * agreed was never remembered — and got re-guessed the next month. Measured on two real
   * uploads, only 17 of 39 and 23 of 49 lines had a rule for exactly that reason.
   *
   * Inferring agreement from silence would have meant treating "never looked at" and "looked at
   * and approved" as the same thing, and enshrining unexamined guesses. Making it an explicit
   * action keeps the distinction honest: the user says the mapping is right, and then it is
   * remembered.
   */
  app.post("/api/uploads/:id/confirm", requireAuth, async (req, res) => {
    try {
      const uploadId = req.params.id;

      const [upload] = await db.select()
        .from(uploads)
        .where(and(eq(uploads.id, uploadId), eq(uploads.userId, req.user!.id)));

      if (!upload) {
        return res.status(404).json({ error: "Upload not found" });
      }

      const mapped = await db.select({
        label: plNodes.label,
        sourcePath: plNodes.sourcePath,
        category: categoryMappings.clearpathCategory,
        status: categoryMappings.status,
      })
        .from(plNodes)
        .innerJoin(categoryMappings, eq(plNodes.id, categoryMappings.nodeId))
        .where(and(eq(plNodes.uploadId, uploadId), eq(plNodes.isRollup, 0)));

      let recorded = 0;
      for (const row of mapped) {
        if (row.category === null) continue;
        await recordMappingChoice({
          userId: req.user!.id,
          label: row.label,
          sourcePath: row.sourcePath,
          category: row.category,
          status: row.status ?? "mapped",
        });
        recorded++;
      }

      await db.update(uploads)
        .set({ status: "mapped" })
        .where(eq(uploads.id, uploadId));

      res.json({ success: true, recorded });
    } catch (error: any) {
      console.error('Confirm error:', error);
      res.status(500).json({ error: "Failed to confirm mapping" });
    }
  });

  app.get("/api/uploads/:id/report", requireAuth, async (req, res) => {
    try {
      const uploadId = req.params.id;

      const [upload] = await db.select()
        .from(uploads)
        .where(and(eq(uploads.id, uploadId), eq(uploads.userId, req.user!.id)));

      if (!upload) {
        return res.status(404).json({ error: "Upload not found" });
      }

      const { period, uploadPeriods } = await resolveReportPeriod(uploadId, req);
      if (!period) {
        return res.status(404).json({ error: "This upload has no periods" });
      }

      const metrics = await loadPeriodMetrics(period.id);

      // Build requirement #6: prefer a confirmed YTD/annual upload, else contiguous confirmed
      // Jan-through-current monthly uploads, else this statement's own period — never silently
      // mix partial history.
      const basis = await resolveTieringBasis(req.user!.id, period, metrics);
      const tier = getTier(basis.grossProfit, basis.monthsCovered);
      const benchmarks = getBenchmarks(tier, metrics.fulfillmentPct);
      const variances = calculateVariances(metrics, benchmarks);
      // HVAC scorecard: percentages of REVENUE against the industry report, average and
      // exceptional. Served from here rather than rebuilt in the client, which is how the
      // generic app ended up with two copies of its benchmark table.
      const hvac = scoreHvacMetrics(metrics, basis.monthsCovered);

      // Owner pay inside operating expenses makes a shop's numbers incomparable to benchmarks
      // that exclude it. We don't correct it silently — we surface it and let the owner say.
      const periodNodes = await loadPeriodNodes(period.id);
      const ownerCompInOpex = detectOwnerCompInOpex(
        periodNodes.map((n) => ({
          label: n.label,
          category: n.category,
          amount: n.amountCents === null ? null : n.amountCents / 100,
        })),
      );

      res.json({
        metrics,
        benchmarks,
        variances,
        hvac: { ...hvac, ownerCompInOpex },
        tier,
        // Build requirement #7: the plain-language basis text, e.g. "Monthly P&L annualized
        // from 1 month" / "YTD P&L annualized from 7 months" / "Annual P&L, no annualization
        // applied", plus which source actually fed the tier when it wasn't this statement's
        // own period.
        periodBasis: describePeriodBasis(basis.periodType, basis.monthsCovered, basis.note),
        tieringSource: basis.source,
        period: {
          id: period.id,
          label: period.label,
          periodType: period.periodType,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          monthsCovered: period.monthsCovered,
          confirmed: period.confirmed,
        },
        periods: uploadPeriods.map(p => ({
          id: p.id, label: p.label, periodType: p.periodType, monthsCovered: p.monthsCovered,
          periodStart: p.periodStart, periodEnd: p.periodEnd, confirmed: p.confirmed,
        })),
        upload: {
          monthStart: upload.monthStart,
          filename: upload.originalFilename,
        },
      });
    } catch (error: any) {
      console.error('Report error:', error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  app.delete("/api/uploads/:id", requireAuth, async (req, res) => {
    try {
      const uploadId = req.params.id;
      
      const [upload] = await db.select()
        .from(uploads)
        .where(and(eq(uploads.id, uploadId), eq(uploads.userId, req.user!.id)));
      
      if (!upload) {
        return res.status(404).json({ error: "Upload not found" });
      }
      
      await db.delete(uploads).where(eq(uploads.id, uploadId));
      
      res.json({ success: true });
    } catch (error: any) {
      console.error('Delete error:', error);
      res.status(500).json({ error: "Failed to delete upload" });
    }
  });

  app.get("/api/uploads/:id/export/csv", requireAuth, async (req, res) => {
    try {
      const uploadId = req.params.id;

      const [upload] = await db.select()
        .from(uploads)
        .where(and(eq(uploads.id, uploadId), eq(uploads.userId, req.user!.id)));

      if (!upload) {
        return res.status(404).json({ error: "Upload not found" });
      }

      const { period } = await resolveReportPeriod(uploadId, req);
      if (!period) {
        return res.status(404).json({ error: "This upload has no periods" });
      }

      const metrics = await loadPeriodMetrics(period.id);
      const basis = await resolveTieringBasis(req.user!.id, period, metrics);
      const periodBasisText = describePeriodBasis(basis.periodType, basis.monthsCovered, basis.note);

      const nodesWithMappings = await db.select({
        label: plNodes.label,
        sourcePath: plNodes.sourcePath,
        amountCents: plNodePeriodAmounts.amountCents,
        isRollup: plNodes.isRollup,
        category: categoryMappings.clearpathCategory,
        mappingStatus: categoryMappings.status,
        confidence: categoryMappings.confidence,
      })
        .from(plNodes)
        .innerJoin(plNodePeriodAmounts, and(
          eq(plNodePeriodAmounts.nodeId, plNodes.id),
          eq(plNodePeriodAmounts.periodId, period.id),
        ))
        .leftJoin(categoryMappings, eq(plNodes.id, categoryMappings.nodeId))
        .where(eq(plNodes.uploadId, uploadId))
        .orderBy(plNodes.displayOrder);

      // Build requirement #7: the CSV export states the period basis plainly too, as a comment
      // line before the header row rather than a data column, so it doesn't disturb anyone
      // re-importing the export elsewhere.
      const rows: string[] = [
        `# Period: ${period.label} — ${periodBasisText}`,
        'P&L Category,Source Path,Amount,ClearPath Category,Status',
      ];

      const escapeCSV = (val: string) => {
        if (!val) return '""';
        const escaped = val.replace(/"/g, '""');
        return `"${escaped}"`;
      };

      for (const node of nodesWithMappings) {
        if (node.amountCents !== null && node.isRollup === 0) {
          const excluded = node.mappingStatus === 'excluded';
          rows.push([
            escapeCSV(node.label),
            escapeCSV(node.sourcePath),
            (node.amountCents / 100).toFixed(2),
            // The human-readable label, not the stored enum value — this export is something a
            // person reads, and it has to carry the same category names as every other surface.
            escapeCSV(node.category ? categoryLabel(node.category) : 'Unmapped'),
            excluded
              ? 'Excluded from report'
              : !node.category
                ? 'Needs mapping'
                : node.confidence === 'needs_review'
                  ? 'Needs review'
                  : 'Mapped',
          ].join(','));
        }
      }

      const csv = rows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="clearpath-${formatMonthSlug(period.periodStart)}-remapped.csv"`);
      res.send(csv);
    } catch (error: any) {
      console.error('CSV export error:', error);
      res.status(500).json({ error: "Failed to export CSV" });
    }
  });

  app.get("/api/uploads/:id/export/pdf", requireAuth, async (req, res) => {
    try {
      const uploadId = req.params.id;

      const [upload] = await db.select()
        .from(uploads)
        .where(and(eq(uploads.id, uploadId), eq(uploads.userId, req.user!.id)));

      if (!upload) {
        return res.status(404).json({ error: "Upload not found" });
      }

      const { period } = await resolveReportPeriod(uploadId, req);
      if (!period) {
        return res.status(404).json({ error: "This upload has no periods" });
      }

      const metrics = await loadPeriodMetrics(period.id);
      const basis = await resolveTieringBasis(req.user!.id, period, metrics);
      const tier = getTier(basis.grossProfit, basis.monthsCovered);
      const benchmarks = getBenchmarks(tier, metrics.fulfillmentPct);
      const variances = calculateVariances(metrics, benchmarks);
      const periodBasisText = describePeriodBasis(basis.periodType, basis.monthsCovered, basis.note);
      const periodLabel = formatPeriodRange(period.periodStart, period.periodEnd, period.periodType);

      // The HVAC scorecard, the same one the dashboard shows. This used to build the generic
      // Basecamp report, so the file a buyer took home contradicted the screen they read it on.
      const hvac = scoreHvacMetrics(metrics, basis.monthsCovered);
      const periodNodes = await loadPeriodNodes(period.id);
      const ownerCompInOpex = detectOwnerCompInOpex(
        periodNodes.map((n) => ({
          label: n.label,
          category: n.category,
          amount: n.amountCents === null ? null : n.amountCents / 100,
        })),
      );

      const html = buildHvacReportHtml({
        periodLabel,
        periodBasisText,
        revenue: metrics.revenue ?? null,
        hvac,
        ownerCompInOpex: Boolean(ownerCompInOpex),
      });

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `inline; filename="clearpath-${formatMonthSlug(period.periodStart)}-summary.html"`);
      res.send(html);
    } catch (error: any) {
      console.error('PDF export error:', error);
      res.status(500).json({ error: "Failed to export PDF" });
    }
  });

  /**
   * Phase 2.6 — annual construction. Unlike the routes above, this isn't scoped to one upload:
   * a "full year" or "year-to-date" figure can be built from a confirmed annual/YTD upload, or
   * summed across several monthly uploads, so it's addressed by year + construction mode rather
   * than by uploadId. Reads `resolveAnnualConstruction`, which applies the same "every
   * intervening month present, else name the missing one" rule Phase 2.5 already uses for
   * tiering — see server/lib/rollups.ts.
   */
  function parseAnnualQuery(req: any): { year: number; mode: "full-year" | "ytd" } | null {
    const year = parseInt(req.query.year as string, 10);
    const mode = req.query.mode === "full-year" || req.query.mode === "ytd" ? req.query.mode : undefined;
    if (!year || Number.isNaN(year) || !mode) return null;
    return { year, mode };
  }

  app.get("/api/reports/annual", requireAuth, async (req, res) => {
    try {
      const parsed = parseAnnualQuery(req);
      if (!parsed) {
        return res.status(400).json({ error: "year (number) and mode ('full-year'|'ytd') query parameters are required" });
      }

      const construction = await resolveAnnualConstruction(req.user!.id, parsed.year, parsed.mode);
      if (!construction.available || !construction.metrics) {
        return res.status(404).json({ available: false, reason: construction.reason });
      }

      const tier = getTier(construction.metrics.grossProfit, construction.monthsCovered ?? 1);
      const benchmarks = getBenchmarks(tier, construction.metrics.fulfillmentPct);
      const variances = calculateVariances(construction.metrics, benchmarks);
      // HVAC scorecard: percentages of REVENUE against the industry report, average and
      // exceptional. Served from here rather than rebuilt in the client, which is how the
      // generic app ended up with two copies of its benchmark table.
      const hvac = scoreHvacMetrics(construction.metrics, construction.monthsCovered ?? 1);
      // Build requirement #2: same period-basis phrasing every other surface already uses — no
      // second string-building convention for this one.
      const periodBasis = describePeriodBasis(
        construction.periodType ?? (parsed.mode === "full-year" ? "annual" : "year_to_date"),
        construction.monthsCovered ?? 1,
        construction.note,
      );

      res.json({
        available: true,
        year: parsed.year,
        mode: parsed.mode,
        source: construction.source,
        metrics: construction.metrics,
        benchmarks,
        variances,
        hvac,
        tier,
        periodBasis,
        sourcePeriodIds: construction.sourcePeriodIds,
      });
    } catch (error: any) {
      console.error('Annual report error:', error);
      res.status(500).json({ error: "Failed to generate annual report" });
    }
  });

  app.get("/api/reports/annual/export/csv", requireAuth, async (req, res) => {
    try {
      const parsed = parseAnnualQuery(req);
      if (!parsed) {
        return res.status(400).json({ error: "year (number) and mode ('full-year'|'ytd') query parameters are required" });
      }

      const construction = await resolveAnnualConstruction(req.user!.id, parsed.year, parsed.mode);
      if (!construction.available || !construction.metrics) {
        return res.status(404).json({ error: construction.reason });
      }

      const periodBasisText = describePeriodBasis(
        construction.periodType ?? (parsed.mode === "full-year" ? "annual" : "year_to_date"),
        construction.monthsCovered ?? 1,
        construction.note,
      );
      const escapeCSV = (val: string) => {
        if (!val) return '""';
        return `"${val.replace(/"/g, '""')}"`;
      };
      const fileTag = parsed.mode === "full-year" ? `fy${parsed.year}` : `ytd${parsed.year}`;
      const rows: string[] = [
        `# Period: ${parsed.mode === "full-year" ? `FY${parsed.year}` : `YTD ${parsed.year}`} — ${periodBasisText}`,
      ];

      if (construction.sourcePeriodIds.length === 1) {
        // Backed by one real period (a confirmed annual/YTD upload) — export its actual line
        // items, exactly like the per-upload CSV export.
        const [periodId] = construction.sourcePeriodIds;
        const nodesWithMappings = await db.select({
          label: plNodes.label,
          sourcePath: plNodes.sourcePath,
          amountCents: plNodePeriodAmounts.amountCents,
          isRollup: plNodes.isRollup,
          category: categoryMappings.clearpathCategory,
          mappingStatus: categoryMappings.status,
          confidence: categoryMappings.confidence,
        })
          .from(plNodes)
          .innerJoin(plNodePeriodAmounts, and(
            eq(plNodePeriodAmounts.nodeId, plNodes.id),
            eq(plNodePeriodAmounts.periodId, periodId),
          ))
          .leftJoin(categoryMappings, eq(plNodes.id, categoryMappings.nodeId))
          .orderBy(plNodes.displayOrder);

        rows.push('P&L Category,Source Path,Amount,ClearPath Category,Status');
        for (const node of nodesWithMappings) {
          if (node.amountCents !== null && node.isRollup === 0) {
            const excluded = node.mappingStatus === 'excluded';
            rows.push([
              escapeCSV(node.label),
              escapeCSV(node.sourcePath),
              (node.amountCents / 100).toFixed(2),
              escapeCSV(node.category ? categoryLabel(node.category) : 'Unmapped'),
              excluded
                ? 'Excluded from report'
                : !node.category
                  ? 'Needs mapping'
                  : node.confidence === 'needs_review'
                    ? 'Needs review'
                    : 'Mapped',
            ].join(','));
          }
        }
      } else {
        // A constructed sum across several monthly uploads' own pl_nodes, which aren't a single
        // unified line-item list — export category totals instead, and say so, rather than
        // presenting summary rows as if they were individual P&L lines.
        rows.push('# Constructed from multiple monthly uploads — category totals below, not individual P&L line items.');
        rows.push('ClearPath Category,Amount');
        const m = construction.metrics;
        const categoryRows: [string, number][] = [
          ['Revenue', m.revenue],
          ['Fulfillment — COGS', m.fulfillmentCogs],
          ['Fulfillment — Services', m.fulfillmentServices],
          ['Gross Profit', m.grossProfit],
          ['Customer Acquisition (CAC)', m.cac],
          ['OpEx Systems', m.opexSystems],
          ['OpEx People', m.opexPeople],
          ['Operational Net Profit', m.operationalNetProfit],
          ['Ascent Moves / Tax Strategy', m.taxStrategy],
          ['Taxable Net Profit', m.taxableNetProfit],
        ];
        for (const [label, value] of categoryRows) {
          rows.push(`${escapeCSV(label)},${value.toFixed(2)}`);
        }
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="clearpath-${fileTag}-remapped.csv"`);
      res.send(rows.join('\n'));
    } catch (error: any) {
      console.error('Annual CSV export error:', error);
      res.status(500).json({ error: "Failed to export annual CSV" });
    }
  });

  app.get("/api/reports/annual/export/pdf", requireAuth, async (req, res) => {
    try {
      const parsed = parseAnnualQuery(req);
      if (!parsed) {
        return res.status(400).json({ error: "year (number) and mode ('full-year'|'ytd') query parameters are required" });
      }

      const construction = await resolveAnnualConstruction(req.user!.id, parsed.year, parsed.mode);
      if (!construction.available || !construction.metrics) {
        return res.status(404).json({ error: construction.reason });
      }

      const tier = getTier(construction.metrics.grossProfit, construction.monthsCovered ?? 1);
      const benchmarks = getBenchmarks(tier, construction.metrics.fulfillmentPct);
      const variances = calculateVariances(construction.metrics, benchmarks);
      const periodBasisText = describePeriodBasis(
        construction.periodType ?? (parsed.mode === "full-year" ? "annual" : "year_to_date"),
        construction.monthsCovered ?? 1,
        construction.note,
      );
      const periodLabel = parsed.mode === "full-year" ? `FY${parsed.year}` : `YTD ${parsed.year}`;
      const fileTag = parsed.mode === "full-year" ? `fy${parsed.year}` : `ytd${parsed.year}`;

      const hvac = scoreHvacMetrics(construction.metrics, construction.monthsCovered ?? 12);

      const html = buildHvacReportHtml({
        periodLabel,
        periodBasisText,
        revenue: construction.metrics.revenue ?? null,
        hvac,
      });

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `inline; filename="clearpath-${fileTag}-summary.html"`);
      res.send(html);
    } catch (error: any) {
      console.error('Annual PDF export error:', error);
      res.status(500).json({ error: "Failed to export annual PDF" });
    }
  });

  /**
   * Purge this account's financial data.
   *
   * Deletes uploads (cascading to pl_nodes, category_mappings and reports) and, unless the
   * caller asks to keep them, the remembered mapping choices in `rules`.
   *
   * Deliberately NOT deleted, and these are not oversights:
   *   - the account and its email address. Purging financial data is not account deletion and
   *     must never be conflated with it, nor with opting out of contact — those are separate
   *     actions the user takes separately.
   *   - `login_tokens`. They are auth artefacts rather than financial data, so the user stays
   *     signed in through a purge. (Note for whoever builds account deletion later: that table
   *     is keyed by *email*, not user_id, so a delete-by-user_id sweep would silently miss it.)
   */
  app.delete("/api/account/data", requireSignedIn, async (req, res) => {
    try {
      const userId = req.user!.id;
      const keepRules = req.query.keepRules === "true";

      const userUploads = await db.select({ id: uploads.id })
        .from(uploads)
        .where(eq(uploads.userId, userId));

      // Everything below an upload cascades from it, so one delete is enough.
      await db.delete(uploads).where(eq(uploads.userId, userId));

      let rulesDeleted = 0;
      if (!keepRules) {
        const removed = await db.delete(rules)
          .where(eq(rules.userId, userId))
          .returning({ id: rules.id });
        rulesDeleted = removed.length;
      }

      res.json({
        success: true,
        uploadsDeleted: userUploads.length,
        rulesDeleted,
        rulesKept: keepRules,
      });
    } catch (error: any) {
      console.error('Purge error:', error);
      res.status(500).json({ error: "Failed to purge data" });
    }
  });

  /**
   * Phase 2.7 — Compare reports expansion.
   *
   * Three ways to ask for a comparison:
   *   - `mode=mom|qoq|ytd` — one of the three default lenses, computed from whatever periods
   *     already exist for this user (server/lib/rollups.ts: resolveMonthOverMonth /
   *     resolveRollingQuarterOverQuarter / resolveYtdOverYtd). No period selection needed.
   *   - `periodIds=<id>,<id>,...` (2 or more) — the expanded manual picker (build requirement
   *     #3): any two-or-more periods a user has confirmed, spanning one or several uploads, for
   *     a multi-period trend view rather than only a pairwise one.
   *   - `uploadIds=<id>,<id>,...` (legacy) — kept for backward compatibility, but FIXED (build
   *     requirement #1): every confirmed period belonging to each requested upload is now
   *     included, not just the upload's first/earliest period. A multi-period 11-month QBO
   *     upload used to silently compare against just its January column; now every one of its
   *     11 months participates.
   *
   * Every period, however it was selected, is read through `loadPeriodMetrics` /
   * `loadMultiPeriodMetrics` — the single consolidated rollup (build requirement #5/#6) — so the
   * 100%-of-Gross-Profit invariant and exclude-from-report behavior hold here exactly as they do
   * on the report screen and both exports.
   */
  app.get("/api/comparisons", requireAuth, async (req, res) => {
    try {
      const modeParam = typeof req.query.mode === "string" ? req.query.mode : undefined;
      let resolvedMode: "mom" | "qoq" | "ytd" | "custom" = "custom";
      let comparisonPeriods: ComparisonPeriodResult[];

      if (modeParam === "mom" || modeParam === "qoq" || modeParam === "ytd") {
        resolvedMode = modeParam;
        const result: ComparisonModeResult =
          modeParam === "mom" ? await resolveMonthOverMonth(req.user!.id)
          : modeParam === "qoq" ? await resolveRollingQuarterOverQuarter(req.user!.id)
          : await resolveYtdOverYtd(req.user!.id);

        if (!result.available || !result.periods) {
          return res.status(404).json({ available: false, mode: resolvedMode, reason: result.reason });
        }
        comparisonPeriods = result.periods;
      } else {
        const periodIdsParam = req.query.periodIds as string | undefined;
        const uploadIdsParam = req.query.uploadIds as string | undefined;
        let requestedPeriodIds: string[] = [];

        if (periodIdsParam) {
          requestedPeriodIds = periodIdsParam.split(',').map(s => s.trim()).filter(Boolean);
        } else if (uploadIdsParam) {
          const uploadIds = uploadIdsParam.split(',').map(s => s.trim()).filter(Boolean);
          const userUploads = await db.select().from(uploads).where(eq(uploads.userId, req.user!.id));
          const userUploadIds = new Set(userUploads.map(u => u.id));
          const validUploadIds = uploadIds.filter(id => userUploadIds.has(id));

          for (const uploadId of validUploadIds) {
            const uploadPeriods = await getUploadPeriods(uploadId);
            // The bug fix: every confirmed period of this upload, not just periods[0].
            for (const p of uploadPeriods) {
              if (p.confirmed) requestedPeriodIds.push(p.id);
            }
          }
        } else {
          return res.status(400).json({ error: "periodIds or uploadIds query parameter required (or mode=mom|qoq|ytd)" });
        }

        if (requestedPeriodIds.length < 2) {
          return res.status(400).json({ error: "At least 2 periods are required for comparison" });
        }

        // Ownership check: every requested period must belong to an upload owned by this user.
        const ownedRows = await db
          .select({ period: periods, ownerUserId: uploads.userId })
          .from(periods)
          .innerJoin(uploads, eq(periods.uploadId, uploads.id))
          .where(inArray(periods.id, requestedPeriodIds));

        const ownPeriods = ownedRows
          .filter(r => r.ownerUserId === req.user!.id)
          .map(r => r.period);

        if (ownPeriods.length < 2) {
          return res.status(400).json({ error: "At least 2 valid periods you own are required for comparison" });
        }

        ownPeriods.sort((a, b) => new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime());

        comparisonPeriods = await Promise.all(ownPeriods.map(async (p): Promise<ComparisonPeriodResult> => {
          const metrics = await loadPeriodMetrics(p.id);
          const basis = await resolveTieringBasis(req.user!.id, p, metrics);
          return {
            periodId: p.id,
            uploadId: p.uploadId,
            sourcePeriodIds: [p.id],
            periodLabel: formatPeriodRange(p.periodStart, p.periodEnd, p.periodType),
            periodBasis: describePeriodBasis(basis.periodType, basis.monthsCovered, basis.note),
            monthsCovered: p.monthsCovered,
            periodType: p.periodType,
            metrics,
            periodEnd: new Date(p.periodEnd),
          };
        }));
      }

      comparisonPeriods = [...comparisonPeriods].sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime());

      const comparisons: {
        fromUploadId: string | null;
        toUploadId: string | null;
        fromLabel: string;
        toLabel: string;
        deltas: Record<string, { amountDelta: number; allocationDelta: number | null }>;
        variances: ReturnType<typeof calculateComparisonVariances>;
      }[] = [];

      for (let i = 1; i < comparisonPeriods.length; i++) {
        const prev = comparisonPeriods[i - 1];
        const curr = comparisonPeriods[i];

        const deltas: Record<string, { amountDelta: number; allocationDelta: number | null }> = {};
        for (const cat of METRIC_ORDER) {
          const prevAmt = (prev.metrics as any)[cat] ?? 0;
          const currAmt = (curr.metrics as any)[cat] ?? 0;
          const pctKey = `${cat}Pct`;
          const prevPct = (prev.metrics as any)[pctKey];
          const currPct = (curr.metrics as any)[pctKey];

          deltas[cat] = {
            amountDelta: currAmt - prevAmt,
            allocationDelta: currPct !== null && prevPct !== null ? currPct - prevPct : null,
          };
        }

        comparisons.push({
          fromUploadId: prev.uploadId,
          toUploadId: curr.uploadId,
          fromLabel: prev.periodLabel,
          toLabel: curr.periodLabel,
          deltas,
          // Build requirement #4 decision (logged in the PRD Decisions Log, 2026-09-06): an
          // N-period trend view flags variance against BOTH the immediately preceding period
          // (here) and the first period in the view (`variancesVsFirst` below). For a 2-period
          // comparison — every default mode, or a manual 2-period pick — the two are identical,
          // so nothing is duplicated; for 3+ periods neither reading subsumes the other (a small
          // month-over-month move can still be a large drift from where the trend started, and
          // vice versa), so both are computed rather than picking one arbitrarily.
          variances: calculateComparisonVariances(prev.metrics, curr.metrics, prev.periodLabel, curr.periodLabel),
        });
      }

      const variancesVsFirst = comparisonPeriods.length > 2
        ? comparisonPeriods.slice(1).map((p) => ({
            fromLabel: comparisonPeriods[0].periodLabel,
            toLabel: p.periodLabel,
            variances: calculateComparisonVariances(comparisonPeriods[0].metrics, p.metrics, comparisonPeriods[0].periodLabel, p.periodLabel),
          }))
        : [];

      res.json({
        mode: resolvedMode,
        periods: comparisonPeriods.map(p => ({
          uploadId: p.uploadId,
          periodId: p.periodId,
          sourcePeriodIds: p.sourcePeriodIds,
          periodLabel: p.periodLabel,
          periodBasis: p.periodBasis,
          periodEnd: p.periodEnd,
          metrics: p.metrics,
        })),
        comparisons,
        variancesVsFirst,
      });
    } catch (error: any) {
      console.error('Comparison error:', error);
      res.status(500).json({ error: "Failed to generate comparison" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

