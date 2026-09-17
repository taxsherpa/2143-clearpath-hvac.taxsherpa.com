import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Info } from "lucide-react";

export type BenchmarkStatus = 'healthy' | 'warning' | 'danger';

interface MetricCardProps {
  label: string;
  value: string;
  percentage?: string;
  benchmark?: string;
  status?: BenchmarkStatus;
  gaugeValue?: number;
}

export default function MetricCard({
  label,
  value,
  percentage,
  benchmark,
  status,
  gaugeValue = 0,
}: MetricCardProps) {
  const getStatusColor = (s: BenchmarkStatus) => {
    switch (s) {
      case 'healthy': return 'bg-status-healthy text-white';
      case 'warning': return 'bg-status-warning text-white';
      case 'danger': return 'bg-status-danger text-white';
    }
  };

  const getGaugeColor = (s?: BenchmarkStatus) => {
    switch (s) {
      case 'healthy': return 'bg-status-healthy';
      case 'warning': return 'bg-status-warning';
      case 'danger': return 'bg-status-danger';
      default: return 'bg-primary';
    }
  };

  return (
    <Card className="p-6" data-testid={`card-metric-${label.toLowerCase().replace(/\s/g, '-')}`}>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </p>
              <Info className="h-3 w-3 text-muted-foreground" />
            </div>
          </div>
          {status && (
            <Badge 
              className={getStatusColor(status)}
              data-testid={`badge-status-${status}`}
            >
              {status === 'healthy' ? 'Healthy' : status === 'warning' ? 'Under' : 'Over'}
            </Badge>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <p className="text-4xl font-bold" data-testid="text-value">
              {value}
            </p>
            {percentage && (
              <p className="text-2xl font-semibold text-muted-foreground">
                {percentage}
              </p>
            )}
          </div>
          {benchmark && (
            <p className="text-sm text-muted-foreground" data-testid="text-benchmark">
              Target: {benchmark}
            </p>
          )}
        </div>

        {gaugeValue > 0 && (
          <div className="space-y-2">
            <div className="h-3 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${getGaugeColor(status)}`}
                style={{ width: `${Math.min(gaugeValue, 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
