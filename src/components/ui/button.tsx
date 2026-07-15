import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-colors-fast focus-ring disabled:pointer-events-none disabled:opacity-50 select-none",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover elev-primary-1",
        brand: "bg-primary text-primary-foreground hover:bg-primary-hover elev-primary-2 active:elev-primary-1",
        outline: "border border-border bg-background hover:bg-muted hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary-hover",
        ghost: "hover:bg-muted hover:text-foreground",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline bg-transparent",
        success: "bg-success-muted text-success hover:bg-success-muted/80",
      },
      size: {
        xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 rounded-lg px-2.5 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-9 gap-2 rounded-lg px-3 text-sm [&_svg:not([class*='size-'])]:size-4",
        lg: "h-10 gap-2 rounded-xl px-4 text-base [&_svg:not([class*='size-'])]:size-4.5",
        icon: "size-9 rounded-lg",
        "icon-sm": "size-7 rounded-md",
        "icon-lg": "size-10 rounded-xl",
      },
      loading: {
        true: "relative pointer-events-none",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
      loading: false,
    },
    compoundVariants: [
      { variant: "default", loading: true, className: "bg-primary/70" },
      { variant: "brand", loading: true, className: "bg-primary/70" },
      { variant: "outline", loading: true, className: "bg-muted/50" },
      { variant: "secondary", loading: true, className: "bg-secondary-hover" },
      { variant: "ghost", loading: true, className: "bg-muted/50" },
      { variant: "destructive", loading: true, className: "bg-destructive/20" },
      { variant: "success", loading: true, className: "bg-success-muted/80" },
    ],
  }
)

interface ButtonProps extends ButtonPrimitive.Props, VariantProps<typeof buttonVariants> {
  loading?: boolean
}

function Button({
  className,
  variant = "default",
  size = "md",
  loading = false,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, loading, className }))}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading && (
        <svg
          className="animate-spin shrink-0"
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
          <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="1" />
        </svg>
      )}
      {children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }