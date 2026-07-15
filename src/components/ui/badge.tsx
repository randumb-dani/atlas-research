import * as React from "react"
import { cn } from "@/lib/utils"

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "outline" | "secondary" | "success" | "warning" | "destructive" | "info"
  size?: "sm" | "md" | "lg"
}

const badgeVariants = {
  default: "bg-primary/15 text-primary border border-primary/30",
  outline: "bg-transparent text-foreground border border-border",
  secondary: "bg-secondary text-secondary-foreground border border-transparent",
  success: "bg-success-muted text-success border border-success/30",
  warning: "bg-warning-muted text-warning border border-warning/30",
  destructive: "bg-destructive-muted text-destructive border border-destructive/30",
  info: "bg-info-muted text-info border border-info/30",
}

const sizeVariants = {
  sm: "px-2 py-0.5 text-[10px] gap-1 [&_svg]:size-2.5",
  md: "px-2.5 py-0.5 text-xs gap-1.5 [&_svg]:size-3",
  lg: "px-3 py-1 text-sm gap-2 [&_svg]:size-3.5",
}

function Badge({
  className,
  variant = "default",
  size = "md",
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-medium rounded-full border transition-colors-fast",
        badgeVariants[variant],
        sizeVariants[size],
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

export { Badge }