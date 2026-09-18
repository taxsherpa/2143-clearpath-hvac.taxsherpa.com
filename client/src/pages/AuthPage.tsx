import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Footer } from "@/components/Footer";
import { Loader2, MailCheck, TrendingUp } from "lucide-react";

export default function AuthPage() {
  const [, setLocation] = useLocation();
  const { user, magicLinkMutation } = useAuth();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  // While this loads (or if it fails) the page keeps its original open-signup wording,
  // which is also exactly right when the access gate is off.
  const { data: authConfig } = useQuery<{ accessGateEnabled: boolean; purchaseUrl: string | null }>({
    queryKey: ["/api/auth/config"],
  });
  const gated = authConfig?.accessGateEnabled === true;

  useEffect(() => {
    if (user) setLocation("/");
  }, [user, setLocation]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    magicLinkMutation.mutate({ email: address }, { onSuccess: () => setSentTo(address) });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex flex-1">
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
              <TrendingUp className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-3xl font-bold mb-2">ClearPath HVAC</h1>
            <p className="text-muted-foreground">See where your money actually goes — measured against HVAC shops your size</p>
          </div>

          <Card className="p-6">
            {sentTo ? (
              <div className="text-center space-y-4" data-testid="magic-link-sent">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
                  <MailCheck className="h-6 w-6 text-primary" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-semibold">Check your email</h2>
                  {gated ? (
                    // Deliberately doesn't say whether this address has access: the server
                    // answers identically either way, and so does the page.
                    <p className="text-sm text-muted-foreground">
                      We sent an email to <span className="font-medium text-foreground">{sentTo}</span>.
                      If this address has ClearPath HVAC access, it contains a sign-in link that works
                      once and expires in 20 minutes. If not, it explains how to get access.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      We sent a sign-in link to <span className="font-medium text-foreground">{sentTo}</span>.
                      Open it and click the button inside. The link works once and expires in 20 minutes.
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => setSentTo(null)}
                  data-testid="button-use-different-email"
                >
                  Use a different email
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    data-testid="input-email"
                  />
                  <p className="text-xs text-muted-foreground">
                    {gated
                      ? "No password needed. Use the email you registered with — ClearPath HVAC access comes with a Tax Sherpa workshop ticket."
                      : "No password needed. We'll email you a secure sign-in link. If you don't have an account yet, one is created the first time you sign in."}
                  </p>
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={magicLinkMutation.isPending}
                  data-testid="button-send-magic-link"
                >
                  {magicLinkMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Email me a sign-in link
                </Button>
              </form>
            )}
          </Card>
        </div>
      </div>

      <div className="hidden lg:flex flex-1 bg-primary/5 items-center justify-center p-12">
        <div className="max-w-lg space-y-6">
          <h2 className="text-3xl font-bold">The ClearPath Insight Framework</h2>
          <div className="space-y-4 text-muted-foreground">
            <p>
              Upload your P&amp;L export and ClearPath HVAC sorts every line into the categories
              that actually drive your business — then shows you where you stand against the
              benchmarks for your revenue tier.
            </p>
            <ul className="space-y-2">
              <li className="flex gap-2">
                <span className="text-primary">✓</span>
                <span>Auto-sorts your line items, with confidence levels you can correct</span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary">✓</span>
                <span>Plain-English explanation of every category</span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary">✓</span>
                <span>Benchmarks against targets for your revenue tier</span>
              </li>
              <li className="flex gap-2">
                <span className="text-primary">✓</span>
                <span>Export the remapped CSV and a PDF summary</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
      </div>
      <Footer />
    </div>
  );
}
