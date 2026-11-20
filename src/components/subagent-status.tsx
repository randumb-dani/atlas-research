"use client";

import { Badge } from "@/components/ui/badge";
import { formatSubagentId, cn } from "@/lib/utils";
import type { SubagentState } from "@/lib/store";

interface SubagentStatusProps {
  agent: SubagentState;
  className?: string;
}

const statusDotColor: Record<SubagentState["status"], string> = {
  pending: "bg-muted-foreground/40",
  planning: "bg-event-info",
  researching: "bg-primary animate-pulse-soft",
  reporting: "bg-event-processing animate-pulse-soft",
  done: "bg-success",
};

const statusLabel: Record<SubagentState["status"], string> = {
  pending: "Pending",
  planning: "Planning",
  researching: "Researching",
  reporting: "Reporting",
  done: "Complete",
};

export function SubagentStatus({ agent, className }: SubagentStatusProps) {
  return (
    <div className={cn("flex items-center gap-3 min-w-0 flex-1", className)}>
      <div
        className={cn("size-2.5 shrink-0 rounded-full", statusDotColor[agent.status])}
        aria-label={`Status: ${statusLabel[agent.status]}`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm text-foreground">{formatSubagentId(agent.id)}</p>
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
          <Badge variant="outline" className="px-1.5 py-0 h-4 text-[9px]">
            Cycle {agent.cycle}
          </Badge>
          <Badge
            variant={agent.status === "done" ? "success" : agent.status === "researching" ? "default" : "outline"}
            className="px-1.5 py-0 h-4 text-[9px]"
          >
            {statusLabel[agent.status]}
          </Badge>
          {agent.sources && agent.sources.length > 0 && (
            <Badge variant="outline" className="px-1.5 py-0 h-4 text-[9px]">
              {agent.sources.length} sources
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}
