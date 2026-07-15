import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"

import { cn } from "@/lib/utils"
import { ChevronDownIcon } from "lucide-react"

function Collapsible({
  className,
  ...props
}: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      className={cn("w-full", className)}
      {...props}
    />
  )
}

function CollapsibleTrigger({
  className,
  children,
  ...props
}: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "group/collapsible-trigger flex w-full items-center gap-2 rounded-lg border border-transparent py-2 text-sm font-medium transition-all outline-none hover:underline focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/collapsible-trigger:rotate-180" />
      {children}
    </CollapsiblePrimitive.Trigger>
  )
}

function CollapsiblePanel({
  className,
  children,
  ...props
}: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className="overflow-hidden data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-up-0.5 data-open:animate-in data-open:fade-in-0 data-open:slide-in-up-0.5"
      {...props}
    >
      <div className={cn("pb-2", className)}>
        {children}
      </div>
    </CollapsiblePrimitive.Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel }
