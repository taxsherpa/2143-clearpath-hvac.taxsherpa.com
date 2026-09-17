import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Phase 3.2's shared trigger component, built here per the Phase 3 plan (3.1 decided the
 * mechanism — info icon + click/tap Popover, not Tooltip — but deliberately left the trigger
 * itself unbuilt). Takes plain `label`/`body` strings rather than a category enum so 3.3 and
 * 3.4 can reuse it for the two calculated metrics (`METRIC_EXPLAINERS`) too, not just the seven
 * mappable categories (`CATEGORY_EXPLAINERS`) this sub-phase wires in.
 */
interface ExplainerPopoverProps {
  label: string;
  body: string;
  className?: string;
  testId?: string;
}

export function ExplainerPopover({ label, body, className, testId }: ExplainerPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={`h-6 w-6 shrink-0 text-muted-foreground ${className ?? ""}`}
          aria-label={`What does "${label}" mean?`}
          data-testid={testId}
          onClick={(e) => e.stopPropagation()}
        >
          <Info className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="text-sm" onClick={(e) => e.stopPropagation()}>
        <p className="font-medium mb-1">{label}</p>
        <p className="text-muted-foreground">{body}</p>
      </PopoverContent>
    </Popover>
  );
}
