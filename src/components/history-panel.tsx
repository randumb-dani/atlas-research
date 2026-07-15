"use client"

import type { HistoryEntry } from "@/lib/history";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme-provider";
import { Clock, Trash2, FileText, Search } from "lucide-react";

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function queryPreview(q: string, max = 80): string {
  return q.length > max ? q.slice(0, max) + "..." : q;
}

interface HistoryPanelProps {
  entries: HistoryEntry[];
  onRestore: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
}

export function HistoryPanel({ entries, onRestore, onDelete, onClearAll }: HistoryPanelProps) {
  const { resolvedTheme } = useTheme();
  return (
    <Card variant="default" className="h-full flex flex-col overflow-hidden animate-scale-in">
      <CardHeader className="px-3 pb-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Clock className="size-4 text-primary shrink-0" />
            <CardTitle className="text-sm font-medium truncate">History</CardTitle>
            {entries.length > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0 animate-scale-in">
                {entries.length}
              </Badge>
            )}
          </div>
          {entries.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-[10px] h-6 px-2 text-muted-foreground hover:text-destructive shrink-0 transition-all duration-200"
              onClick={onClearAll}
            >
              Clear all
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 animate-fade-in">
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              No saved sessions yet.<br />Complete a research to see it here.
            </p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="space-y-1.5 p-3">
              {entries.map((entry, i) => (
                <div
                  key={entry.id}
                  className="group rounded-lg border border-border/60 bg-muted/30 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-muted/60 hover:shadow-elev-1 hover:-translate-y-0.5 cursor-pointer animate-slide-up"
                  style={{ animationDelay: `${i * 40}ms` }}
                  onClick={() => onRestore(entry)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">
                        {queryPreview(entry.query)}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {formatDate(entry.timestamp)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-5 shrink-0 opacity-0 group-hover:opacity-100 transition-all duration-200 text-muted-foreground hover:text-destructive hover:scale-110 active:scale-90"
                      onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }}
                      aria-label="Delete session"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 flex items-center gap-0.5">
                      <img
                        src={resolvedTheme === "dark" ? "/logos/atlas-logo-blue.png" : "/logos/atlas-logo-orange.png"}
                        alt="Orchestrator"
                        className="size-2.5"
                      />
                      {entry.orchModel.split("/").pop()?.slice(0, 12) ?? "?"}
                    </Badge>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 flex items-center gap-0.5">
                      <Search className="size-2.5" />
                      {entry.subModel.split("/").pop()?.slice(0, 12) ?? "?"}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[9px] px-1 py-0 h-3.5",
                        entry.depth === "shallow" && "text-depth-shallow border-depth-shallow/30",
                        entry.depth === "standard" && "text-depth-standard border-depth-standard/30",
                        entry.depth === "deep" && "text-depth-deep border-depth-deep/30",
                      )}
                    >
                      {entry.cycle}/{entry.maxCycles}
                    </Badge>
                    {entry.compiledReport && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 flex items-center gap-0.5">
                        <FileText className="size-2.5" />
                        {entry.subagents.length}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
