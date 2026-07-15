"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

function Dialog({ open, onOpenChange, children }: DialogProps) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => { setMounted(true) }, [])

  const trigger = React.useMemo(
    () => {
      let found: React.ReactNode = null
      React.Children.forEach(children, (child) => {
        if (React.isValidElement(child) && child.type === DialogTrigger) {
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
        if (React.isValidElement(child) && child.type === DialogContent) {
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
        : React.Children.map(children, (child) =>
            React.isValidElement(child) && child.type !== DialogContent ? child : null
          )}
      {mounted && open && content
        ? createPortal(
            React.cloneElement(content as React.ReactElement<{ onClose?: () => void }>, { onClose: () => onOpenChange(false) }),
            document.body
          )
        : null}
    </>
  )
}

function DialogTrigger({ children, onClick }: { children: React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>; onClick?: () => void }) {
  return React.cloneElement(children, { onClick: (e: React.MouseEvent) => { children.props.onClick?.(e); onClick?.() } })
}

function DialogPortal({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function DialogClose({ onClick }: { onClick?: () => void }) {
  return <button onClick={onClick}>Close</button>
}

function DialogOverlay({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "fixed inset-0 z-[var(--z-modal-backdrop)] bg-black/60 backdrop-blur-sm",
        "animate-fade-in",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  size = "md",
  onClose,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { size?: "sm" | "md" | "lg" | "xl" | "full"; onClose?: () => void }) {
  const sizeClasses = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    full: "max-w-[90vw]",
  }

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  return (
    <DialogPortal>
      <DialogOverlay onClick={onClose} />
      <div
        className={cn(
          "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[var(--z-modal)] bg-card rounded-xl shadow-elev-4",
          "animate-slide-up",
          "max-h-[85vh] flex flex-col w-full mx-4",
          sizeClasses[size],
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
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-5 pb-3 pr-12 border-b border-border/40", className)} {...props} />
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 p-4 pt-0", className)} {...props} />
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("font-heading text-lg font-semibold text-foreground", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}

function DialogCloseTrigger({ className, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
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
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogCloseTrigger,
}
