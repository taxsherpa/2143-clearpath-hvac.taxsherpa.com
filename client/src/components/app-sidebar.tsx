import { useLocation, Link } from "wouter";
import { Upload, FileText, FileBarChart, LogOut, TrendingUp, Settings as SettingsIcon } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";

// The three steps are numbered because they are a sequence, not four peer destinations.
// "Dashboard" used to sit here in the third slot, which reads as a place to start — but it is
// the last step and is empty until an upload has been mapped. It is now "Report", numbered.
const stepItems = [
  {
    title: "1. Upload P&L",
    url: "/upload",
    icon: Upload,
  },
  {
    title: "2. Review & Map",
    url: "/review",
    icon: FileText,
  },
  {
    title: "3. Report",
    url: "/dashboard",
    icon: FileBarChart,
  },
];

// Sits outside the numbering: it spans uploads rather than belonging to one.
const toolItems = [
  {
    title: "Compare Periods",
    url: "/compare",
    icon: TrendingUp,
  },
];

const accountItems = [
  {
    title: "Account settings",
    url: "/settings",
    icon: SettingsIcon,
  },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logoutMutation } = useAuth();

  const handleLogout = () => {
    logoutMutation.mutate();
  };

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">CP</span>
          </div>
          <div>
            <h1 className="font-semibold text-sm">ClearPath</h1>
            <p className="text-xs text-muted-foreground">For HVAC shops</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Get your report</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {stepItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={location === item.url || (item.url === "/upload" && location === "/")}
                  >
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Across periods</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {toolItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={location === item.url}>
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Account</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {accountItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={location === item.url}>
                    <Link href={item.url} data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 border-t">
        {user && (
          <div className="space-y-3">
            <div className="text-sm">
              <p className="text-muted-foreground text-xs">Signed in as</p>
              <p className="font-medium truncate">{user.email}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={handleLogout}
              disabled={logoutMutation.isPending}
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4 mr-2" />
              {logoutMutation.isPending ? "Signing out..." : "Sign out"}
            </Button>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
