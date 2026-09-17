import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, BarChart3, ListChecks, AlertTriangle } from "lucide-react";
import { formatMonthLong, formatPeriodRange } from "@shared/period";

interface UploadPeriod {
  id: string;
  label: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  monthsCovered: number;
  confirmed: boolean;
}

interface Upload {
  id: string;
  filename: string;
  monthStart: string;
  status: 'parsed' | 'mapped' | 'exported';
  uploadedAt: string;
  periods?: UploadPeriod[];
  needsPeriodConfirmation?: boolean;
}

interface UploadHistoryProps {
  uploads: Upload[];
  onViewReport: (id: string) => void;
  onReviewMapping: (id: string) => void;
}

export default function UploadHistory({ uploads, onViewReport, onReviewMapping }: UploadHistoryProps) {
  // `parsed` means nobody has confirmed the mapping yet; `mapped` means they have. The status
  // was previously set once at upload and never updated, so everything read "Parsed" forever.
  const getStatusBadge = (status: Upload['status']) => {
    const badges = {
      parsed: <Badge className="bg-status-warning text-white text-xs">Needs review</Badge>,
      mapped: <Badge className="bg-status-healthy text-white text-xs">Ready</Badge>,
      exported: <Badge className="bg-status-healthy text-white text-xs">Ready</Badge>,
    };
    return badges[status] ?? badges.parsed;
  };

  // The uploaded-on date is a real timestamp, so local time is correct for it. The reporting
  // period is a calendar month and must not have a timezone applied — see shared/period.ts.
  const formatUploadedOn = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  if (uploads.length === 0) {
    return null;
  }

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Recent Uploads</h3>
      <div className="space-y-3">
        {uploads.map((upload) => (
          <div
            key={upload.id}
            className="flex items-center justify-between p-4 rounded-lg border hover-elevate"
            data-testid={`upload-${upload.id}`}
          >
            <div className="flex items-center gap-4">
              <div className="rounded-lg bg-primary/10 p-3">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="font-medium text-sm">{upload.filename}</p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {upload.periods && upload.periods.length > 1
                      ? `${upload.periods.length} periods: ${formatPeriodRange(upload.periods[0].periodStart, upload.periods[upload.periods.length - 1].periodEnd, "custom")}`
                      : upload.periods && upload.periods.length === 1
                        ? upload.periods[0].label
                        : formatMonthLong(upload.monthStart)}
                  </span>
                  <span>•</span>
                  <span>Uploaded {formatUploadedOn(upload.uploadedAt)}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {upload.needsPeriodConfirmation && (
                <Badge variant="outline" className="text-xs border-status-warning text-status-warning gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Confirm period
                </Badge>
              )}
              {getStatusBadge(upload.status)}
              {/*
                A period whose mapping is already confirmed goes straight to its report.
                Re-checking the mapping stays available, it just isn't compulsory — looking back
                at a month you already processed shouldn't mean walking through review again.
              */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => onReviewMapping(upload.id)}
                data-testid={`button-review-${upload.id}`}
              >
                <ListChecks className="h-4 w-4 mr-2" />
                {upload.status === 'parsed' ? 'Review & map' : 'Mapping'}
              </Button>
              <Button
                size="sm"
                variant={upload.status === 'parsed' ? 'outline' : 'default'}
                onClick={() => onViewReport(upload.id)}
                data-testid={`button-view-${upload.id}`}
              >
                <BarChart3 className="h-4 w-4 mr-2" />
                Report
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
