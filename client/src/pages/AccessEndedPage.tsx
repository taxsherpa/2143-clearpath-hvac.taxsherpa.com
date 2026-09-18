import { useState } from "react";
import { useAuth, type AccessEnded } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Footer } from "@/components/Footer";
import { CalendarClock, Loader2, TrendingUp } from "lucide-react";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Shown in place of the app when the session is valid but paid access has ended, or has not
 * started yet. Uploads are kept — the page says so — and the user can still sign out or
 * delete their saved data, which the server allows without active access.
 */
export default function AccessEndedPage({ info }: { info: AccessEnded }) {
  const { logoutMutation } = useAuth();
  const { toast } = useToast();
  const [purging, setPurging] = useState(false);

  const notStarted = info.startsAt !== null;

  const heading = notStarted ? "Your access hasn't started yet" : "Your access has ended";
  const body = notStarted
    ? `Your ClearPath HVAC access starts on ${formatDate(info.startsAt!)}. Come back on or after that date.`
    : info.endedAt
      ? `Your ClearPath HVAC access ended on ${formatDate(info.endedAt)}. Your uploads and reports are still saved, and they'll be here if you renew.`
      : "There's no active ClearPath HVAC access for this account. Access is included with a Tax Sherpa workshop ticket.";

  const handleDeleteData = async () => {
    const confirmed = window.confirm(
      "Delete all your uploaded P&L data and reports? This can't be undone. Your sign-in email is kept.",
    );
    if (!confirmed) return;

    setPurging(true);
    try {
      const response = await fetch("/api/account/data?keepRules=false", { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      toast({ title: "Your data was deleted", description: "Your uploads and reports are gone." });
    } catch {
      toast({
        title: "Couldn't delete your data",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
              <TrendingUp className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-3xl font-bold mb-2">ClearPath HVAC</h1>
          </div>

          <Card className="p-6 text-center space-y-5" data-testid="access-ended">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
              <CalendarClock className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">{heading}</h2>
              <p className="text-sm text-muted-foreground">{body}</p>
              <p className="text-xs text-muted-foreground">Signed in as {info.email}</p>
            </div>

            {!notStarted && info.purchaseUrl && (
              <Button asChild className="w-full" data-testid="button-renew-access">
                <a href={info.purchaseUrl}>{info.endedAt ? "Renew access" : "Get access"}</a>
              </Button>
            )}

            <Button
              variant="outline"
              className="w-full"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              data-testid="button-access-ended-sign-out"
            >
              Sign out
            </Button>

            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={handleDeleteData}
              disabled={purging}
              data-testid="button-access-ended-delete-data"
            >
              {purging && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete my saved data
            </Button>
          </Card>
        </div>
      </div>
      <Footer />
    </div>
  );
}
