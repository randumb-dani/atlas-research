"use client";

import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Globe, CheckCircle2, AlertCircle } from "lucide-react";
import { cn, formatSubagentId } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSessionStore, type SourceRef } from "@/lib/store";

export function SourcesSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const subagents = useSessionStore((s) => s.subagents);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); return () => setMounted(false); }, []);

  const onClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Collect all sources from all subagents
  const allSources: (SourceRef & { subagentId: string; cycle: number })[] = [];
  for (const agent of subagents) {
    if (agent.sources && agent.sources.length > 0) {
      for (const source of agent.sources) {
        allSources.push({ ...source, subagentId: agent.id, cycle: agent.cycle });
      }
    }
  }

  allSources.sort((a, b) => b.timestamp - a.timestamp);

  const successSources = allSources.filter((s) => s.status === "success");
  const failedSources = allSources.filter((s) => s.status === "failed");
  const totalSources = allSources.length;
  const uniqueDomains = new Set(allSources.map((s) => {
    try { return new URL(s.url).hostname; } catch { return s.url; }
  })).size;

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal-backdrop)]">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      {/* Panel */}
      <div
        className={cn(
          "absolute right-0 top-0 bottom-0 w-full max-w-[384px] bg-card shadow-elev-4 flex flex-col animate-slide-in-right",
          "rounded-t-xl border-l border-border"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
          <div>
            <h2 className="text-base font-semibold">Sources</h2>
            <p className="text-xs text-muted-foreground">
              {totalSources} source{totalSources !== 1 ? "s" : ""} from {uniqueDomains} domain{uniqueDomains !== 1 ? "s" : ""}
            </p>
          </div>
          <button
            className="size-8 flex items-center justify-center rounded-lg bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Content */}
        {totalSources === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 text-center text-muted-foreground">
            <Globe className="size-8 mb-2 opacity-50" />
            <p className="text-sm">No sources collected yet</p>
            <p className="text-xs mt-1">Sources appear here as subagents scrape pages</p>
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3 space-y-5">
              {successSources.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                    <CheckCircle2 className="size-3 text-green-500" />
                    Successful ({successSources.length})
                  </div>
                  <div className="space-y-1.5">
                    {successSources.map((source, i) => (
                      <SourceCard key={i} source={source} />
                    ))}
                  </div>
                </div>
              )}
              {failedSources.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                    <AlertCircle className="size-3 text-destructive" />
                    Failed ({failedSources.length})
                  </div>
                  <div className="space-y-1.5">
                    {failedSources.map((source, i) => (
                      <SourceCard key={i} source={source} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>,
    document.body
  );
}

function SourceCard({ source }: { source: SourceRef & { subagentId: string; cycle: number } }) {
  const isFailed = source.status === "failed";
  const hostname = (() => {
    try { return new URL(source.url).hostname.replace(/^www\./, ""); } catch { return source.url; }
  })();

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-start gap-2.5 px-2 py-1.5 rounded-lg transition-colors hover:bg-muted/40",
        isFailed && "opacity-60"
      )}
    >
      {source.favicon ? (
        <img src={source.favicon} alt="" className="size-4 rounded-sm mt-0.5 shrink-0" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      ) : (
        <Globe className="size-4 text-muted-foreground/40 mt-0.5 shrink-0" />
      )}
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-xs font-medium leading-snug line-clamp-2">{source.title || hostname}</p>
        <p className="text-[11px] text-muted-foreground/60 truncate">{hostname}</p>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
          <span className="truncate max-w-[100px]">{formatSubagentId(source.subagentId)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">cycle {source.cycle}</span>
        </div>
        {source.error && (
          <p className="text-[10px] text-destructive/70 line-clamp-1">{source.error}</p>
        )}
      </div>
    </a>
  );
}
