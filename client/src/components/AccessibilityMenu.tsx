import { Accessibility } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAccessibility } from "@/hooks/use-accessibility";

/**
 * Fixed, always-reachable control for Phase 4.3's three accessibility settings — rendered once
 * at the top of the app (outside the router branching) so it's present on every route: signed-in
 * app shell, /auth, /verify, /privacy, and /terms alike.
 */
export function AccessibilityMenu() {
  const { settings, setColorMode, setFontFamily, setFontSize } = useAccessibility();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          className="fixed bottom-4 right-4 z-50 rounded-full shadow-md h-11 w-11"
          aria-label="Display and accessibility settings"
          data-testid="button-accessibility-menu"
        >
          <Accessibility className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-5" data-testid="panel-accessibility-menu">
        <div>
          <h2 className="font-semibold text-sm">Display &amp; accessibility</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            These change how this browser shows ClearPath — nothing here is shared with anyone
            else on your account.
          </p>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium block">Color &amp; contrast</span>
          <ToggleGroup
            type="single"
            variant="outline"
            value={settings.colorMode}
            onValueChange={v => v && setColorMode(v as typeof settings.colorMode)}
            className="grid grid-cols-3"
          >
            <ToggleGroupItem value="light" data-testid="toggle-color-light" aria-label="Light mode">
              Light
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" data-testid="toggle-color-dark" aria-label="Dark mode">
              Dark
            </ToggleGroupItem>
            <ToggleGroupItem value="high-contrast" data-testid="toggle-color-high-contrast" aria-label="High contrast mode">
              High contrast
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium block">Font</span>
          <ToggleGroup
            type="single"
            variant="outline"
            value={settings.fontFamily}
            onValueChange={v => v && setFontFamily(v as typeof settings.fontFamily)}
            className="grid grid-cols-3"
          >
            <ToggleGroupItem value="default" data-testid="toggle-font-default" aria-label="Default font">
              Default
            </ToggleGroupItem>
            <ToggleGroupItem value="serif" data-testid="toggle-font-serif" aria-label="Serif font">
              Serif
            </ToggleGroupItem>
            <ToggleGroupItem value="accessible" data-testid="toggle-font-accessible" aria-label="Accessible font, designed for readability">
              Accessible
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium block">Text size</span>
          <ToggleGroup
            type="single"
            variant="outline"
            value={settings.fontSize}
            onValueChange={v => v && setFontSize(v as typeof settings.fontSize)}
            className="grid grid-cols-4"
          >
            <ToggleGroupItem value="small" data-testid="toggle-size-small" aria-label="Small text">
              S
            </ToggleGroupItem>
            <ToggleGroupItem value="default" data-testid="toggle-size-default" aria-label="Default text size">
              M
            </ToggleGroupItem>
            <ToggleGroupItem value="large" data-testid="toggle-size-large" aria-label="Large text">
              L
            </ToggleGroupItem>
            <ToggleGroupItem value="x-large" data-testid="toggle-size-x-large" aria-label="Extra large text">
              XL
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default AccessibilityMenu;
