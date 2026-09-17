import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { AccessibilityProvider } from "@/hooks/use-accessibility";
import { AccessibilityMenu } from "@/components/AccessibilityMenu";
import { ProtectedRoute } from "@/lib/protected-route";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import NotFound from "@/pages/not-found";
import Upload from "@/pages/Upload";
import Review from "@/pages/Review";
import Dashboard from "@/pages/Dashboard";
import Comparison from "@/pages/Comparison";
import Settings from "@/pages/Settings";
import AuthPage from "@/pages/AuthPage";
import VerifyPage from "@/pages/VerifyPage";
import AccessEndedPage from "@/pages/AccessEndedPage";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";
import { Footer } from "@/components/Footer";

function MainLayout({ children }: { children: React.ReactNode }) {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center h-12 px-4 border-b bg-background shrink-0">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
          </header>
          <main className="flex-1 overflow-auto flex flex-col">
            <div className="flex-1">{children}</div>
            <Footer />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function Router() {
  const [location] = useLocation();
  const { accessEnded } = useAuth();
  // Sign-in, legal, and the app shell each render on their own — a user with no session has
  // no sidebar to show, and the legal pages must be reachable without one, per Phase 4.1.
  if (location === "/auth") {
    return <AuthPage />;
  }

  if (location === "/verify") {
    return <VerifyPage />;
  }

  if (location === "/privacy") {
    return <Privacy />;
  }

  if (location === "/terms") {
    return <Terms />;
  }

  // A valid session whose paid access has ended gets this in place of the whole app shell —
  // not a redirect to /auth, which would loop, since signing in again cannot succeed.
  if (accessEnded) {
    return <AccessEndedPage info={accessEnded} />;
  }

  return (
    <MainLayout>
      <Switch>
        <Route path="/">
          <ProtectedRoute component={Upload} />
        </Route>
        <Route path="/settings">
          <ProtectedRoute component={Settings} />
        </Route>
        <Route path="/upload">
          <ProtectedRoute component={Upload} />
        </Route>
        <Route path="/review">
          <ProtectedRoute component={Review} />
        </Route>
        <Route path="/dashboard">
          <ProtectedRoute component={Dashboard} />
        </Route>
        <Route path="/compare">
          <ProtectedRoute component={Comparison} />
        </Route>
        <Route component={NotFound} />
      </Switch>
    </MainLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AccessibilityProvider>
          <AuthProvider>
            <Toaster />
            <Router />
            <AccessibilityMenu />
          </AuthProvider>
        </AccessibilityProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
