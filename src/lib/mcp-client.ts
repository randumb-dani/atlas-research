/**
 * A minimal MCP client for talking to a local (or remote) MCP server directly
 * from the app, over HTTP. This is intentionally NOT routed through LM Studio —
 * LM Studio's `integrations` field enforces an SSRF guard that rejects any
 * server_url resolving to a private/loopback address, which makes it
 * unusable for a self-hosted local tool server like crw. Instead, the Tauri
 * app itself acts as the MCP client: it calls crw's `tools/list` once at
 * startup, converts the results into OpenAI-style function-tool schemas, and
 * (when the model requests a tool call) calls crw's `tools/call` directly —
 * then feeds the result back into the LM Studio chat loop as an ordinary
 * tool-role message. See tool-loop.ts for that orchestration.
 */

import { httpFetch } from "./http";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: { code: number; message: string };
}

let rpcId = 0;

/** The session ID to forward as a header on every RPC, if crw provides one. */
let sessionId: string | undefined;

async function rpcCall<T>(serverUrl: string, method: string, params?: Record<string, unknown>, apiKey?: string): Promise<T> {
  const id = ++rpcId;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Real MCP-over-HTTP servers commonly require this Accept header even
    // when they respond with a plain JSON body rather than SSE.
    "Accept": "application/json, text/event-stream",
  };

  // Forward the session ID from initialize if crw (or any MCP server) provides one.
  if (sessionId !== undefined) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  // Only set Authorization when a key is present — self-hosted instances
  // don't require auth, and sending an empty header would be noise.
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await httpFetch(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP server error ${res.status} calling ${method}: ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  let body: JsonRpcResponse<T>;
  if (contentType.includes("text/event-stream")) {
    // Some MCP servers respond to POST with an SSE stream even for a single
    // request/response pair. Read the whole body and pull out the last
    // `data:` line, which should contain the JSON-RPC envelope.
    const raw = await res.text();
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    if (dataLines.length === 0) {
      throw new Error(`MCP server returned an empty SSE stream for ${method}`);
    }
    body = JSON.parse(dataLines[dataLines.length - 1]);
  } else {
    body = await res.json();
  }

  if (body.error) {
    throw new Error(`MCP error calling ${method}: ${body.error.message} (code ${body.error.code})`);
  }
  if (body.result === undefined) {
    throw new Error(`MCP server returned no result for ${method}`);
  }
  return body.result;
}

/**
 * Fetches the tool list from an MCP server. Some servers expect an
 * `initialize` handshake before `tools/list` is valid — we attempt it but
 * don't hard-fail if the server doesn't implement it, since many minimal
 * servers (including hand-rolled ones) skip it entirely.
 */
export async function mcpListTools(serverUrl: string, apiKey?: string): Promise<McpToolDef[]> {
  // Capture the session ID from initialize so subsequent RPCs can reference this session.
  const initResult = await rpcCall<{ session?: string }>(serverUrl, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "deep-research-tauri", version: "0.1.0" },
  }, apiKey).catch((err) => {
    console.warn("[mcp] initialize failed:", err);
    return {} as { session?: string };
  });
  sessionId = initResult.session;

  try {
    const result = await rpcCall<{ tools: McpToolDef[] }>(serverUrl, "tools/list", undefined, apiKey);
    return result.tools ?? [];
  } catch (err) {
    console.warn("[mcp] tools/list failed:", err);
    throw err;
  }
}

export async function mcpCallTool(
  serverUrl: string,
  name: string,
  args: Record<string, unknown>,
  apiKey?: string,
): Promise<McpCallResult> {
  return rpcCall<McpCallResult>(serverUrl, "tools/call", { name, arguments: args }, apiKey);
}

/** Flattens an MCP tool-call result into a single string, suitable for a tool-role message. */
export function mcpResultToText(result: McpCallResult): string {
  const text = result.content
    .map((block) => {
      if (typeof block.text === "string") return block.text;
      return JSON.stringify(block);
    })
    .join("\n");
  return result.isError ? `[tool error] ${text}` : text;
}
