import type { McpToolDef } from "./mcp-client";

export interface ToolSource {
  label: string;
  listTools: () => Promise<McpToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
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