import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, Loader2, ChevronRight, Check, Eye, EyeOff, History } from "lucide-react";
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
import { CATEGORY_ORDER, CATEGORY_LABELS, categoryLabel } from "@shared/categories";
import { CATEGORY_EXPLAINERS } from "@/lib/category-explainers";
import { ExplainerPopover } from "@/components/ExplainerPopover";
import type { ClearpathCategory } from "@shared/schema";

interface PLNode {
  id: string;
  label: string;
  amountCents: number | null;
  level: number;
  isRollup: number;
  suggestedCategory: string | null;
  mappedCategory: string | null;
  confidence: string | null;
  mappingStatus: string | null;
  excludedReason: string | null;
  fromMemory?: boolean;
}

interface UploadPeriod {
  id: string;
  label: string;
  periodType: string;
  monthsCovered: number;
  confirmed: boolean;
}

interface NodesResponse {
  periodId: string | null;
  periods: UploadPeriod[];
  nodes: PLNode[];
}

// Categories come from the shared module so the dropdown, the report, both exports and the
// comparison grid can never drift apart again.
const CLEARPATH_CATEGORIES = CATEGORY_ORDER.map(value => ({
  value,
  label: CATEGORY_LABELS[value],
}));

export default function Review() {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<PLNode | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>("");

  // Reactive, unlike `window.location.search` — see the note in Dashboard.tsx.
  const params = new URLSearchParams(useSearch());
  const uploadId = params.get('uploadId');
  const requestedPeriodId = params.get('periodId');

  const { data, isLoading } = useQuery<NodesResponse>({
    queryKey: [`/api/uploads/${uploadId}/nodes`, requestedPeriodId],
    queryFn: async () => {
      const qs = requestedPeriodId ? `?periodId=${encodeURIComponent(requestedPeriodId)}` : '';
      const res = await apiRequest('GET', `/api/uploads/${uploadId}/nodes${qs}`);
      return res.json();
    },
    enabled: !!uploadId,
  });

  const uploadPeriods = data?.periods ?? [];
  const activePeriodId = requestedPeriodId ?? data?.periodId ?? null;

  const handlePeriodChange = (periodId: string) => {
    setLocation(`/review?uploadId=${uploadId}&periodId=${periodId}`);
  };

  const mapMutation = useMutation({
    mutationFn: async ({
      nodeId,
      category,
      status,
    }: { nodeId: string; category: string; status?: 'mapped' | 'excluded' }) => {
      return await apiRequest('POST', `/api/nodes/${nodeId}/map`, { category, status });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: [`/api/uploads/${uploadId}/nodes`] });
      const excluded = variables.status === 'excluded';
      toast({
        title: excluded ? "Excluded from report" : "Category assigned",
        description: excluded
          ? "This line no longer counts toward any total. You can put it back at any time."
          : "The P&L item has been mapped to a ClearPath category",
      });
      setCategoryDialogOpen(false);
      setSelectedNode(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to assign category",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  /**
   * Confirming is an explicit act, not an inference from silence.
   *
   * Declared here, above the early returns, because every hook must be: this one was written
   * below them, so the loading render ran one hook fewer than the loaded render and React tore
   * the whole tree down (error #310) the moment the data arrived — a blank page on every visit
   * to this screen.
   *
   * Mapping a line records it, but a line the heuristics got right and the user simply agreed
   * with was never recorded — so it got re-guessed next month. Rather than treat "didn't
   * change it" as "chose it", which would enshrine guesses nobody examined, finishing review
   * is the moment the user says the whole mapping is right. Then it is all remembered.
   */
  const confirmMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', `/api/uploads/${uploadId}/confirm`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/uploads"] });
      setLocation(`/dashboard?uploadId=${uploadId}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't save your mapping",
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
            <AlertCircle className="h-12 w-12 text-destructive" />
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">No Upload Selected</h2>
              <p className="text-sm text-muted-foreground">
                Please select an upload from your dashboard to review P&L categories.
              </p>
            </div>
            <Button onClick={() => setLocation('/upload')} data-testid="button-go-to-uploads">
              Go to Uploads
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
          <p className="text-sm text-muted-foreground">Loading P&L data...</p>
        </div>
      </div>
    );
  }

  const nodes = data?.nodes || [];
  const leafNodes = nodes.filter(n => n.amountCents !== null && n.isRollup === 0);
  const excludedCount = leafNodes.filter(n => n.mappingStatus === 'excluded').length;
  const countedNodes = leafNodes.filter(n => n.mappingStatus !== 'excluded');
  const mappedCount = countedNodes.filter(n => n.mappedCategory).length;

  // What actually needs the user's attention.
  //
  // This deliberately is NOT "leaves with no mapping". Auto-mapping assigns a category to
  // every leaf, so nothing is ever literally unmapped and the old counter sat at zero
  // forever. The real signal is the parser's own uncertainty, which is what `needs_review`
  // records — including every ambiguous COGS-vs-Services line and every row the Phase 2
  // migration flagged. Excluded lines are settled decisions and never count here.
  const needsReviewNodes = countedNodes.filter(
    n => !n.mappedCategory || n.confidence === 'needs_review',
  );
  const needsReviewCount = needsReviewNodes.length;

  // Lines pre-filled from a decision this user made on an earlier upload, rather than from the
  // keyword heuristics. Counted across every leaf, excluded ones included — a remembered
  // exclusion is still the memory doing its job.
  const rememberedCount = leafNodes.filter(n => n.fromMemory).length;

  const handleEditCategory = (node: PLNode) => {
    setSelectedNode(node);
    setSelectedCategory(node.mappedCategory || node.suggestedCategory || '');
    setCategoryDialogOpen(true);
  };

  const handleSaveCategory = () => {
    if (selectedNode && selectedCategory) {
      mapMutation.mutate({ nodeId: selectedNode.id, category: selectedCategory, status: 'mapped' });
    }
  };

  // One control, both intents. "This is a subtotal that double-counts" and "this is real but
  // I don't want it in this report" produce the same outcome — the line stops counting — and
  // the difference between them is invisible to a lay user, so we don't ask them to classify it.
  //
  // The node keeps its category, so putting it back is a single field change, and the
  // parser's own `isRollup` judgement is left untouched: the machine's guess and the user's
  // override stay separately legible.
  const handleToggleExcluded = (node: PLNode) => {
    const nowExcluded = node.mappingStatus !== 'excluded';
    mapMutation.mutate({
      nodeId: node.id,
      category: node.mappedCategory || node.suggestedCategory || 'opex_systems',
      status: nowExcluded ? 'excluded' : 'mapped',
    });
  };

  const handleContinue = () => confirmMutation.mutate();

  const getCategoryBadge = (node: PLNode, category: string | null) => {
    if (node.mappingStatus === 'excluded') {
      return (
        <Badge variant="outline" className="text-xs border-dashed text-muted-foreground gap-1">
          {node.fromMemory && <History className="h-3 w-3" />}
          {node.fromMemory ? 'Excluded before' : 'Excluded'}
        </Badge>
      );
    }
    if (!category) {
      return <Badge variant="outline" className="text-xs">Unmapped</Badge>;
    }
    if (node.confidence === 'needs_review') {
      return (
        <Badge variant="secondary" className="text-xs">
          {categoryLabel(category)} · check this
        </Badge>
      );
    }
    if (node.fromMemory) {
      return (
        <Badge className="text-xs gap-1">
          <History className="h-3 w-3" />
          {categoryLabel(category)}
        </Badge>
      );
    }
    return <Badge className="text-xs">{categoryLabel(category)}</Badge>;
  };

  const formatAmount = (cents: number | null) => {
    if (cents === null) return '';
    const amount = cents / 100;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="space-y-8">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold">Review & Map P&L Categories</h1>
            <p className="text-muted-foreground">
              Review auto-mapped categories and assign any unmapped items to ClearPath categories
            </p>
          </div>

          {uploadPeriods.length > 1 && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Period (amounts shown below):</span>
              <Select value={activePeriodId ?? undefined} onValueChange={handlePeriodChange}>
                <SelectTrigger className="w-64" data-testid="select-review-period">
                  <SelectValue placeholder="Select a period" />
                </SelectTrigger>
                <SelectContent>
                  {uploadPeriods.map(p => (
                    <SelectItem key={p.id} value={p.id} data-testid={`option-period-${p.id}`}>
                      {p.label}{!p.confirmed ? " (unconfirmed)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                Mapping applies to every period in this upload — only the amounts shown change.
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card className="p-6">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Total Categories
                </p>
                <p className="text-4xl font-bold">
                  {leafNodes.length}
                </p>
                <p className="text-sm text-muted-foreground">P&L line items</p>
              </div>
            </Card>
            <Card className="p-6">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Mapped
                </p>
                <p className="text-4xl font-bold text-status-healthy">
                  {mappedCount}
                </p>
                <p className="text-sm text-muted-foreground">Categories assigned</p>
              </div>
            </Card>
            <Card className="p-6">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Needs your review
                </p>
                <p className="text-4xl font-bold text-status-warning">
                  {needsReviewCount}
                </p>
                <p className="text-sm text-muted-foreground">Uncertain or unassigned</p>
              </div>
            </Card>
            <Card className="p-6">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Excluded
                </p>
                <p className="text-4xl font-bold text-muted-foreground">
                  {excludedCount}
                </p>
                <p className="text-sm text-muted-foreground">Not counted in the report</p>
              </div>
            </Card>
          </div>

          {rememberedCount > 0 && (
            <div className="rounded-lg border border-status-healthy/20 bg-status-healthy/5 p-4 flex gap-3">
              <History className="h-5 w-5 text-status-healthy shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-sm">
                  {rememberedCount} line{rememberedCount === 1 ? '' : 's'} filled in from how you
                  mapped {rememberedCount === 1 ? 'it' : 'them'} before
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Your own earlier decisions carry forward, so each month should ask less of you
                  than the last. Anything the system is less sure about — a line that moved, or an
                  exclusion — is flagged below rather than applied quietly. Change any of them and
                  the new choice is what carries forward next time.
                </p>
              </div>
            </div>
          )}

          {needsReviewCount > 0 && (
            <div className="rounded-lg border border-status-warning/20 bg-status-warning/5 p-4 flex gap-3">
              <AlertCircle className="h-5 w-5 text-status-warning shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-sm">
                  {needsReviewCount} line{needsReviewCount === 1 ? '' : 's'} worth a second look
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Either the guess wasn't confident — most often when telling materials (COGS)
                  apart from delivery labor (Services) — or something carried over from a previous
                  month that's worth confirming: a line whose name matched but whose position in
                  the statement moved, or one you excluded before. Check the category, or exclude
                  the line if it shouldn't count at all.
                </p>
              </div>
            </div>
          )}

          {excludedCount > 0 && (
            <div className="rounded-lg border border-border bg-muted/40 p-4 flex gap-3">
              <EyeOff className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-sm">
                  {excludedCount} line{excludedCount === 1 ? ' is' : 's are'} excluded from this report
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Excluded lines still appear below, greyed out. They don't count toward any total
                  and they don't need mapping — use "Include" to put one back.
                </p>
              </div>
            </div>
          )}

          <Card className="p-6">
            <div className="space-y-3">
              {nodes.map((node) => {
                const isLeaf = node.amountCents !== null && node.isRollup === 0;
                const isRollup = node.isRollup === 1;
                const isStructural = node.amountCents === null && !isRollup;
                const category = node.mappedCategory || node.suggestedCategory;
                const isExcluded = node.mappingStatus === 'excluded';

                return (
                  <div
                    key={node.id}
                    className={`flex items-center justify-between py-2 ${
                      isLeaf ? 'hover-elevate rounded px-3' : 'px-3'
                    } ${isExcluded ? 'opacity-55' : ''}`}
                    style={{ paddingLeft: `${node.level * 24 + 12}px` }}
                    data-testid={`node-${node.id}`}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {isLeaf && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-sm truncate ${
                            isStructural
                              ? 'text-muted-foreground font-medium'
                              : isRollup
                              ? 'font-semibold'
                              : ''
                          }`}
                        >
                          {node.label}
                        </p>
                      </div>
                      {isLeaf && (
                        <div className="flex items-center gap-3 shrink-0">
                          <span
                            className={`text-sm font-medium tabular-nums ${
                              isExcluded ? 'line-through text-muted-foreground' : ''
                            }`}
                          >
                            {formatAmount(node.amountCents)}
                          </span>
                          {getCategoryBadge(node, category)}
                          {!isExcluded && category && (
                            <ExplainerPopover
                              label={categoryLabel(category)}
                              body={CATEGORY_EXPLAINERS[category as ClearpathCategory].body}
                              testId={`explainer-${node.id}`}
                            />
                          )}
                          {!isExcluded && !node.mappedCategory && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleEditCategory(node)}
                              data-testid={`button-assign-${node.id}`}
                            >
                              Assign Category
                            </Button>
                          )}
                          {!isExcluded && node.mappedCategory && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleEditCategory(node)}
                              data-testid={`button-edit-${node.id}`}
                            >
                              <Check
                                className={`h-4 w-4 mr-1 ${
                                  node.confidence === 'needs_review'
                                    ? 'text-status-warning'
                                    : 'text-status-healthy'
                                }`}
                              />
                              {node.confidence === 'needs_review'
                                ? 'Review'
                                : node.fromMemory
                                  ? 'As before'
                                  : 'Mapped'}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleToggleExcluded(node)}
                            disabled={mapMutation.isPending}
                            title={
                              isExcluded
                                ? 'Put this line back into the report'
                                : "Take this line out of the report — use it for subtotals that double-count, or anything that shouldn't be counted"
                            }
                            data-testid={`button-exclude-${node.id}`}
                          >
                            {isExcluded ? (
                              <>
                                <Eye className="h-4 w-4 mr-1" />
                                Include
                              </>
                            ) : (
                              <>
                                <EyeOff className="h-4 w-4 mr-1" />
                                Exclude
                              </>
                            )}
                          </Button>
                        </div>
                      )}
                      {isRollup && node.amountCents !== null && (
                        <span className="text-sm font-semibold tabular-nums shrink-0">
                          {formatAmount(node.amountCents)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Confirming saves these categories as your defaults, so next month's statement
              arrives already mapped this way. You can change any of them later — the newest
              choice is the one that carries forward.
            </p>
            <div className="flex justify-end gap-3 shrink-0">
            <Button
              variant="outline"
              onClick={() => setLocation('/upload')}
              data-testid="button-back"
            >
              Back to Upload
            </Button>
            <Button
              onClick={handleContinue}
              disabled={confirmMutation.isPending}
              data-testid="button-continue"
            >
              {confirmMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
              ) : (
                "Confirm mapping & view report"
              )}
            </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent data-testid="dialog-assign-category">
          <DialogHeader>
            <DialogTitle>Assign ClearPath Category</DialogTitle>
            <DialogDescription>
              Select the category that best describes this P&L item
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Line Item</p>
              <p className="text-sm text-muted-foreground">{selectedNode?.label}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Amount</p>
              <p className="text-sm font-semibold">
                {formatAmount(selectedNode?.amountCents ?? null)}
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium">ClearPath Category</p>
                {selectedCategory && (
                  <ExplainerPopover
                    label={categoryLabel(selectedCategory)}
                    body={CATEGORY_EXPLAINERS[selectedCategory as ClearpathCategory].body}
                    testId="explainer-dialog-category"
                  />
                )}
              </div>
              <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                <SelectTrigger data-testid="select-category">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {CLEARPATH_CATEGORIES.map((cat) => (
                    <SelectItem key={cat.value} value={cat.value} data-testid={`option-${cat.value}`}>
                      {cat.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!selectedCategory && (
                <p className="text-xs text-muted-foreground">
                  Pick a category to see what it means before you save.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCategoryDialogOpen(false)}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveCategory}
              disabled={!selectedCategory || mapMutation.isPending}
              data-testid="button-save-category"
            >
              {mapMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Category'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
