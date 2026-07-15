"use client";

import { useState } from "react";
import { FileText, AlertTriangle, Copy, Check } from "lucide-react";
import { Streamdown } from "streamdown";
import { filterProceed, cn } from "@/lib/utils";

interface SubagentReportProps {
  report: string;
  hitIterationCap?: boolean;
  scrollable?: boolean;
  className?: string;
}

export function SubagentReport({ report, hitIterationCap, scrollable, className }: SubagentReportProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API may be unavailable
    }
  };

  return (
    <div className={cn("border-t border-border/30 pt-3", className)}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <FileText className="size-3" />
          Final Report
        </div>
        <div className="flex items-center gap-2">
          {hitIterationCap && (
            <span className="flex items-center gap-1 text-[10px] text-warning bg-warning-muted px-1.5 py-0.5 rounded">
              <AlertTriangle className="size-3" />
              Cut short — budget ran out
            </span>
          )}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/50"
            aria-label={copied ? "Copied" : "Copy report"}
          >
            {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <div className={cn("prose prose-sm max-w-none text-sm", scrollable && "max-h-60 overflow-y-auto")}>
        <Streamdown mode="streaming">{filterProceed(report)}</Streamdown>
      </div>
    </div>
  );
}
