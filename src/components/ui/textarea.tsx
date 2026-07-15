import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({
  className,
  error,
  ...props
}: React.ComponentProps<"textarea"> & { error?: boolean }) {
  return (
    <textarea
      data-slot="textarea"
      data-error={error ? "" : undefined}
      className={cn(
        "w-full min-w-0 min-h-[80px] rounded-lg border bg-background px-3 py-2 text-sm transition-colors-fast focus-ring resize-none",
        "placeholder:text-muted-foreground",
        "disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
        error
          ? "border-destructive focus-visible:ring-destructive/40"
          : "border-input focus-visible:border-ring",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }