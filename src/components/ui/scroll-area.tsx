"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  hideScrollbar = false,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { hideScrollbar?: boolean }) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn(
        "relative",
        hideScrollbar && "scrollbar-hide",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="h-full w-full -fs-scrollbar">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className={cn(
          "absolute right-1 top-1 bottom-1 z-10 w-1.5",
          "bg-muted/30 rounded-full",
          "transition-opacity duration-200 opacity-0 hover:opacity-100 focus:opacity-100",
          "touch-opacity-100"
        )}
      >
        <ScrollAreaPrimitive.Thumb
          className={cn(
            "relative flex-1 rounded-full bg-muted-foreground/30",
            "transition-all duration-200",
            "hover:bg-muted-foreground/50",
            "active:bg-muted-foreground/70",
            "min-h-8"
          )}
        />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar
        orientation="horizontal"
        className={cn(
          "absolute left-1 right-1 bottom-1 z-10 h-1.5",
          "bg-muted/30 rounded-full",
          "transition-opacity duration-200 opacity-0 hover:opacity-100 focus:opacity-100",
          "touch-opacity-100"
        )}
      >
        <ScrollAreaPrimitive.Thumb
          className={cn(
            "relative flex-1 rounded-full bg-muted-foreground/30",
            "transition-all duration-200",
            "hover:bg-muted-foreground/50",
            "active:bg-muted-foreground/70",
            "min-w-8"
          )}
        />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="bg-muted/30" />
    </ScrollAreaPrimitive.Root>
  )
}

export { ScrollArea }