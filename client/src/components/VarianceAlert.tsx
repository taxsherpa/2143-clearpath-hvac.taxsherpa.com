import { Card } from "@/components/ui/card";
import { AlertCircle, TrendingUp, TrendingDown } from "lucide-react";
import type { BenchmarkStatus } from "./MetricCard";

interface VarianceAlertProps {
  category: string;
  current: string;
  target: string;
  variance: number;
  status: BenchmarkStatus;
  recommendation: string;
}

export default function VarianceAlert({
  category,
  current,
  target,
  variance,
  status,
  recommendation,
}: VarianceAlertProps) {
  const getBorderColor = (s: BenchmarkStatus) => {
    switch (s) {
      case 'healthy': return 'border-l-status-healthy';
      case 'warning': return 'border-l-status-warning';
      case 'danger': return 'border-l-status-danger';
    }
  };

  const getIcon = () => {
    if (status === 'healthy') return null;
    return variance > 0 ? (
      <TrendingUp className="h-5 w-5 text-status-danger shrink-0" />
    ) : (
      <TrendingDown className="h-5 w-5 text-status-warning shrink-0" />
    );
  };

  return (
    <Card 
      className={`p-6 border-l-4 ${getBorderColor(status)}`}
      data-testid={`alert-${category.toLowerCase().replace(/\s/g, '-')}`}
    >
      <div className="flex items-start gap-4">
        <div className="shrink-0 mt-1">
          {getIcon() || <AlertCircle className="h-5 w-5 text-muted-foreground" />}
        </div>
        
        <div className="flex-1 space-y-2">
          <div>
            <h4 className="font-semibold text-base" data-testid="text-category">
              {category}
            </h4>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-sm font-medium" data-testid="text-current">
                {current}
              </span>
              <span className="text-sm text-muted-foreground">
                vs
              </span>
              <span className="text-sm text-muted-foreground" data-testid="text-target">
                {target} target
              </span>
              <span className={`text-sm font-medium ${
                Math.abs(variance) > 0 ? 'text-status-danger' : 'text-status-healthy'
              }`}>
                ({variance > 0 ? '+' : ''}{variance}%)
              </span>
            </div>
          </div>
          
          <p className="text-sm text-foreground leading-relaxed" data-testid="text-recommendation">
            {recommendation}
          </p>
        </div>
      </div>
    </Card>
  );
}
