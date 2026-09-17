import { useMemo } from "react";
import { ExplainerPopover } from "./ExplainerPopover";
import { useAccessibility } from "@/hooks/use-accessibility";

/**
 * A five-band vertical stoplight: red / yellow / green / yellow / red, top to bottom, with one
 * band lit.
 *
 * Replaces the speedometer gauges. The bands are the same distance-from-target thresholds the
 * gauges already used (within 3 points of target, within 10, beyond), just read as five signed
 * levels instead of three unsigned ones — so the lit band says the same thing the needle did,
 * and additionally says *which side* of target you are on, which the gauge's colour alone
 * couldn't.
 *
 * Position carries meaning: above centre is above target, below centre is below target. That
 * holds for every metric, including the ones where being above target is the good outcome, so
 * a reader never has to remember which way a particular row points.
 *
 * Accessibility: colour is never the only signal. Each band carries a text label, the lit band
 * is named in words underneath, and the marker is a filled bar rather than a colour swatch —
 * which is also the Phase 4 requirement for a colourblind-readable scorecard, met early.
 */

export type BandLevel = "far-below" | "below" | "on-target" | "above" | "far-above";
export type BandTone = "danger" | "warning" | "healthy";

interface StoplightMeterProps {
  label: string;
  /** Current value as a percentage of the basis (Gross Profit, or Revenue for Fulfillment). */
  currentPct: number | null;
  /** Benchmark target as a percentage of the same basis. */
  targetPct: number;
  dollarValue?: string;
  /** Higher is better (Operational Net Profit) rather than lower (the cost categories). */
  isProfit?: boolean;
  /** Basis label shown under the value, e.g. "of gross profit". */
  basisLabel?: string;
  /** Phase 3.3: "what does this mean" popover, sourced from CATEGORY_EXPLAINERS/METRIC_EXPLAINERS. */
  explainer?: { short: string; body: string };
}

/** Bands are ordered top (far above target) to bottom (far below target). */
const BANDS: { level: BandLevel; tone: BandTone; short: string }[] = [
  { level: "far-above", tone: "danger", short: "Far above" },
  { level: "above", tone: "warning", short: "Above" },
  { level: "on-target", tone: "healthy", short: "On target" },
  { level: "below", tone: "warning", short: "Below" },
  { level: "far-below", tone: "danger", short: "Far below" },
];

/**
 * The same breakpoints the speedometer used: within 3 percentage points of target is on
 * target, within 10 is a caution, beyond that needs attention.
 */
const ON_TARGET = 3;
const CAUTION = 10;

export function bandFor(currentPct: number, targetPct: number): BandLevel {
  const diff = currentPct - targetPct;
  if (Math.abs(diff) <= ON_TARGET) return "on-target";
  if (diff > 0) return diff <= CAUTION ? "above" : "far-above";
  return diff >= -CAUTION ? "below" : "far-below";
}

/**
 * What the lit band means in words, which differs by metric direction.
 * For a cost, being under target is a good problem; for profit, being over target is.
 */
function readingFor(level: BandLevel, isProfit: boolean): string {
  switch (level) {
    case "on-target":
      return "On target";
    case "above":
      return isProfit ? "Ahead of target" : "Running high";
    case "far-above":
      return isProfit ? "Well ahead of target" : "Well above target";
    case "below":
      return isProfit ? "Behind target" : "Running lean";
    case "far-below":
      return isProfit ? "Well behind target" : "Well below target";
  }
}

const TONE_ON: Record<BandTone, string> = {
  danger: "bg-status-danger",
  warning: "bg-status-warning",
  healthy: "bg-status-healthy",
};

const TONE_OFF: Record<BandTone, string> = {
  danger: "bg-status-danger/12",
  warning: "bg-status-warning/12",
  healthy: "bg-status-healthy/12",
};

/**
 * High contrast pushes the unlit bands from a faint tint to a solid, bordered fill with
 * full-strength text — a 12%-opacity tint reads as barely-there on the high-contrast palette's
 * near-white background, which would leave four of the five band labels hard to read even though
 * the lit one is fine. See phase-4-landing-legal-accessibility.md's 4.3 note on verifying the
 * stoplight under every contrast mode, not just confirming the lit band still works.
 */
const TONE_OFF_HIGH_CONTRAST: Record<BandTone, string> = {
  danger: "bg-status-danger/25 border border-status-danger",
  warning: "bg-status-warning/25 border border-status-warning",
  healthy: "bg-status-healthy/25 border border-status-healthy",
};

export function StoplightMeter({
  label,
  currentPct,
  targetPct,
  dollarValue,
  isProfit = false,
  basisLabel,
  explainer,
}: StoplightMeterProps) {
  const { settings } = useAccessibility();
  const isHighContrast = settings.colorMode === "high-contrast";

  const level = useMemo(
    () => (currentPct === null ? null : bandFor(currentPct, targetPct)),
    [currentPct, targetPct],
  );

  const lit = level ? BANDS.find(b => b.level === level) : null;

  return (
    <div className="flex flex-col items-center gap-3 p-4 rounded-lg border bg-card">
      <div className="flex items-center gap-0.5 text-sm font-medium text-center leading-tight">
        <span>{label}</span>
        {explainer && (
          <ExplainerPopover
            label={label}
            body={explainer.body}
            className="h-4 w-4"
            testId={`button-explain-${label.toLowerCase().replace(/\s+/g, '-')}`}
          />
        )}
      </div>

      <div
        className="flex flex-col gap-1 w-full max-w-[7.5rem]"
        role="img"
        aria-label={
          level
            ? `${label}: ${readingFor(level, isProfit)}. ${currentPct!.toFixed(1)} percent against a target of ${targetPct} percent.`
            : `${label}: no data`
        }
      >
        {BANDS.map(band => {
          const on = band.level === level;
          return (
            <div
              key={band.level}
              className={`flex items-center justify-center rounded h-6 text-[10px] font-medium tracking-wide transition-colors ${
                on
                  ? `${TONE_ON[band.tone]} text-white shadow-sm`
                  : isHighContrast
                    ? `${TONE_OFF_HIGH_CONTRAST[band.tone]} text-foreground`
                    : `${TONE_OFF[band.tone]} text-muted-foreground/50`
              }`}
            >
              {/* The text label is what makes this readable without colour. */}
              {on ? band.short.toUpperCase() : band.short}
            </div>
          );
        })}
      </div>

      <div className="text-center space-y-0.5">
        <div className="text-lg font-bold tabular-nums">
          {currentPct === null ? "—" : `${currentPct.toFixed(1)}%`}
        </div>
        {dollarValue && <div className="text-xs text-muted-foreground tabular-nums">{dollarValue}</div>}
        <div className="text-xs text-muted-foreground">
          Target {targetPct}%{basisLabel ? ` ${basisLabel}` : ""}
        </div>
        {lit && (
          <div className="text-xs font-medium pt-0.5">{readingFor(lit.level, isProfit)}</div>
        )}
      </div>
    </div>
  );
}

export default StoplightMeter;
