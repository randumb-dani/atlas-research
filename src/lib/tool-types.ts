import type { McpToolDef } from "./mcp-client";

export interface ToolCallOptions {
  /** Cancel signal for the calling research loop (user Cancel). */
  signal?: AbortSignal;
}

export interface ToolSource {
  label: string;
  listTools: () => Promise<McpToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>, opts?: ToolCallOptions) => Promise<string>;
}

export function toOpenAITool(def: McpToolDef): {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
} {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

export interface ResolvedToolset {
  tools: ReturnType<typeof toOpenAITool>[];
  dispatch: Map<string, ToolSource>;
  /** Lowercased tool names mapped to their original-case keys in `dispatch`.
   * Allows O(1) case-insensitive lookups for tool calls that come in with
   * stray whitespace or casing differences (a known quirk of some LM backends). */
  dispatchLower: Map<string, string>;
}

/** Per-tool network timeouts (ms). Tunable at runtime via setToolTimeouts. */
export interface ToolTimeoutConfig {
  searchMs: number;
  scrapeMs: number;
  otherMs: number;
}

const DEFAULT_TOOL_TIMEOUTS: ToolTimeoutConfig = {
  searchMs: 30_000,
  scrapeMs: 60_000,
  otherMs: 30_000,
};

let toolTimeouts: ToolTimeoutConfig = { ...DEFAULT_TOOL_TIMEOUTS };

/** Runtime override for per-tool timeouts (wired to Settings). */
export function setToolTimeouts(patch: Partial<ToolTimeoutConfig>): void {
  toolTimeouts = { ...toolTimeouts, ...patch };
}

export function getToolTimeouts(): ToolTimeoutConfig {
  return { ...toolTimeouts };
}

/** Timeout budget for a named tool. */
export function timeoutForTool(name: string): number {
  const n = name.trim().toLowerCase();
  if (n === "crw_search" || n === "web_search") return toolTimeouts.searchMs;
  if (n === "crw_scrape") return toolTimeouts.scrapeMs;
  return toolTimeouts.otherMs;
}

/**
 * Argument readers for the unified web tool (single `web_search` tool with
 * query/url modes). Shared here so tool-loop routing and the web source
 * agree byte-for-byte on what counts as a search vs a fetch — kept in
 * tool-types (dependency-free) to avoid import cycles.
 */
export function toolArgQuery(args: Record<string, unknown>): string {
  const q = args.query ?? args.q ?? args.topic ?? "";
  return String(q).trim();
}

export function toolArgUrl(args: Record<string, unknown>): string {
  const u = args.url ?? args.Url ?? args.URL;
  return typeof u === "string" ? u.trim() : "";
}