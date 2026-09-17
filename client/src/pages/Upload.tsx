import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import FileUploadZone from "@/components/FileUploadZone";
import UploadHistory from "@/components/UploadHistory";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

interface Upload {
  id: string;
  filename: string;
  monthStart: string;
  status: 'parsed' | 'mapped' | 'exported';
  uploadedAt: string;
}

interface PendingPeriod {
  id: string;
  label: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  monthsCovered: number;
  confirmed: boolean;
}

const PERIOD_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "month", label: "A single month" },
  { value: "quarter", label: "A quarter (3 months)" },
  { value: "year_to_date", label: "Year-to-date (Jan through this month)" },
  { value: "annual", label: "Full year" },
  { value: "custom", label: "A custom date range" },
];

export default function Upload() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingFileType, setUploadingFileType] = useState<'csv' | 'pdf' | null>(null);

  // Build requirement #2: when the parser can't trust its own read of a statement's period,
  // the upload is created but held here for confirmation before the flow continues to mapping.
  const [pendingUploadId, setPendingUploadId] = useState<string | null>(null);
  const [pendingPeriods, setPendingPeriods] = useState<PendingPeriod[]>([]);
  const [periodDrafts, setPeriodDrafts] = useState<Record<string, { periodType: string; periodStart: string; periodEnd: string }>>({});
  const [confirmingPeriods, setConfirmingPeriods] = useState(false);

  const { data: uploads } = useQuery<Upload[]>({
    queryKey: ['/api/uploads'],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/uploads', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        const err = new Error(error.error || 'Upload failed') as Error & { code?: string };
        err.code = error.code;
        throw err;
      }

      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/uploads'] });
      toast({
        title: "Upload successful",
        description: `Processed ${data.nodeCount} P&L categories`,
      });

      const unconfirmed: PendingPeriod[] = (data.periods || []).filter((p: PendingPeriod) => !p.confirmed);
      if (unconfirmed.length > 0) {
        setPendingUploadId(data.uploadId);
        setPendingPeriods(unconfirmed);
        setPeriodDrafts(Object.fromEntries(unconfirmed.map(p => [
          p.id,
          {
            periodType: p.periodType === 'unknown' ? 'month' : p.periodType,
            periodStart: p.periodStart?.slice(0, 10) ?? '',
            periodEnd: p.periodEnd?.slice(0, 10) ?? '',
          },
        ])));
      } else {
        setLocation(`/review?uploadId=${data.uploadId}`);
      }
    },
    onError: (error: Error & { code?: string }) => {
      if (error.code === "MULTI_COLUMN_PDF") {
        toast({
          title: "This PDF shows more than one period",
          description: "Please export the same statement as a CSV instead — the CSV path can capture every period column correctly.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      setIsUploading(false);
    },
  });

  const confirmPeriodsMutation = useMutation({
    mutationFn: async () => {
      if (!pendingUploadId) return;
      for (const period of pendingPeriods) {
        const draft = periodDrafts[period.id];
        await apiRequest('POST', `/api/uploads/${pendingUploadId}/periods/${period.id}/confirm`, {
          periodType: draft.periodType,
          periodStart: draft.periodStart,
          periodEnd: draft.periodEnd,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/uploads'] });
      const uploadId = pendingUploadId;
      setPendingUploadId(null);
      setPendingPeriods([]);
      setPeriodDrafts({});
      if (uploadId) setLocation(`/review?uploadId=${uploadId}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't save the period",
        description: error.message,
        variant: "destructive",
      });
    },
    onSettled: () => setConfirmingPeriods(false),
  });

  const handleConfirmPeriods = () => {
    setConfirmingPeriods(true);
    confirmPeriodsMutation.mutate();
  };

  const handleFileSelect = async (file: File) => {
    setIsUploading(true);
    setUploadingFileType(file.name.endsWith('.pdf') ? 'pdf' : 'csv');
    uploadMutation.mutate(file);
  };

  // Goes to the report, as the name says. It previously routed to /review, which forced a
  // walk back through mapping to see a month that had already been processed.
  const handleViewReport = (uploadId: string) => {
    setLocation(`/dashboard?uploadId=${uploadId}`);
  };

  const handleReviewMapping = (uploadId: string) => {
    setLocation(`/review?uploadId=${uploadId}`);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="space-y-8">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold">Upload Your P&L</h1>
            <p className="text-muted-foreground">
              Upload your Profit &amp; Loss statement and we'll sort every line into plain-English
              categories, then show you what's working and what to fix — no accounting background needed.
            </p>
          </div>

          {isUploading && (
            <div className="flex items-center justify-center p-12 rounded-lg border bg-muted/50">
              <div className="flex flex-col items-center gap-4">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">
                  {uploadingFileType === 'pdf' 
                    ? "Processing your PDF with AI... This may take a minute." 
                    : "Processing your CSV..."}
                </p>
              </div>
            </div>
          )}

          {!isUploading && (
            <div className="max-w-2xl">
              <FileUploadZone onFileSelect={handleFileSelect} />
            </div>
          )}

          <div className="max-w-2xl">
            <div className="rounded-lg bg-muted p-6 space-y-4">
              <h3 className="font-semibold">What you'll need</h3>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span><strong>A CSV export</strong> from QuickBooks Online, Xero, or similar — the same Profit &amp; Loss report you already download or print.</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span><strong>Or a PDF</strong> of any P&amp;L statement — we'll read the numbers off the page for you.</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>Don't worry about matching our category names yourself — the next step walks you through assigning each line, with an explanation for every category.</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>Files up to 20MB.</span>
                </li>
              </ul>
            </div>
          </div>

          {uploads && uploads.length > 0 && (
            <UploadHistory
              onReviewMapping={handleReviewMapping}
              uploads={uploads}
              onViewReport={handleViewReport}
            />
          )}
        </div>
      </div>

      <Dialog open={pendingPeriods.length > 0} onOpenChange={() => { /* must confirm or cancel explicitly */ }}>
        <DialogContent className="max-w-lg" data-testid="dialog-confirm-period">
          <DialogHeader>
            <DialogTitle>Confirm the reporting period</DialogTitle>
            <DialogDescription>
              We couldn't confidently tell what period{pendingPeriods.length > 1 ? 's' : ''} this
              statement covers. Please confirm before continuing, so the report tiers correctly
              instead of guessing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-2 max-h-[60vh] overflow-y-auto">
            {pendingPeriods.map((period) => {
              const draft = periodDrafts[period.id];
              if (!draft) return null;
              return (
                <div key={period.id} className="space-y-3 border rounded-md p-4">
                  <p className="text-sm font-medium">{period.label}</p>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">What kind of period is this?</p>
                    <Select
                      value={draft.periodType}
                      onValueChange={(v) => setPeriodDrafts(prev => ({ ...prev, [period.id]: { ...prev[period.id], periodType: v } }))}
                    >
                      <SelectTrigger data-testid={`select-period-type-${period.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERIOD_TYPE_OPTIONS.map(opt => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Period starts</p>
                      <input
                        type="date"
                        className="w-full border rounded-md px-2 py-1.5 text-sm bg-background"
                        value={draft.periodStart}
                        onChange={(e) => setPeriodDrafts(prev => ({ ...prev, [period.id]: { ...prev[period.id], periodStart: e.target.value } }))}
                        data-testid={`input-period-start-${period.id}`}
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Period ends</p>
                      <input
                        type="date"
                        className="w-full border rounded-md px-2 py-1.5 text-sm bg-background"
                        value={draft.periodEnd}
                        onChange={(e) => setPeriodDrafts(prev => ({ ...prev, [period.id]: { ...prev[period.id], periodEnd: e.target.value } }))}
                        data-testid={`input-period-end-${period.id}`}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button
              onClick={handleConfirmPeriods}
              disabled={confirmingPeriods}
              data-testid="button-confirm-period"
            >
              {confirmingPeriods ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
              ) : (
                "Confirm and continue"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
