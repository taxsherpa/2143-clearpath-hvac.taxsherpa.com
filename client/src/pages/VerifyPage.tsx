import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Footer } from "@/components/Footer";
import { AlertCircle, Loader2, ShieldCheck, TrendingUp } from "lucide-react";

/**
 * 2-step magic-link transition page (Core Software Directives §1).
 *
 * Loading this page does NOT consume the token — nothing is sent to the server until the
 * user presses the button below. Corporate email scanners pre-fetch inbound links; if the
 * emailed URL logged the user in on GET, the scanner would burn the single-use token
 * before the human ever saw it. The deliberate click is the whole point of this screen.
 */
export default function VerifyPage() {
  const [, setLocation] = useLocation();
  const { verifyMutation } = useAuth();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
  }, []);

  const handleVerify = () => {
    if (!token) return;
    verifyMutation.mutate({ token }, { onSuccess: () => setLocation("/") });
  };

  const missingToken = token === null;
  const failure = verifyMutation.error?.message;

  return (
    <div className="min-h-screen bg-background flex flex-col">
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
            <TrendingUp className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-3xl font-bold mb-2">ClearPath Mapper</h1>
        </div>

        <Card className="p-6 text-center space-y-5">
          {missingToken || failure ? (
            <>
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-destructive/10">
                <AlertCircle className="h-6 w-6 text-destructive" />
              </div>
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">This link didn't work</h2>
                <p className="text-sm text-muted-foreground" data-testid="text-verify-error">
                  {failure ?? "This sign-in link is missing its token. Request a fresh one below."}
                </p>
              </div>
              <Button className="w-full" onClick={() => setLocation("/auth")} data-testid="button-request-new-link">
                Request a new sign-in link
              </Button>
            </>
          ) : (
            <>
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
                <ShieldCheck className="h-6 w-6 text-primary" />
              </div>
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">One more click</h2>
                <p className="text-sm text-muted-foreground">
                  For your security, we ask you to confirm the sign-in yourself rather than
                  completing it automatically.
                </p>
              </div>
              <Button
                className="w-full"
                onClick={handleVerify}
                disabled={verifyMutation.isPending}
                data-testid="button-confirm-signin"
              >
                {verifyMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Securely Open My ClearPath Dashboard
              </Button>
            </>
          )}
        </Card>
      </div>
    </div>
      <Footer />
    </div>
  );
}
