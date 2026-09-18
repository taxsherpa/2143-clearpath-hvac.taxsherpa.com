import HvacScorecard, { type HvacScorecardData } from "@/components/HvacScorecard";
import { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import DashboardHeader from "@/components/DashboardHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, AlertCircle, FileText } from "lucide-react";
import { formatMonthLong } from "@shared/period";
import { ExplainerPopover } from "@/components/ExplainerPopover";
import { CATEGORY_EXPLAINERS, METRIC_EXPLAINERS } from "@/lib/category-explainers";

export default function Dashboard() {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();

  // `useSearch` and not `window.location.search`: the latter is read during render but is not
  // reactive, and wouter's `useLocation` only tracks the *pathname*. A navigation that changes
  // only the query string — the period switcher, and the redirect to the latest month below —
  // therefore re-rendered nothing: the URL moved and the page kept showing the old upload.
  const params = new URLSearchParams(useSearch());
  const uploadId = params.get('uploadId');
  const requestedPeriodId = params.get('periodId');

  // Phase 2.6: the report screen can show a single month (default), or a constructed annual/
  // YTD summary across uploads — a toggle on this same screen, per the PRD's own scoping note,
  // rather than a second screen for the same numbers.
  const view = (params.get('view') as 'month' | 'annual' | 'ytd') || 'month';
  const isAnnualView = view !== 'month';
  const annualMode = view === 'annual' ? 'full-year' : 'ytd';

  // Every upload, so the report can offer a period switcher and so arriving here with nothing
  // selected lands on the most recent month rather than a dead end.
  const { data: allUploads } = useQuery<{ id: string; monthStart: string }[]>({
    queryKey: ["/api/uploads"],
  });

  const periods = [...(allUploads ?? [])].sort(
    (a, b) => new Date(a.monthStart).getTime() - new Date(b.monthStart).getTime(),
  );

  // Years worth offering the annual/YTD toggle for — derived from the uploads on file, not a
  // blind current-year default, since the user's data may not cover the current year at all.
  const availableYears = Array.from(
    new Set(periods.map(p => new Date(p.monthStart).getUTCFullYear())),
  ).sort((a, b) => b - a);

  // The year the toggle should default to when arriving without an explicit `?year=`: the year
  // of the upload actually being viewed, not the most recent year across ALL uploads. Without
  // this, clicking "Full Year" from a 2025 report while any 2026 upload also exists on the
  // account silently jumped the toggle to 2026 instead of building 2025's full year — reported
  // by Neal against the live site (2026-09-06).
  const currentUpload = periods.find(p => p.id === uploadId);
  const currentUploadYear = currentUpload ? new Date(currentUpload.monthStart).getUTCFullYear() : undefined;
  const yearParam = params.get('year');
  const year = yearParam
    ? parseInt(yearParam, 10)
    : (currentUploadYear ?? availableYears[0] ?? new Date().getUTCFullYear());

  useEffect(() => {
    if (!uploadId && periods.length > 0) {
      setLocation(`/dashboard?uploadId=${periods[periods.length - 1].id}`, { replace: true });
    }
  }, [uploadId, periods.length]);

  const monthlyQuery = useQuery({
    queryKey: [`/api/uploads/${uploadId}/report`, requestedPeriodId],
    queryFn: async () => {
      const qs = requestedPeriodId ? `?periodId=${encodeURIComponent(requestedPeriodId)}` : '';
      const res = await apiRequest('GET', `/api/uploads/${uploadId}/report${qs}`);
      return res.json();
    },
    enabled: !isAnnualView && !!uploadId,
  });

  const annualQuery = useQuery({
    queryKey: [`/api/reports/annual`, year, annualMode],
    queryFn: async () => {
      // Not apiRequest(): a 404 here is an expected "nothing to build yet" outcome with its own
      // `reason` string to surface, not a generic request failure to swallow into a status code.
      const res = await fetch(`/api/reports/annual?year=${year}&mode=${annualMode}`, { credentials: 'include' });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        throw new Error(body.reason || 'Unable to build that report');
      }
      return body;
    },
    enabled: isAnnualView && !!year,
    retry: false,
  });

  const { data, isLoading, isError, error } = isAnnualView ? annualQuery : monthlyQuery;

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/uploads/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error('Failed to delete');
      }
      return response.json();
    },
    onSuccess: (_data, deletedUploadId) => {
      queryClient.setQueryData<{ id: string; monthStart: string }[]>(
        ["/api/uploads"],
        (uploads) => uploads?.filter((upload) => upload.id !== deletedUploadId) ?? [],
      );
      queryClient.removeQueries({ queryKey: [`/api/uploads/${deletedUploadId}/report`] });
      queryClient.removeQueries({ queryKey: [`/api/uploads/${deletedUploadId}/nodes`] });
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/comparisons"] });
      toast({
        title: "Data deleted",
        description: "Upload and all associated data has been permanently deleted",
      });
      setLocation('/upload');
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (!uploadId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="p-8 max-w-md">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="rounded-full bg-primary/10 p-4">
              <FileText className="h-8 w-8 text-primary" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Your report will show up here</h2>
              <p className="text-sm text-muted-foreground">
                Upload a P&amp;L and confirm how its lines are categorized, and your first report
                appears on this screen — then stays one click away for every month after that.
              </p>
            </div>
            <Button onClick={() => setLocation('/upload')}>
              Upload a P&amp;L
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Generating report...</p>
        </div>
      </div>
    );
  }

  if (isAnnualView && isError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="p-8 max-w-md">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">
                {view === 'annual' ? `No full year on file for ${year}` : `Can't build a year-to-date summary for ${year}`}
              </h2>
              <p className="text-sm text-muted-foreground">
                {(error as Error)?.message}
              </p>
            </div>
            <Button onClick={() => setLocation(`/dashboard?uploadId=${uploadId}`)}>
              Back to monthly report
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const metrics = (data as any)?.metrics || {};
  const variances = (data as any)?.variances || [];
  const hvac = (data as any)?.hvac as HvacScorecardData | undefined;

  // Everything on this screen is a share of revenue now, because that is the axis the HVAC
  // benchmark report uses and the one owners actually think in. Neal, 2026-09-17: "nobody knows
  // what gross profit is… they get lost immediately."
  const pctOfRevenue = (value: number | null | undefined): number | null => {
    const revenue = (data as any)?.metrics?.revenue;
    if (!revenue || value === null || value === undefined) return null;
    return (value / revenue) * 100;
  };
  const upload = (data as any)?.upload || {};
  const periodBasis: string | undefined = (data as any)?.periodBasis;
  const withinUploadPeriods: { id: string; label: string; confirmed: boolean }[] = (data as any)?.periods || [];
  const activePeriodId: string | null = (data as any)?.period?.id ?? null;

  // Formatted from the date's UTC parts, not the viewer's zone — see shared/period.ts.
  const formatMonthLabel = formatMonthLong;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatPercent = (pct: number | null | undefined) => {
    if (pct === null || pct === undefined) {
      return '0.0%';
    }
    return `${pct.toFixed(1)}%`;
  };

  const tier = (data as any)?.tier || 'under-250k';

  // Stoplight targets, mirroring the server's benchmark table (server/lib/rollups.ts). The old
  // ownersPay/profit rows are gone: owner compensation is no longer subtracted as an operating
  // cost, so the number scored is Operational Net Profit, whose target is the old
  // ownersPay + taxes + profit for that tier.
  //
  // Ascent Moves / Tax Strategy carries NO target (Neal, 2026-09-06, reversing an earlier
  // same-day decision that scored it against Operational Net Profit's target). An individual's
  // tax situation is holistic, not isolated to the business entity, so there's no defensible
  // percentage to hold it against — the only real goal is to legally minimize Taxable Net
  // Profit. Both Ascent Moves and Taxable Net Profit render as plain figures below, not
  // stoplights.
  const getTargetPct = (category: string): number => {
    const targets: Record<string, Record<string, number>> = {
      'under-250k': { fulfillment: 20, cac: 15, opexSystems: 10, opexPeople: 10, operationalNetProfit: 65 },
      '250k-500k': { fulfillment: 20, cac: 15, opexSystems: 10, opexPeople: 17.5, operationalNetProfit: 57.5 },
      '500k-1mm': { fulfillment: 20, cac: 15, opexSystems: 10, opexPeople: 25, operationalNetProfit: 50 },
      '1mm-5mm': { fulfillment: 20, cac: 15, opexSystems: 10, opexPeople: 40, operationalNetProfit: 35 },
      '5mm-plus': { fulfillment: 20, cac: 15, opexSystems: 10, opexPeople: 40, operationalNetProfit: 35 },
    };
    return targets[tier]?.[category] ?? targets['under-250k'][category];
  };

  const formatTierLabel = (tierValue: string): string => {
    // Tiers key off annualized GROSS PROFIT, not revenue — every benchmark below the tier is
    // a percentage of Gross Profit, so tiering on revenue mismatched the axis.
    const labels: Record<string, string> = {
      'under-250k': 'Under $250K',
      '250k-500k': '$250K - $500K',
      '500k-1mm': '$500K - $1MM',
      '1mm-5mm': '$1MM - $5MM',
      '5mm-plus': '$5MM+',
    };
    return labels[tierValue] || tierValue;
  };

  const exportQs = activePeriodId ? `?periodId=${encodeURIComponent(activePeriodId)}` : '';
  const annualExportQs = `?year=${year}&mode=${annualMode}`;

  const handleExportCSV = () => {
    const url = isAnnualView
      ? `/api/reports/annual/export/csv${annualExportQs}`
      : `/api/uploads/${uploadId}/export/csv${exportQs}`;
    window.open(url, '_blank');
    toast({
      title: "Export started",
      description: "ClearPath-remapped CSV is downloading",
    });
  };

  const handleExportPDF = () => {
    const url = isAnnualView
      ? `/api/reports/annual/export/pdf${annualExportQs}`
      : `/api/uploads/${uploadId}/export/pdf${exportQs}`;
    window.open(url, '_blank');
    toast({
      title: "Export started",
      description: "Summary report is opening in a new tab",
    });
  };

  const handleDelete = () => {
    if (uploadId && confirm('Are you sure you want to permanently delete this upload and all associated data? This action cannot be undone.')) {
      deleteMutation.mutate(uploadId);
    }
  };


  // An annual statement starts in January, so the month label read "January 2025" on a
  // Jan-Dec upload — the one line on the page that looked like a mistake. The server already
  // knows what kind of statement it is; use that.
  const isAnnualStatement = typeof periodBasis === 'string' && periodBasis.startsWith('Annual');
  const displayLabel = isAnnualView
    ? (view === 'annual' ? `Full Year ${year}` : `Year-to-Date ${year}`)
    : isAnnualStatement
      ? `Full Year ${new Date(upload.monthStart).getUTCFullYear()}`
      : formatMonthLabel(upload.monthStart);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="space-y-8">
          <DashboardHeader
            monthLabel={displayLabel}
            revenueTier={hvac?.tierLabel ?? tier}
            onExportCSV={handleExportCSV}
            onExportPDF={handleExportPDF}
            onDelete={handleDelete}
            periods={isAnnualView ? undefined : periods}
            currentUploadId={isAnnualView ? undefined : (uploadId ?? undefined)}
            onPeriodChange={(id) => setLocation(`/dashboard?uploadId=${id}`)}
          />

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground mr-1">View:</span>
            <Button
              size="sm"
              variant={view === 'month' ? 'default' : 'outline'}
              onClick={() => setLocation(`/dashboard?uploadId=${uploadId}`)}
              data-testid="button-view-monthly"
            >
              Monthly
            </Button>
            <Button
              size="sm"
              variant={view === 'annual' ? 'default' : 'outline'}
              onClick={() => setLocation(`/dashboard?uploadId=${uploadId}&view=annual&year=${year}`)}
              data-testid="button-view-annual"
            >
              Full Year
            </Button>
            <Button
              size="sm"
              variant={view === 'ytd' ? 'default' : 'outline'}
              onClick={() => setLocation(`/dashboard?uploadId=${uploadId}&view=ytd&year=${year}`)}
              data-testid="button-view-ytd"
            >
              Year-to-Date
            </Button>
            {isAnnualView && availableYears.length > 0 && (
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={year}
                onChange={(e) => setLocation(`/dashboard?uploadId=${uploadId}&view=${view}&year=${e.target.value}`)}
                data-testid="select-annual-year"
              >
                {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            )}
          </div>

          {!isAnnualView && withinUploadPeriods.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">This statement covers multiple periods:</span>
              {withinUploadPeriods.map(p => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={p.id === activePeriodId ? "default" : "outline"}
                  onClick={() => setLocation(`/dashboard?uploadId=${uploadId}&periodId=${p.id}`)}
                  data-testid={`button-period-${p.id}`}
                >
                  {p.label}{!p.confirmed ? " ⚠" : ""}
                </Button>
              ))}
            </div>
          )}

          {periodBasis && (
            <div className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground" data-testid="text-period-basis">
              Tier basis: <span className="font-medium text-foreground">{periodBasis}</span>
            </div>
          )}

          <div>
            <h2 className="text-xl font-semibold mb-4">Summary</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <Card className="p-4">
                <div className="text-sm text-muted-foreground">Total Revenue</div>
                <div className="text-2xl font-bold">{formatCurrency(metrics.revenue)}</div>
              </Card>
              <Card className="p-4">
                <div className="text-sm text-muted-foreground">Gross Profit</div>
                <div className="text-2xl font-bold">{formatCurrency(metrics.grossProfit)}</div>
                <div className="text-xs text-muted-foreground mt-1">Revenue minus Fulfillment</div>
              </Card>
              <Card className="p-4">
                <div className="text-sm text-muted-foreground">Revenue tier</div>
                <div className="text-2xl font-bold">{hvac?.tierLabel ?? formatTierLabel(tier)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {hvac ? "By annualised revenue, per the HVAC benchmark report" : (periodBasis ?? "By annualized Gross Profit")}
                </div>
              </Card>
            </div>
          </div>

          {hvac && (
            <div className="mb-10">
              <HvacScorecard data={hvac} />
            </div>
          )}

          <div>
            <h2 className="text-xl font-semibold mt-10 mb-2">Profit Conversion (Ascent)</h2>
            <p className="text-sm text-muted-foreground mb-4">
              What happens to the profit after the business has earned it. An individual's tax
              situation is holistic, not isolated to the business, so Ascent Moves carries no
              target percentage here — the only goal is to legally minimize Taxable Net Profit.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
              <Card className="p-4">
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <span>Operational Net Profit</span>
                  <ExplainerPopover
                    label="Operational Net Profit"
                    body={METRIC_EXPLAINERS.operationalNetProfit.body}
                    testId="button-explain-operational-net-profit"
                  />
                </div>
                <div className="text-2xl font-bold">{formatCurrency(metrics.operationalNetProfit)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {formatPercent(pctOfRevenue(metrics.operationalNetProfit))} of revenue
                </div>
              </Card>
              <Card className="p-4">
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <span>− Ascent Moves / Tax Strategy</span>
                  <ExplainerPopover
                    label="Ascent Moves / Tax Strategy"
                    body={CATEGORY_EXPLAINERS.tax_strategy.body}
                    testId="button-explain-tax-strategy"
                  />
                </div>
                <div className="text-2xl font-bold">{formatCurrency(metrics.taxStrategy)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {formatPercent(pctOfRevenue(metrics.taxStrategy))} of revenue — no target: minimize this
                </div>
              </Card>
              <Card className="p-4 bg-muted/40">
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <span>= Taxable Net Profit</span>
                  <ExplainerPopover
                    label="Taxable Net Profit"
                    body={METRIC_EXPLAINERS.taxableNetProfit.body}
                    testId="button-explain-taxable-net-profit"
                  />
                </div>
                <div className="text-2xl font-bold">{formatCurrency(metrics.taxableNetProfit)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {formatPercent(pctOfRevenue(metrics.taxableNetProfit))} of revenue
                </div>
              </Card>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Operational Net Profit minus Ascent Moves equals Taxable Net Profit — the profit
              still exposed to tax. Neither Ascent Moves nor Taxable Net Profit carries a target
              or status indicator here.
            </p>

            {typeof metrics.taxableNetProfit === 'number' && metrics.taxableNetProfit < 0 && (
              <Card
                className="p-4 mt-4 border-l-4 border-l-status-danger"
                data-testid="alert-negative-taxable-net-profit"
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-status-danger shrink-0 mt-0.5" />
                  <p className="text-sm text-foreground leading-relaxed">
                    <span className="font-semibold">
                      You took more out of the business than it made this period.
                    </span>{" "}
                    Operational Net Profit was {formatCurrency(metrics.operationalNetProfit)}, but
                    Ascent Moves / Tax Strategy routed {formatCurrency(metrics.taxStrategy)} to
                    you — {formatCurrency(Math.abs(metrics.taxableNetProfit))} more than the
                    business produced. That shortfall is coming out of the business's reserves,
                    not this period's profit, which means you're defunding the business by that
                    amount unless it's made up elsewhere.
                  </p>
                </div>
              </Card>
            )}
          </div>


        </div>
      </div>
    </div>
  );
}
