import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowUp, ArrowDown, Minus, TrendingUp, ArrowLeft, AlertTriangle } from "lucide-react";
import { formatMonthLong } from "@shared/period";
import { METRIC_LABELS, METRIC_ORDER } from "@shared/categories";
import { ExplainerPopover } from "@/components/ExplainerPopover";
import { CATEGORY_EXPLAINERS, METRIC_EXPLAINERS } from "@/lib/category-explainers";

interface UploadPeriod {
  id: string;
  label: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  monthsCovered: number;
  confirmed: boolean;
  displayOrder: number;
}

interface Upload {
  id: string;
  filename: string;
  monthStart: string;
  uploadedAt: string;
  status: string;
  periods: UploadPeriod[];
}

interface PeriodMetrics {
  revenue: number;
  fulfillmentCogs: number;
  fulfillmentServices: number;
  fulfillment: number;
  fulfillmentPct: number | null;
  grossProfit: number;
  cac: number;
  cacPct: number | null;
  opexSystems: number;
  opexSystemsPct: number | null;
  opexPeople: number;
  opexPeoplePct: number | null;
  operationalNetProfit: number;
  operationalNetProfitPct: number | null;
  taxStrategy: number;
  taxStrategyPct: number | null;
  taxableNetProfit: number;
  taxableNetProfitPct: number | null;
}

interface ComparisonPeriod {
  uploadId: string | null;
  periodId: string | null;
  sourcePeriodIds?: string[];
  periodLabel: string;
  periodBasis?: string;
  metrics: PeriodMetrics;
}

interface ComparisonVariance {
  category: string;
  categoryLabel: string;
  fromLabel: string;
  toLabel: string;
  baselineAmount: number;
  currentAmount: number;
  amountDelta: number;
  percentDelta: number | null;
}

interface ComparisonResponse {
  mode: "mom" | "qoq" | "ytd" | "custom";
  periods: ComparisonPeriod[];
  comparisons: {
    fromUploadId: string | null;
    toUploadId: string | null;
    fromLabel: string;
    toLabel: string;
    deltas: Record<string, { amountDelta: number; allocationDelta: number | null }>;
    variances: ComparisonVariance[];
  }[];
  variancesVsFirst: { fromLabel: string; toLabel: string; variances: ComparisonVariance[] }[];
}

// This page used to carry its own third copy of the category list, which is how it ended up
// showing "Owner's Pay" and "Taxes" long after the model changed. It now reads the shared one.
const CATEGORY_LABELS = METRIC_LABELS;
const CATEGORY_ORDER = METRIC_ORDER;

// Explainer lookup keyed to METRIC_ORDER's camelCase keys, reusing the same copy 3.2/3.3 already
// wire in (`CATEGORY_EXPLAINERS`/`METRIC_EXPLAINERS`, both from Phase 3.1) — no new content here.
// "fulfillment" (the combined total) and "grossProfit" are left out on purpose, same as 3.3's
// StoplightMeter: neither is one of the seven mappable categories or two headline metrics, and
// the rows directly above/below each cover the same ground per-category.
const EXPLAINER_LOOKUP: Partial<Record<(typeof METRIC_ORDER)[number], { label: string; body: string }>> = {
  revenue: { label: CATEGORY_LABELS.revenue, body: CATEGORY_EXPLAINERS.revenue.body },
  fulfillmentCogs: { label: CATEGORY_LABELS.fulfillmentCogs, body: CATEGORY_EXPLAINERS.fulfillment_cogs.body },
  fulfillmentServices: { label: CATEGORY_LABELS.fulfillmentServices, body: CATEGORY_EXPLAINERS.fulfillment_services.body },
  cac: { label: CATEGORY_LABELS.cac, body: CATEGORY_EXPLAINERS.cac.body },
  opexSystems: { label: CATEGORY_LABELS.opexSystems, body: CATEGORY_EXPLAINERS.opex_systems.body },
  opexPeople: { label: CATEGORY_LABELS.opexPeople, body: CATEGORY_EXPLAINERS.opex_people.body },
  operationalNetProfit: { label: CATEGORY_LABELS.operationalNetProfit, body: METRIC_EXPLAINERS.operationalNetProfit.body },
  taxStrategy: { label: CATEGORY_LABELS.taxStrategy, body: CATEGORY_EXPLAINERS.tax_strategy.body },
  taxableNetProfit: { label: CATEGORY_LABELS.taxableNetProfit, body: METRIC_EXPLAINERS.taxableNetProfit.body },
};

// `upload.status` is the raw DB enum (shared/schema.ts) — "parsed"/"exported" describe internal
// pipeline state, not something a lay user uploading a P&L would recognize as a status of theirs.
const UPLOAD_STATUS_LABELS: Record<string, string> = {
  parsed: "Uploaded",
  mapped: "Categorized",
  exported: "Exported",
  deleted: "Deleted",
};

type Mode = "mom" | "qoq" | "ytd" | "custom";

const MODE_OPTIONS: { id: Mode; label: string; description: string }[] = [
  { id: "mom", label: "Month-over-Month", description: "Most recent complete month vs. the one before it." },
  { id: "qoq", label: "Rolling Quarter-over-Quarter", description: "Most recent complete 3-month window vs. the one before it." },
  { id: "ytd", label: "Year-to-Date-over-YTD", description: "This year's YTD-so-far vs. the same span last year." },
  { id: "custom", label: "Custom", description: "Pick two or more periods yourself." },
];

export default function Comparison() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<Mode>("mom");
  const [selectedPeriods, setSelectedPeriods] = useState<string[]>([]);

  const { data: uploadsData, isLoading: uploadsLoading } = useQuery<Upload[]>({
    queryKey: ["/api/uploads"],
  });

  const uploads = uploadsData || [];

  // Flattened, chronological list of every confirmed period across every upload — the picker
  // now operates on periods, not uploads, so a period inside a multi-period upload is directly
  // selectable rather than only reachable via the report screen's within-upload switcher.
  const allPeriods = uploads
    .flatMap((upload) =>
      (upload.periods || [])
        .filter((p) => p.confirmed)
        .map((p) => ({ upload, period: p })),
    )
    .sort((a, b) => new Date(a.period.periodStart).getTime() - new Date(b.period.periodStart).getTime());

  const selectedIds = selectedPeriods.join(",");
  const queryUrl =
    mode === "custom"
      ? `/api/comparisons?periodIds=${selectedIds}`
      : `/api/comparisons?mode=${mode}`;

  const enabled = mode === "custom" ? selectedPeriods.length >= 2 : true;

  const { data: comparisonData, isLoading: comparisonLoading, error } = useQuery<ComparisonResponse>({
    queryKey: ["/api/comparisons", mode, selectedIds],
    queryFn: async () => {
      const response = await fetch(queryUrl);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.reason || body.error || "Failed to fetch comparison");
      }
      return response.json();
    },
    enabled,
    retry: false,
  });

  const togglePeriod = (id: string) => {
    setSelectedPeriods((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const formatCurrency = (amount: number) => {
    const abs = Math.abs(amount);
    if (abs >= 1000000) {
      return `$${(amount / 1000000).toFixed(1)}M`;
    }
    if (abs >= 1000) {
      return `$${(amount / 1000).toFixed(1)}K`;
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatPercent = (pct: number | null | undefined) => {
    if (pct === undefined) return "-";
    if (pct === null) return "—";
    return `${pct.toFixed(1)}%`;
  };

  const formatDelta = (delta: number, isPercent = false) => {
    const sign = delta >= 0 ? "+" : "";
    if (isPercent) {
      return `${sign}${delta.toFixed(1)} pts`;
    }
    return `${sign}${formatCurrency(delta)}`;
  };

  const getDeltaColor = (delta: number, category: string) => {
    if (Math.abs(delta) < 0.1) return "text-muted-foreground";

    const higherIsBetter = ["revenue", "grossProfit", "operationalNetProfit", "taxStrategy"];
    const lowerIsBetter = [
      "fulfillment", "fulfillmentCogs", "fulfillmentServices",
      "cac", "opexSystems", "opexPeople",
    ];
    // taxStrategy stays in higherIsBetter even though the report screen no longer scores it
    // against a target (Neal, 2026-09-06: an individual's tax situation is holistic, so there's
    // no defensible target percentage). The directional call here is separate from that: more
    // routed through Ascent Moves means a lower Taxable Net Profit, which is the actual goal —
    // "no target" doesn't mean "no direction," just that there's no percentage to hit.
    // taxableNetProfit stays in neither list. It is the residual, and whether a rise is good
    // depends entirely on why — so it stays neutral grey rather than being scored by direction.

    if (higherIsBetter.includes(category)) {
      return delta > 0 ? "text-status-healthy" : "text-status-danger";
    }
    if (lowerIsBetter.includes(category)) {
      return delta < 0 ? "text-status-healthy" : "text-status-warning";
    }
    return "text-muted-foreground";
  };

  const getDeltaIcon = (delta: number) => {
    if (Math.abs(delta) < 0.01) return <Minus className="h-3 w-3" />;
    return delta > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  if (uploadsLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const renderVarianceList = (title: string, entries: { fromLabel: string; toLabel: string; variances: ComparisonVariance[] }[]) => {
    const flagged = entries.filter((e) => e.variances.length > 0);
    if (flagged.length === 0) return null;
    return (
      <Card className="p-6" data-testid={`card-variances-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        <h3 className="text-base font-semibold mb-1 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-status-warning" />
          {title}
        </h3>
        <p className="text-xs text-muted-foreground mb-4">
          Flagged when a line moves more than 10% AND $1,500 from the baseline.
        </p>
        <div className="space-y-3">
          {flagged.map((entry, i) => (
            <div key={i}>
              <p className="text-sm font-medium text-muted-foreground mb-2">
                {entry.fromLabel} → {entry.toLabel}
              </p>
              <div className="space-y-1">
                {entry.variances.map((v, j) => (
                  <div key={j} className="flex items-center justify-between text-sm border-l-2 border-status-warning pl-3">
                    <span>{v.categoryLabel}</span>
                    <span className="tabular-nums">
                      {formatDelta(v.amountDelta)}
                      {v.percentDelta !== null && ` (${formatDelta(v.percentDelta, true)})`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/upload")}
              data-testid="button-back"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <TrendingUp className="h-6 w-6 text-primary" />
                Period Comparison
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Compare financial metrics across multiple periods
              </p>
            </div>
          </div>
        </div>

        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Choose a comparison</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setMode(opt.id)}
                data-testid={`button-mode-${opt.id}`}
                className={`text-left p-3 rounded-lg border hover-elevate ${
                  mode === opt.id ? "border-primary bg-primary/5" : ""
                }`}
              >
                <p className="font-medium text-sm">{opt.label}</p>
                <p className="text-xs text-muted-foreground mt-1">{opt.description}</p>
              </button>
            ))}
          </div>

          {mode === "custom" && (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                Choose at least 2 periods to see how your finances have changed over time.
              </p>
              <div className="grid gap-3 max-h-96 overflow-y-auto">
                {allPeriods.map(({ upload, period }) => (
                  <label
                    key={period.id}
                    className="flex items-center gap-3 p-3 rounded-lg border hover-elevate cursor-pointer"
                    data-testid={`select-period-${period.id}`}
                  >
                    <Checkbox
                      checked={selectedPeriods.includes(period.id)}
                      onCheckedChange={() => togglePeriod(period.id)}
                      data-testid={`checkbox-period-${period.id}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{period.label}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {upload.filename} · {formatMonthLong(period.periodStart)}
                      </p>
                    </div>
                    <Badge variant="outline">{UPLOAD_STATUS_LABELS[upload.status] ?? upload.status}</Badge>
                  </label>
                ))}
              </div>
              {allPeriods.length < 2 && (
                <p className="text-sm text-muted-foreground mt-4">
                  Upload at least 2 confirmed periods to enable comparison.
                </p>
              )}
            </>
          )}
        </Card>

        {enabled && (
          <>
            {comparisonLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-2 text-muted-foreground">Loading comparison...</span>
              </div>
            )}

            {error && (
              <Card className="p-6 border-destructive">
                <p className="text-destructive" data-testid="text-comparison-error">
                  {(error as Error).message || "Failed to load comparison data."}
                </p>
              </Card>
            )}

            {comparisonData && (
              <>
                <Card className="p-6 overflow-x-auto" data-testid="card-comparison-results">
                  <h2 className="text-lg font-semibold mb-4">Comparison Results</h2>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-3 px-2 font-medium">Category</th>
                        {comparisonData.periods.map((period, idx) => (
                          <th key={period.periodId ?? `${period.periodLabel}-${idx}`} className="text-right py-3 px-2 font-medium min-w-[140px]">
                            <div>{period.periodLabel}</div>
                            {period.periodBasis && (
                              <div className="text-xs text-muted-foreground font-normal" title={period.periodBasis}>
                                {period.periodBasis}
                              </div>
                            )}
                            {idx > 0 && (
                              <div className="text-xs text-muted-foreground font-normal">
                                vs Prior
                              </div>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {CATEGORY_ORDER.map((catKey) => {
                        const pctKey = `${catKey}Pct` as keyof PeriodMetrics;
                        // Fulfillment is measured against revenue; everything else against
                        // Gross Profit, which is the framework's 100% baseline.
                        const againstRevenue =
                          catKey === "fulfillment" ||
                          catKey === "fulfillmentCogs" ||
                          catKey === "fulfillmentServices";

                        const explainer = EXPLAINER_LOOKUP[catKey];

                        return (
                          <tr key={catKey} className="border-b last:border-0">
                            <td className="py-4 px-2 font-medium">
                              <div className="flex items-center gap-1">
                                <span>{CATEGORY_LABELS[catKey]}</span>
                                {explainer && (
                                  <ExplainerPopover
                                    label={explainer.label}
                                    body={explainer.body}
                                    testId={`button-explain-${catKey}`}
                                  />
                                )}
                              </div>
                            </td>
                            {comparisonData.periods.map((period, idx) => {
                              const value = period.metrics[catKey as keyof PeriodMetrics] as number;
                              const pct = period.metrics[pctKey] as number | null | undefined;
                              const comparison = idx > 0 ? comparisonData.comparisons[idx - 1] : null;
                              const delta = comparison?.deltas[catKey];

                              return (
                                <td key={period.periodId ?? `${period.periodLabel}-${idx}`} className="py-4 px-2 text-right">
                                  <div className="font-medium tabular-nums">
                                    {formatCurrency(value)}
                                  </div>
                                  {pct != null && (
                                    <div className="text-xs text-muted-foreground tabular-nums">
                                      {formatPercent(pct)} of {againstRevenue ? "revenue" : "gross profit"}
                                    </div>
                                  )}
                                  {delta && (
                                    <div className="mt-1 flex items-center justify-end gap-1">
                                      <span className={`flex items-center gap-0.5 text-xs ${getDeltaColor(delta.amountDelta, catKey)}`}>
                                        {getDeltaIcon(delta.amountDelta)}
                                        {formatDelta(delta.amountDelta)}
                                      </span>
                                      {delta.allocationDelta !== null && (
                                        <span className={`text-xs ${getDeltaColor(delta.allocationDelta, catKey)}`}>
                                          ({formatDelta(delta.allocationDelta, true)})
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>

                {renderVarianceList("Variances vs. prior period", comparisonData.comparisons)}
                {renderVarianceList("Variances vs. first period in view", comparisonData.variancesVsFirst)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
