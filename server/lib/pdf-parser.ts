import { GoogleGenAI } from "@google/genai";
import { pdfToPng } from "pdf-to-png-converter";
import type { ClearpathCategory, ConfidenceLevel, PeriodType } from "@shared/schema";
import { CATEGORY_ORDER } from "@shared/categories";
import { monthStartUTC, endOfMonthUTC, monthsBetweenUTC } from "@shared/period";

/**
 * Thrown when the PDF visibly contains more than one period column (e.g. a table with
 * "Jan 2026 | Feb 2026 | Mar 2026" headers). Phase 2.5 scope decision: PDF multi-column
 * extraction is out of scope — the UI must route the user to CSV upload instead of producing a
 * misleading single-period report from a multi-period statement.
 */
export class MultiColumnPDFError extends Error {
  constructor(message: string = "This PDF appears to show more than one reporting period side by side. Please upload the CSV export instead so every period can be captured correctly.") {
    super(message);
    this.name = "MultiColumnPDFError";
  }
}

const GEMINI_MODEL = "gemini-2.5-flash";

// Built on first use, not at import time: PDF parsing is the only feature that needs a
// model, so a missing key must fail that one upload rather than take the whole server
// down at boot (sign-in and CSV uploads don't touch this).
let geminiClient: GoogleGenAI | null = null;

function gemini(): GoogleGenAI {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY must be set to read a PDF P&L. CSV uploads do not require it.",
      );
    }
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

export interface PlNode {
  tempId: string;
  label: string;
  level: number;
  displayOrder: number;
  amountCents: number | null;
  isRollup: boolean;
  parentTempId?: string;
  sourcePath: string;
  suggestedCategory?: ClearpathCategory;
  confidence?: ConfidenceLevel;
}

export interface PDFParseResult {
  nodes: PlNode[];
  monthStart: Date;
  periodType: PeriodType;
  periodStart: Date;
  periodEnd: Date;
  monthsCovered: number;
  /** False when the period classification is a guess rather than a read date — the upload flow
   *  must force user confirmation before finalizing the upload (build requirement #2). */
  periodConfident: boolean;
  errors: string[];
  pageResults: PageResult[];
}

interface PageResult {
  page: number;
  itemCount: number;
  success: boolean;
  error?: string;
}

interface ParsedLineItem {
  label: string;
  amount: number;
  category: string;
  isTotal: boolean;
  level: number;
}

// Rasterizes in-process with pdf-to-png-converter (already a dependency).
//
// This used to shell out to `pdftoppm` and stage files in a hardcoded `/tmp/`. Both
// were Replit-environment assumptions: poppler-utils isn't in Railway's build image, and
// `/tmp` isn't a path on Windows — so PDF uploads would have failed in production and
// during local development, whatever model read the pages. No subprocess, no temp
// directory to leak, and nothing to install at the OS level.
async function convertPdfToImages(pdfBuffer: Buffer): Promise<Buffer[]> {
  // 2.0 renders ~144dpi. Verified legible to the model on a real QuickBooks P&L export;
  // raising it costs image tokens on every page.
  const pages = await pdfToPng(pdfBuffer, { viewportScale: 2.0 });
  // The library types `content` as optional; drop any page that produced no bitmap
  // rather than handing a hole to the model.
  const buffers = pages
    .map((page) => page.content)
    .filter((content): content is Buffer => Boolean(content));

  console.log(`PDF conversion produced ${buffers.length} images, sizes: ${buffers.map(b => b.length).join(', ')} bytes`);

  return buffers;
}

function validateLineItem(item: any): item is ParsedLineItem {
  if (typeof item !== 'object' || item === null) return false;
  if (typeof item.label !== 'string' || !item.label.trim()) return false;
  if (typeof item.amount !== 'number' || isNaN(item.amount)) {
    if (typeof item.amount === 'string') {
      const parsed = parseFloat(item.amount.replace(/[$,()]/g, ''));
      if (!isNaN(parsed)) {
        item.amount = parsed;
      } else {
        item.amount = 0;
      }
    } else {
      item.amount = 0;
    }
  }
  if (typeof item.level !== 'number' || item.level < 0) {
    item.level = 0;
  }
  if (item.level > 5) {
    item.level = 5;
  }
  if (typeof item.isTotal !== 'boolean') {
    const label = (item.label || '').toLowerCase();
    item.isTotal = label.includes('total') || 
                   label.includes('net ') || 
                   label.startsWith('gross') ||
                   label === 'net income' ||
                   label === 'net operating income' ||
                   label === 'net other income';
  }
  if (typeof item.category !== 'string') {
    item.category = 'unknown';
  }
  return true;
}

function isSectionHeader(label: string, amount: number): boolean {
  const normalizedLabel = label.toLowerCase().trim();
  const headerPatterns = [
    /^income$/,
    /^expenses?$/,
    /^other income$/,
    /^other expenses?$/,
    /^cost of (?:goods )?sold$/,
    /^operating (?:income|expenses?)$/,
  ];
  
  return amount === 0 && headerPatterns.some(pattern => pattern.test(normalizedLabel));
}

function normalizeHierarchyLevels(items: ParsedLineItem[]): ParsedLineItem[] {
  if (items.length === 0) return items;
  
  let currentLevel = 0;
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    
    if (item.level > currentLevel + 1) {
      item.level = currentLevel + 1;
    }
    
    if (item.isTotal) {
      currentLevel = Math.max(0, currentLevel - 1);
      item.level = currentLevel;
    } else {
      currentLevel = item.level;
    }
  }
  
  return items;
}

export function normalizePdfAmountForCategory(amount: number, category: ClearpathCategory | undefined): number {
  if (!category) return amount;
  return category === "revenue" ? Math.abs(amount) : -Math.abs(amount);
}

async function extractPLDataFromImage(
  imageBuffer: Buffer, 
  pageNumber: number,
  retryCount: number = 0
): Promise<ParsedLineItem[]> {
  const base64Image = imageBuffer.toString("base64");

  try {
    const response = await gemini().models.generateContent({
      model: GEMINI_MODEL,
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        systemInstruction: `You are a financial document parser. Extract ALL line items from this Profit & Loss statement image.

For EACH line item with a dollar amount, output a JSON object with these exact fields:
{
  "label": "Account name as shown",
  "amount": 1234.56,
  "category": "unknown",
  "isTotal": false,
  "level": 0
}

Field rules:
- label: The account/category name exactly as displayed
- amount: Dollar amount as a plain number (no $ or commas). Use negative for expenses, positive for income. For amounts like "(1,234.56)" treat as negative.
- category: One of: revenue, fulfillment_cogs, fulfillment_services, cac, opex_systems, opex_people, tax_strategy, unknown
- isTotal: true ONLY if the label contains "Total", "Net Income", "Net Operating", or "Gross Profit"
- level: 0 for section headers (Income, Expenses), 1 for line items, 2 for sub-items

Category hints:
- revenue: Income, Sales, Service Revenue, Dividend Income, Interest
- fulfillment_cogs: the direct MATERIALS/goods cost of what was sold - Cost of Goods Sold,
  Materials, Supplies, Inventory, Parts, Freight, Shipping, Packaging, Merchant/processing fees
- fulfillment_services: the direct LABOR cost of delivering the work - Subcontractors,
  Contract Labor, Installers, Technicians, Crew wages, Outsourced delivery, Freelancers.
  Delivery labor belongs here even if the P&L files it under payroll.
- cac: what was spent to WIN the customer - Marketing, Advertising, Ad spend, Sales commissions
- opex_systems: fixed overhead that runs regardless of customer volume - Software,
  Subscriptions, Rent, Utilities, Insurance, Telephone, Bank/legal/professional fees
- opex_people: admin/support/leadership salaries, EXCLUDING the owner and excluding delivery
  labor - Payroll, Salaries, Wages, Benefits, Payroll taxes
- tax_strategy: money heading to the OWNER, or a tax-strategy move - Owner draws,
  Distributions, Shareholder/member draws, Guaranteed payments, Dividends, Retirement/401k/SEP
  contributions, Accountable plan reimbursements, Augusta Rule rent, corporate income tax.
  NOT sales tax and NOT payroll tax - those are operating costs.

If a line is a delivery cost but you cannot tell materials from labor, use fulfillment_cogs.
If you cannot place a line at all, use unknown rather than guessing.

IMPORTANT: Return ONLY a valid JSON array. No markdown, no explanation, just the array.
Example: [{"label":"Income","amount":0,"category":"revenue","isTotal":false,"level":0}]`,
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Parse this P&L statement page ${pageNumber}. Extract all financial line items with their amounts and categories.`,
            },
            {
              inlineData: {
                mimeType: "image/png",
                data: base64Image,
              },
            },
          ],
        },
      ],
    });

    const content = response.text || "[]";
    
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.slice(7);
    }
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith("```")) {
      jsonStr = jsonStr.slice(0, -3);
    }
    
    const parsed = JSON.parse(jsonStr.trim());
    
    if (!Array.isArray(parsed)) {
      throw new Error("Response is not an array");
    }
    
    const validItems: ParsedLineItem[] = [];
    for (const item of parsed) {
      if (validateLineItem(item)) {
        validItems.push(item);
      }
    }
    
    return normalizeHierarchyLevels(validItems);
    
  } catch (error) {
    console.error(`Failed to parse Gemini response for page ${pageNumber}:`, error);
    
    if (retryCount < 2) {
      console.log(`Retrying page ${pageNumber} (attempt ${retryCount + 2})...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return extractPLDataFromImage(imageBuffer, pageNumber, retryCount + 1);
    }
    
    return [];
  }
}

interface PeriodClassification {
  periodType: PeriodType;
  periodStart: Date;
  periodEnd: Date;
  monthsCovered: number;
  confident: boolean;
  multiColumn: boolean;
}

interface RawPeriodResponse {
  periodType?: string;
  periodStart?: string;
  periodEnd?: string;
  multiColumn?: boolean;
  confident?: boolean;
}

/**
 * Ask Gemini to classify the statement's period type and range, and — per the Phase 2.5 scope
 * decision — to notice whether the page visibly shows MORE THAN ONE period column (a table with
 * "Jan 2026 | Feb 2026 | Mar 2026" headers, say). PDF multi-column extraction is out of scope
 * this phase; `parsePDF` throws `MultiColumnPDFError` when this comes back true so the upload
 * flow can route the user to CSV instead of silently reading only the first column.
 */
async function classifyPeriodFromImages(imageBuffers: Buffer[]): Promise<PeriodClassification> {
  const fallback: PeriodClassification = {
    periodType: "unknown",
    periodStart: new Date(),
    periodEnd: new Date(),
    monthsCovered: 1,
    confident: false,
    multiColumn: false,
  };

  if (imageBuffers.length === 0) return fallback;

  const base64Image = imageBuffers[0].toString("base64");

  try {
    const response = await gemini().models.generateContent({
      model: GEMINI_MODEL,
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        // Classification needs a little reasoning (distinguishing YTD from a custom range from
        // an annual statement isn't a pure lookup the way a single date was), so thinking is
        // left on here, unlike the old date-only call.
        systemInstruction: `You are reading the header/title area of a Profit & Loss statement page to determine its REPORTING PERIOD.

Return ONLY a JSON object with these fields:
{
  "periodType": "month" | "quarter" | "year_to_date" | "annual" | "custom" | "unknown",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "multiColumn": true | false,
  "confident": true | false
}

Field rules:
- periodType: "month" for a single calendar month; "quarter" for a 3-month quarter; "annual" for
  a full calendar/fiscal year (Jan 1 - Dec 31, or a "FY2026" style annual statement);
  "year_to_date" for a range starting in January but ending before December of the same year;
  "custom" for any other range (e.g. a mid-year-to-mid-year range); "unknown" if you cannot tell.
- periodStart / periodEnd: the first and last calendar day the statement covers, ISO format.
- multiColumn: true if the LINE-ITEM TABLE ITSELF (not just the title) shows more than one
  amount column per line — e.g. separate "Jan 2026" / "Feb 2026" / "Mar 2026" columns, or a
  "Total" column alongside individual month columns. false if there is exactly one amount
  column per line item.
- confident: false if the period is genuinely ambiguous (no clear date range visible anywhere on
  the page) rather than guessed.

Return ONLY the JSON object, no markdown, no explanation.`,
      },
      contents: [
        {
          role: "user",
          parts: [
            { text: "Classify this P&L statement's reporting period." },
            { inlineData: { mimeType: "image/png", data: base64Image } },
          ],
        },
      ],
    });

    let jsonStr = (response.text || "{}").trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
    }
    const parsed: RawPeriodResponse = JSON.parse(jsonStr);

    const validTypes: PeriodType[] = ["month", "quarter", "year_to_date", "annual", "custom", "unknown"];
    const periodType: PeriodType = validTypes.includes(parsed.periodType as PeriodType)
      ? (parsed.periodType as PeriodType)
      : "unknown";

    const start = parsed.periodStart ? new Date(parsed.periodStart) : null;
    const end = parsed.periodEnd ? new Date(parsed.periodEnd) : null;

    if (!start || isNaN(start.getTime()) || !end || isNaN(end.getTime())) {
      return { ...fallback, multiColumn: Boolean(parsed.multiColumn) };
    }

    const periodStart = monthStartUTC(start.getUTCFullYear(), start.getUTCMonth());
    const periodEnd = endOfMonthUTC(end.getUTCFullYear(), end.getUTCMonth());
    const monthsCovered = monthsBetweenUTC(periodStart, periodEnd);

    return {
      periodType,
      periodStart,
      periodEnd,
      monthsCovered,
      confident: parsed.confident !== false && periodType !== "unknown",
      multiColumn: Boolean(parsed.multiColumn),
    };
  } catch (error) {
    console.error("Failed to classify period from PDF:", error);
    return fallback;
  }
}

function convertToPlNodes(lineItems: ParsedLineItem[]): PlNode[] {
  const nodes: PlNode[] = [];
  let nextId = 1;
  
  const levelStack: { tempId: string; label: string; level: number }[] = [];

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    
    while (levelStack.length > 0 && levelStack[levelStack.length - 1].level >= item.level) {
      levelStack.pop();
    }

    const parentTempId = levelStack.length > 0 ? levelStack[levelStack.length - 1].tempId : undefined;
    
    const tempId = `temp_${nextId++}`;
    
    const pathParts = levelStack.map((s) => s.label);
    pathParts.push(item.label);
    const sourcePath = pathParts.join(" > ");

    let suggestedCategory: ClearpathCategory | undefined;
    let confidence: ConfidenceLevel | undefined;

    if (!item.isTotal && item.amount !== 0) {
      if (CATEGORY_ORDER.includes(item.category as ClearpathCategory)) {
        suggestedCategory = item.category as ClearpathCategory;
        // The COGS/Services distinction is the one the model is least reliable on - it depends
        // on business context a single P&L page doesn't carry - so send it to the review
        // screen rather than presenting it as settled.
        confidence =
          suggestedCategory === "fulfillment_cogs" || suggestedCategory === "fulfillment_services"
            ? "needs_review"
            : "medium";
      }
    }

    const isHeader = item.level === 0 && isSectionHeader(item.label, item.amount);
    
    const normalizedAmount = normalizePdfAmountForCategory(item.amount, suggestedCategory);

    const amountCents = isHeader 
      ? null 
      : (normalizedAmount !== null && normalizedAmount !== undefined
          ? Math.round(normalizedAmount * 100)
          : null);

    nodes.push({
      tempId,
      label: item.label,
      level: item.level,
      displayOrder: i,
      amountCents,
      isRollup: item.isTotal,
      parentTempId,
      sourcePath,
      suggestedCategory: isHeader ? undefined : suggestedCategory,
      confidence: isHeader ? undefined : confidence,
    });

    if (!item.isTotal) {
      levelStack.push({ tempId, label: item.label, level: item.level });
    }
  }

  return nodes;
}

export async function parsePDF(pdfBuffer: Buffer): Promise<PDFParseResult> {
  const errors: string[] = [];
  const pageResults: PageResult[] = [];
  
  console.log("Converting PDF to images...");
  const imageBuffers = await convertPdfToImages(pdfBuffer);
  console.log(`Converted ${imageBuffers.length} pages`);
  
  if (imageBuffers.length === 0) {
    throw new Error("No pages found in PDF");
  }

  console.log("Classifying reporting period from PDF...");
  const periodClassification = await classifyPeriodFromImages(imageBuffers);

  if (periodClassification.multiColumn) {
    throw new MultiColumnPDFError();
  }

  console.log("Extracting P&L data from images...");
  const allLineItems: ParsedLineItem[] = [];
  
  for (let i = 0; i < imageBuffers.length; i++) {
    const pageNum = i + 1;
    try {
      console.log(`Processing page ${pageNum}...`);
      const pageItems = await extractPLDataFromImage(imageBuffers[i], pageNum);
      
      if (pageItems.length > 0) {
        allLineItems.push(...pageItems);
        pageResults.push({ page: pageNum, itemCount: pageItems.length, success: true });
      } else {
        const msg = `Page ${pageNum}: No line items extracted`;
        errors.push(msg);
        pageResults.push({ page: pageNum, itemCount: 0, success: false, error: msg });
      }
    } catch (error) {
      const errMsg = `Page ${pageNum}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(errMsg);
      errors.push(errMsg);
      pageResults.push({ page: pageNum, itemCount: 0, success: false, error: errMsg });
    }
  }

  const successfulPages = pageResults.filter(p => p.success).length;
  
  if (allLineItems.length === 0) {
    throw new Error(`No P&L data could be extracted from the PDF. ${errors.length > 0 ? 'Errors: ' + errors.join('; ') : ''}`);
  }

  console.log(`Extracted ${allLineItems.length} line items from ${successfulPages}/${imageBuffers.length} pages`);
  const nodes = convertToPlNodes(allLineItems);

  return {
    nodes,
    // Backward-compatible display value: the calendar month containing periodStart. Real
    // tiering/reporting must read periodStart/periodEnd/periodType/monthsCovered, not this.
    monthStart: periodClassification.periodStart,
    periodType: periodClassification.periodType,
    periodStart: periodClassification.periodStart,
    periodEnd: periodClassification.periodEnd,
    monthsCovered: periodClassification.monthsCovered,
    periodConfident: periodClassification.confident,
    errors,
    pageResults,
  };
}
