"use client";

import { FileText, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SourceRef } from "@/lib/store";

interface SubagentSourceListProps {
  sources: SourceRef[];
  /** Max sources to show before "+N more" truncation. 0 = no limit. */
  max?: number;
  className?: string;
}

export function SubagentSourceList({ sources, max = 0, className }: SubagentSourceListProps) {
  if (!sources.length) return null;

  const visible = max > 0 ? sources.slice(0, max) : sources;
  const overflow = max > 0 ? sources.length - max : 0;

  return (
    <div className={cn("rounded-lg border border-border/50 bg-muted/30 p-3", className)}>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
        <FileText className="size-3" />
        Sources ({sources.length})
      </div>
      <div className="space-y-1 max-h-40 overflow-y-auto">
        {visible.map((source, i) => (
          <a
            key={i}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-2 text-[11px] text-foreground/70 hover:text-primary transition-colors truncate"
          >
            {source.favicon ? (
              <img src={source.favicon} alt="" className="size-3 rounded opacity-70" onError={(e) => { e.currentTarget.style.display = "none"; }} />
            ) : (
              <Globe className="size-3 shrink-0 text-muted-foreground/50" />
            )}
            <span className="truncate">{source.title || (source.url ? new URL(source.url).hostname.replace(/^www\./, "") : "Unknown")}</span>
            <span
              className={cn(
                "px-1 py-0.5 rounded text-[9px] font-medium shrink-0",
                source.status === "success" ? "bg-success-muted text-success" : "bg-destructive/10 text-destructive",
              )}
            >
              {source.status}
            </span>
          </a>
        ))}
        {overflow > 0 && (
          <span className="text-xs text-muted-foreground/60">+{overflow} more sources</span>
        )}
      </div>
    </div>
  );
}
