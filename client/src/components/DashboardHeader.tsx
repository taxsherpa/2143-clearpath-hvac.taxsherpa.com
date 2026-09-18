import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, FileText, Trash2 } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatMonthLong } from "@shared/period";

interface PeriodOption {
  id: string;
  monthStart: string;
}

interface DashboardHeaderProps {
  monthLabel: string;
  revenueTier: string;
  onExportCSV: () => void;
  onExportPDF: () => void;
  onDelete: () => void;
  /** Every processed period, so the report can be switched without going back through mapping. */
  periods?: PeriodOption[];
  currentUploadId?: string;
  onPeriodChange?: (uploadId: string) => void;
}

const tierLabels: Record<string, string> = {
  'under-250k': 'Under $250K/yr',
  '250k-500k': '$250K - $500K/yr',
  '500k-1mm': '$500K - $1MM/yr',
  '1mm-5mm': '$1MM - $5MM/yr',
  '5mm-plus': '$5MM+/yr',
};

export default function DashboardHeader({
  monthLabel,
  revenueTier,
  onExportCSV,
  onExportPDF,
  onDelete,
  periods,
  currentUploadId,
  onPeriodChange,
}: DashboardHeaderProps) {
  // Only worth a picker when there is something to pick between.
  const showPicker = !!(periods && periods.length > 1 && onPeriodChange && currentUploadId);
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold" data-testid="text-title">
            ClearPath HVAC Report
          </h1>
          <Badge variant="secondary" data-testid="badge-tier">
            {tierLabels[revenueTier] || revenueTier}
          </Badge>
        </div>
        {showPicker ? (
          <Select value={currentUploadId} onValueChange={onPeriodChange}>
            <SelectTrigger className="w-[200px] h-8" data-testid="select-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periods!.map(p => (
                <SelectItem key={p.id} value={p.id}>
                  {formatMonthLong(p.monthStart)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="text-month">
            {monthLabel}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button 
          variant="outline" 
          onClick={onExportCSV}
          data-testid="button-export-csv"
        >
          <FileText className="h-4 w-4 mr-2" />
          Export CSV
        </Button>
        <Button 
          variant="outline" 
          onClick={onExportPDF}
          data-testid="button-export-pdf"
        >
          <Download className="h-4 w-4 mr-2" />
          Export PDF
        </Button>
        <Button 
          variant="outline" 
          onClick={onDelete}
          className="text-destructive hover:text-destructive"
          data-testid="button-delete"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
