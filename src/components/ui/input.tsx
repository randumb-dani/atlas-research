import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "@/lib/utils"

function Input({
  className,
  type,
  error,
  ...props
}: React.ComponentProps<"input"> & { error?: boolean }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-error={error ? "" : undefined}
      className={cn(
        "w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-sm transition-colors-fast focus-ring",
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

export { Input }