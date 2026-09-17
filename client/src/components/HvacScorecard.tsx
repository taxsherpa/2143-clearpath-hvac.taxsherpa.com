import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * The HVAC scorecard: every category as a percentage of REVENUE, next to two columns from the
 * industry report — what the average operator runs at, and what the exceptional (top-quartile)
 * shop runs at. We score against the exceptional column, which is the promise the workshop page
 * makes: "what the average shop is getting, next to what the best-in-class shop gets from the
 * same conditions".
 *
 * The scoring, the benchmarks and the interpretation text all come from the server
 * (`server/lib/hvac-benchmarks.ts`). Nothing is recomputed here on purpose: the generic app keeps
 * a second copy of its benchmark table in the dashboard, and the two drifted.
 */

export type HvacStatus = "ahead" | "on-track" | "behind" | "unknown";

export interface HvacScoreRow {
  category: string;
  label: string;
  actual: number | null;
  average: number;
  exceptional: number;
  gap: number | null;
  status: HvacStatus;
  interpretation: string;
}

export interface OwnerCompFinding {
  amount: number;
  labels: string[];
}

export interface HvacScorecardData {
  tier: string;
  tierLabel: string;
  borrowedTier?: string;
  borrowedTierLabel?: string;
  annualRevenue: number | null;
  scores: HvacScoreRow[];
  /** Owner pay found inside operating expenses, which the benchmarks exclude. */
  ownerCompInOpex?: OwnerCompFinding | null;
}

const STATUS_LABEL: Record<HvacStatus, string> = {
  ahead: "Ahead of best-in-class",
  "on-track": "Close to best-in-class",
  behind: "Behind best-in-class",
  unknown: "Not enough data",
};

/** Colour is never the only signal: every row also carries the status in words. */
const STATUS_CLASS: Record<HvacStatus, string> = {
  ahead: "bg-status-healthy text-white",
  "on-track": "bg-status-warning text-white",
  behind: "bg-status-danger text-white",
  unknown: "bg-muted text-muted-foreground",
};

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function gapText(gap: number | null): string {
  if (gap === null) return "";
  if (gap === 0) return "exactly on the benchmark";
  const points = Math.abs(gap).toFixed(1);
  return gap > 0 ? `${points} pts better` : `${points} pts to close`;
}

export default function HvacScorecard({ data }: { data: HvacScorecardData }) {
  const currency = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);

  return (
    <section className="space-y-4" data-testid="hvac-scorecard">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">Your numbers against HVAC shops your size</h2>
        <p className="text-sm text-muted-foreground max-w-prose">
          Every line is a percentage of revenue. <strong>Average</strong> is what a typical HVAC
          shop in your revenue band runs at. <strong>Best-in-class</strong> is the top quartile —
          the same trucks, the same market, a different set of decisions. That's the column you're
          scored against.
        </p>

        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary" data-testid="hvac-tier">
            {data.tierLabel}
          </Badge>
          {data.annualRevenue !== null && (
            <span>Annualised revenue {currency(data.annualRevenue)}</span>
          )}
        </div>

        {data.borrowedTierLabel && (
          // Neal, 2026-09-15: shops under $500K are scored against the $500K–$2M exceptional
          // column. Saying so matters — the report doesn't cover shops this size, and pretending
          // otherwise would be the one thing that makes the whole scorecard untrustworthy.
          <p className="text-sm rounded-md border border-dashed p-3 max-w-prose">
            The industry report starts at $500K of revenue, so there's no published benchmark for a
            shop your size. You're being measured against the{" "}
            <strong>{data.borrowedTierLabel}</strong> best-in-class column — a fair target to grow
            into, not a like-for-like comparison.
          </p>
        )}
      </div>

      {data.ownerCompInOpex && (
        // The report replaces the owner's own pay with what a hired manager would cost, so an
        // owner-operator running a salary through payroll reads as having an overhead problem
        // they don't have. Say it rather than silently adjusting: the correction is theirs.
        <Card className="p-4 border-status-warning/50" data-testid="hvac-owner-comp-notice">
          <div className="space-y-1">
            <p className="font-medium">
              We found {currency(data.ownerCompInOpex.amount)} of owner pay inside operating
              expenses
            </p>
            <p className="text-sm text-muted-foreground max-w-prose">
              These benchmarks exclude what the owner pays themselves, and count a market-rate
              manager's salary instead. Until that's separated out, your overhead reads high and
              your margin reads low against the columns below.
            </p>
            <p className="text-xs text-muted-foreground">
              From: {data.ownerCompInOpex.labels.join(", ")}
            </p>
          </div>
        </Card>
      )}

      {/* Wide screens read this as a table; narrow ones get one card per category. */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Category</th>
              <th className="py-2 pr-4 font-medium text-right tabular-nums">You</th>
              <th className="py-2 pr-4 font-medium text-right tabular-nums">Average</th>
              <th className="py-2 pr-4 font-medium text-right tabular-nums">Best-in-class</th>
              <th className="py-2 pr-4 font-medium">Where you stand</th>
            </tr>
          </thead>
          <tbody>
            {data.scores.map((row) => (
              <tr
                key={row.category}
                className="border-t align-top"
                data-testid={`hvac-row-${row.category}`}
              >
                <td className="py-3 pr-4 font-medium">{row.label}</td>
                <td className="py-3 pr-4 text-right tabular-nums font-semibold">
                  {pct(row.actual)}
                </td>
                <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">
                  {pct(row.average)}
                </td>
                <td className="py-3 pr-4 text-right tabular-nums">{pct(row.exceptional)}</td>
                <td className="py-3 pr-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs ${STATUS_CLASS[row.status]}`}
                      >
                        {STATUS_LABEL[row.status]}
                      </span>
                      {row.gap !== null && (
                        <span className="text-xs text-muted-foreground">{gapText(row.gap)}</span>
                      )}
                    </div>
                    {row.interpretation && (
                      <p className="text-sm text-muted-foreground max-w-prose">
                        {row.interpretation}
                      </p>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 md:hidden">
        {data.scores.map((row) => (
          <Card key={row.category} className="p-4 space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{row.label}</span>
              <span className="text-lg font-semibold tabular-nums">{pct(row.actual)}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span>Average {pct(row.average)}</span>
              <span>Best-in-class {pct(row.exceptional)}</span>
              {row.gap !== null && <span>{gapText(row.gap)}</span>}
            </div>
            <span
              className={`inline-block rounded px-2 py-0.5 text-xs ${STATUS_CLASS[row.status]}`}
            >
              {STATUS_LABEL[row.status]}
            </span>
            {row.interpretation && (
              <p className="text-sm text-muted-foreground">{row.interpretation}</p>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}
