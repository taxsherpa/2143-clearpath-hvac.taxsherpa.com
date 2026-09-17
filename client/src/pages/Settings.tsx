import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";

interface Upload {
  id: string;
  monthStart: string;
}

/**
 * Account settings.
 *
 * Currently just the self-serve data purge. The important thing this screen has to get right is
 * saying plainly what a purge does and does not do — deleting your financial data is not the
 * same as deleting your account or unsubscribing, and a user who confuses the three will be
 * unpleasantly surprised either way round.
 */
export default function Settings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [confirmText, setConfirmText] = useState("");
  const [keepRules, setKeepRules] = useState(false);

  const { data: uploads } = useQuery<Upload[]>({ queryKey: ["/api/uploads"] });
  const uploadCount = uploads?.length ?? 0;

  const purgeMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/account/data?keepRules=${keepRules}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to purge data");
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries();
      setConfirmText("");
      toast({
        title: "Your data has been deleted",
        description: `${data.uploadsDeleted} upload${data.uploadsDeleted === 1 ? "" : "s"} removed`
          + (data.rulesKept
            ? ". Your remembered mappings were kept."
            : data.rulesDeleted
              ? `, along with ${data.rulesDeleted} remembered mapping${data.rulesDeleted === 1 ? "" : "s"}.`
              : "."),
      });
      setLocation("/upload");
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete data", description: error.message, variant: "destructive" });
    },
  });

  const confirmed = confirmText.trim().toUpperCase() === "DELETE";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <div>
          <h1 className="text-2xl font-semibold">Account settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Signed in as {user?.email}</p>
        </div>

        <Card className="p-6 border-destructive/30">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 space-y-4">
              <div>
                <h2 className="font-semibold">Delete my financial data</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Permanently removes every P&amp;L you've uploaded, along with its line items,
                  category mappings and reports. This cannot be undone — there is no backup and
                  no recycle bin.
                </p>
              </div>

              <div className="rounded-md bg-muted/50 p-4 text-sm space-y-3">
                <div>
                  <p className="font-medium mb-1">What gets deleted</p>
                  <ul className="text-muted-foreground space-y-0.5 list-disc pl-5">
                    <li>
                      {uploadCount === 0
                        ? "Your uploaded P&L statements (you have none right now)"
                        : `Your ${uploadCount} uploaded P&L statement${uploadCount === 1 ? "" : "s"}`}
                    </li>
                    <li>Every line item and category mapping in them</li>
                    <li>Any reports generated from them</li>
                    <li>Your remembered mappings, unless you keep them below</li>
                  </ul>
                </div>
                <div>
                  <p className="font-medium mb-1">What stays</p>
                  <ul className="text-muted-foreground space-y-0.5 list-disc pl-5">
                    <li>
                      <strong>Your account and email address.</strong> Deleting your data is not
                      the same as closing your account — you stay signed in and can upload again
                      straight away.
                    </li>
                    <li>
                      Your contact preferences. This action doesn't unsubscribe you from anything;
                      that's a separate choice.
                    </li>
                  </ul>
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={keepRules}
                  onCheckedChange={v => setKeepRules(v === true)}
                  data-testid="checkbox-keep-rules"
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Keep my remembered mappings.</span>{" "}
                  <span className="text-muted-foreground">
                    Leave this unticked to start completely fresh — the next upload will be
                    categorized from scratch. Tick it to clear your statements but keep the
                    system's memory of how you've categorized each line before.
                  </span>
                </span>
              </label>

              <div className="space-y-2">
                <label className="text-sm font-medium block" htmlFor="confirm-delete">
                  Type <span className="font-mono">DELETE</span> to confirm
                </label>
                <Input
                  id="confirm-delete"
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder="DELETE"
                  className="max-w-xs"
                  autoComplete="off"
                  data-testid="input-confirm-delete"
                />
              </div>

              <Button
                variant="destructive"
                disabled={!confirmed || purgeMutation.isPending}
                onClick={() => purgeMutation.mutate()}
                data-testid="button-purge-data"
              >
                {purgeMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deleting…</>
                ) : (
                  <><Trash2 className="h-4 w-4 mr-2" />Delete my data</>
                )}
              </Button>
            </div>
          </div>
        </Card>

        <p className="text-sm text-muted-foreground">
          To remove a single statement instead of everything, open it from{" "}
          <button
            className="underline hover:no-underline"
            onClick={() => setLocation("/upload")}
            data-testid="link-uploads"
          >
            your uploads
          </button>{" "}
          and use the delete option on its report.
        </p>
      </div>
    </div>
  );
}
