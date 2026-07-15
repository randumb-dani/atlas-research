"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "@/lib/utils"

function TooltipProvider({ children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider {...props}>{children}</TooltipPrimitive.Provider>
}

function Tooltip({
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Root {...props}>
      {children}
    </TooltipPrimitive.Root>
  )
}

function TooltipTrigger({ delay = 600, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger delay={delay} {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & {
  className?: string
  side?: "top" | "bottom" | "left" | "right"
  sideOffset?: number
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          className={cn(
            "z-[var(--z-tooltip)] rounded-lg bg-popover text-popover-foreground px-3 py-1.5 text-xs font-medium shadow-elev-3",
            "animate-fade-in animate-slide-up",
            className
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent }
