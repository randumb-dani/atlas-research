"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

function Sheet({ open, onOpenChange, children }: SheetProps) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => { setMounted(true) }, [])

  const trigger = React.useMemo(
    () => {
      let found: React.ReactNode = null
      React.Children.forEach(children, (child) => {
        if (React.isValidElement(child) && child.type === SheetTrigger) {
          found = child
        }
      })
      return found
    },
    [children]
  )

  const content = React.useMemo(
    () => {
      let found: React.ReactNode = null
      React.Children.forEach(children, (child) => {
        if (React.isValidElement(child) && child.type === SheetContent) {
          found = child
        }
      })
      return found
    },
    [children]
  )

  return (
    <>
      {trigger
        ? React.cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, { onClick: () => onOpenChange(true) })
        : null}
      {mounted && open && content
        ? createPortal(
            React.cloneElement(content as React.ReactElement<{ onClose?: () => void }>, { onClose: () => onOpenChange(false) }),
            document.body
          )
        : null}
    </>
  )
}

function SheetTrigger({ children, onClick }: { children: React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>; onClick?: () => void }) {
  return React.cloneElement(children, { onClick: (e: React.MouseEvent) => { children.props.onClick?.(e); onClick?.() } })
}

function SheetClose({ onClick }: { onClick?: () => void }) {
  return <button onClick={onClick}>Close</button>
}

function SheetPortal({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function SheetOverlay({ className, onClick, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "fixed inset-0 z-[var(--z-modal-backdrop)] bg-black/50 backdrop-blur-sm",
        "animate-fade-in",
        className
      )}
      onClick={onClick}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  size = "md",
  onClose,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { side?: "right" | "left" | "top" | "bottom"; size?: "sm" | "md" | "lg" | "xl" | "full"; onClose?: () => void }) {
  const sideStyles: Record<string, string> = {
    right: "right-0",
    left: "left-0",
    top: "top-0",
    bottom: "bottom-0",
  }

  const sizeClasses: Record<string, string> = {
    sm: side === "top" || side === "bottom" ? "h-[30vh]" : "w-64",
    md: side === "top" || side === "bottom" ? "h-[40vh]" : "w-80",
    lg: side === "top" || side === "bottom" ? "h-[50vh]" : "w-96",
    xl: side === "top" || side === "bottom" ? "h-[60vh]" : "w-[32rem]",
    full: side === "top" || side === "bottom" ? "h-[85vh]" : "w-[90vw]",
  }

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  return (
    <SheetPortal>
      <SheetOverlay onClick={onClose} />
      <div
        className={cn(
          "fixed z-[var(--z-modal)] bg-card shadow-elev-4 flex flex-col",
          "animate-slide-in-right",
          sideStyles[side],
          sizeClasses[size],
          {
            "rounded-t-xl border-l border-border": side === "right",
            "rounded-t-xl border-r border-border": side === "left",
            "rounded-r-xl border-b border-border": side === "top",
            "rounded-l-xl border-t border-border": side === "bottom",
            "max-h-[85vh]": side === "right" || side === "left",
            "max-w-[90vw]": side === "top" || side === "bottom",
          },
          className
        )}
        {...props}
      >
        {children}
        <button
          className="absolute right-4 top-4 size-8 flex items-center justify-center rounded-lg bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-ring"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-5 pb-3 pr-12 border-b border-border/40", className)} {...props} />
}

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 p-4 pt-0", className)} {...props} />
}

function SheetTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("font-heading text-lg font-semibold text-foreground", className)} {...props} />
}

function SheetDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}

function SheetCloseTrigger({ className, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "absolute right-4 top-4 size-8 flex items-center justify-center rounded-lg bg-muted/50 text-muted-foreground",
        "hover:bg-muted hover:text-foreground transition-colors",
        "focus-ring",
        className
      )}
      onClick={onClick}
      {...props}
    >
      <X className="size-4" aria-hidden="true" />
    </button>
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetCloseTrigger,
}
