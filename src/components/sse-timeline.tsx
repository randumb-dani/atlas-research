import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Search, Globe, MessageSquare, Megaphone, Inbox, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SSEEvent } from "@/lib/types";

/** Map tool names to a glyph + plain-language verb so the event log reads
 * at a glance: searching vs fetching a page vs messaging a peer. Falls back
 * to the raw tool name for unknown (crw/MCP) tools. */
function toolMeta(tool: string): { Icon: LucideIcon; verb: string } {
  const t = tool.toLowerCase();
  if (t.includes("scrape") || t.includes("fetch")) return { Icon: Globe, verb: "Fetching page" };
  if (t.includes("search")) return { Icon: Search, verb: "Searching web" };
  if (t.includes("broadcast")) return { Icon: Megaphone, verb: "Broadcasting to peers" };
  if (t.includes("send_to")) return { Icon: MessageSquare, verb: "Messaging peer" };
  if (t.includes("inbox")) return { Icon: Inbox, verb: "Checking inbox" };
  return { Icon: Wrench, verb: tool };
}

const eventStyles: Record<string, { dot: string; bar: string }> = {
  model_load: { dot: "bg-event-info", bar: "border-l-event-info/40" },
  prompt_processing: { dot: "bg-event-processing", bar: "border-l-event-processing/40" },
  reasoning: { dot: "bg-primary", bar: "border-l-primary/40" },
  tool_call: { dot: "bg-event-success", bar: "border-l-event-success/40" },
  message: { dot: "bg-foreground", bar: "border-l-foreground/20" },
  error: { dot: "bg-event-error", bar: "border-l-event-error/40" },
  chat: { dot: "bg-primary", bar: "border-l-primary/40" },
};

function getEventCategory(type: string): string {
  if (type.startsWith("model_load")) return "model_load";
  if (type.startsWith("prompt_processing")) return "prompt_processing";
  if (type.startsWith("reasoning")) return "reasoning";
  if (type.startsWith("tool_call")) return "tool_call";
  if (type.startsWith("message")) return "message";
  if (type === "error") return "error";
  return "chat";
}

function shorten(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * `message.delta` and `reasoning.delta` fire once per token (sometimes even
 * per sub-word fragment) — rendering each one as its own row means every
 * word ends up on its own line. This coalesces consecutive deltas of the
 * same kind into a single accumulated block, the same way the orchestrator's
 * plan/report panels already accumulate their streamed text before handing
 * it to Streamdown. Every other event type (tool calls, model load, etc.)
 * stays exactly as its own row.
 */
type CoalescedItem =
  | { kind: "message"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "event"; event: SSEEvent };

function coalesce(events: SSEEvent[]): CoalescedItem[] {
  const out: CoalescedItem[] = [];
  for (const event of events) {
    if (event.type === "message.delta") {
      const last = out[out.length - 1];
      if (last?.kind === "message") {
        last.content += event.content;
      } else {
        out.push({ kind: "message", content: event.content });
      }
      continue;
    }
    if (event.type === "reasoning.delta") {
      const last = out[out.length - 1];
      if (last?.kind === "reasoning") {
        last.content += event.content;
      } else {
        out.push({ kind: "reasoning", content: event.content });
      }
      continue;
    }
    if (event.type === "message.start" || event.type === "message.end") continue;
    if (event.type === "reasoning.start" || event.type === "reasoning.end") continue;
    // Our tool loop never emits these LM Studio-native events, and
    // EventContent renders them as blank rows — drop rather than paint dots
    // with no text.
    if (
      event.type === "chat.start" ||
      event.type === "chat.end" ||
      event.type.startsWith("model_load") ||
      event.type.startsWith("prompt_processing")
    ) {
      continue;
    }
    out.push({ kind: "event", event });
  }
  return out;
}

function CoalescedRow({ item, color }: { item: CoalescedItem; color: string }) {
  if (item.kind === "message") {
    return (
      <div className="relative flex items-start gap-3 py-1.5 pl-6">
        <div className={`absolute left-1.5 top-2.5 size-1.5 shrink-0 rounded-full ${color || "bg-foreground"}`} />
        <div className="min-w-0 flex-1 whitespace-pre-wrap text-xs leading-relaxed">{item.content}</div>
      </div>
    );
  }
  if (item.kind === "reasoning") {
    return (
      <div className="relative flex items-start gap-3 py-1.5 pl-6">
        <div className={`absolute left-1.5 top-2.5 size-1.5 shrink-0 rounded-full ${color || "bg-primary"}`} />
        <div className="min-w-0 flex-1 whitespace-pre-wrap text-[10px] italic leading-relaxed text-primary/80">{item.content}</div>
      </div>
    );
  }
  return <EventRow event={item.event} color={color} />;
}

function EventRow({ event, color }: { event: SSEEvent; color: string }) {
  return (
    <div className="relative flex items-start gap-3 py-1.5 pl-6 transition-colors hover:bg-muted/30">
      <div className={`absolute left-1.5 top-2.5 size-1.5 shrink-0 rounded-full ${color}`} />
      <div className="min-w-0 flex-1 text-xs leading-relaxed">
        <EventContent event={event} />
      </div>
    </div>
  );
}

function EventContent({ event }: { event: SSEEvent }) {
  switch (event.type) {
    case "model_load.start":
      return <span className="text-event-info">Loading model…</span>;
    case "model_load.progress":
      return (
        <div className="flex items-center gap-2">
          <span className="text-event-info">Loading…</span>
          <Progress value={event.progress * 100} className="h-1 w-16" />
        </div>
      );
    case "model_load.end":
      return <span className="text-event-info">Loaded in {event.load_time_seconds.toFixed(1)}s</span>;
    case "prompt_processing.start":
      return <span className="text-event-processing">Processing prompt…</span>;
    case "prompt_processing.progress":
      return (
        <div className="flex items-center gap-2">
          <span className="text-event-processing">Processing…</span>
          <Progress value={event.progress * 100} className="h-1 w-16" />
        </div>
      );
    case "error":
      return <span className="text-event-error">{event.error.message}</span>;
    case "reasoning.start":
      return <span className="text-primary">Reasoning…</span>;
    case "reasoning.delta":
      return <span className="text-primary/80 text-[10px] italic">{event.content}</span>;
    case "tool_call.start": {
      const { Icon, verb } = toolMeta(event.tool);
      return (
        <div className="flex items-center gap-1.5">
          <Icon className="size-3 shrink-0 text-muted-foreground" />
          <Badge variant="secondary" className="text-[10px]">{verb}</Badge>
        </div>
      );
    }
    case "tool_call.arguments": {
      const args = event.arguments;
      const pairs = Object.entries(args).slice(0, 4);
      return (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 pt-0.5">
          {pairs.map(([k, v]) => {
            const s = String(v);
            if (k === "url" && /^https?:\/\//i.test(s)) {
              // URLs are real destinations — make them clickable and readable.
              return (
                <a
                  key={k}
                  href={s}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="max-w-[280px] truncate text-[10px] text-primary/80 transition-colors hover:text-primary hover:underline"
                >
                  {s.replace(/^https?:\/\//i, "").replace(/^www\./, "")}
                </a>
              );
            }
            if (k === "query") {
              return (
                <span key={k} className="text-[10px] text-foreground/80 italic">“{shorten(s, 60)}”</span>
              );
            }
            return (
              <span key={k} className="text-muted-foreground text-[10px]">
                <span className="text-foreground/60">{k}</span>
                <span className="mx-0.5">=</span>
                <span className="text-foreground/80">{shorten(s, 40)}</span>
              </span>
            );
          })}
          {Object.keys(args).length > 4 && (
            <span className="text-muted-foreground/50 text-[10px]">+{Object.keys(args).length - 4} more</span>
          )}
        </div>
      );
    }
    case "tool_call.success":
      return <span className="text-event-success text-[10px]">→ {shorten(event.output, 120)}</span>;
    case "tool_call.failure":
      return <span className="text-event-error text-[10px]">✕ {event.reason}</span>;
    default:
      return null;
  }
}

export function SSETimeline({ events }: { events: SSEEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">Waiting for events…</p>
      </div>
    );
  }

  const items = coalesce(events);

  return (
    <div className="relative h-full overflow-y-auto">
      {/* Single continuous vertical line — all dots sit on this */}
      <div className="absolute left-[7px] top-0 bottom-0 w-px bg-border/40" />
      <div className="py-1">
        {items.map((item, i) => {
          const dotColor =
            item.kind === "event"
              ? (eventStyles[getEventCategory(item.event.type)]?.dot ?? "bg-primary")
              : item.kind === "message"
                ? "bg-foreground"
                : "bg-primary";
          return <CoalescedRow key={i} item={item} color={dotColor} />;
        })}
      </div>
    </div>
  );
}
