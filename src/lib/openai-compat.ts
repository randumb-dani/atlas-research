/**
 * Client for LM Studio's OpenAI-compatible /v1/chat/completions endpoint.
 * Unlike /api/v1/chat (which only accepts `integrations` — plugins or
 * ephemeral MCP — and enforces an SSRF guard on ephemeral_mcp server URLs),
 * this endpoint accepts a plain client-supplied `tools` array, same as the
 * OpenAI API. Since the *app* dispatches tool calls itself (see tool-loop.ts),
 * there's no address restriction to work around — LM Studio never makes an
 * outbound connection to the tool server at all.
 */

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionsRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

import { useSessionStore } from "./store";
import { httpFetch } from "./http";

function lmStudioBase(): string {
  return useSessionStore.getState().lmStudioUrl || "http://localhost:1234";
}

/**
 * Streaming callbacks mirroring the shape of the app's existing SSEEvent
 * union, so the rest of the UI (SSETimeline etc.) barely has to change even
 * though these events are now synthesized by our own loop rather than
 * emitted natively by LM Studio.
 */
export interface StreamCallbacks {
  onReasoningDelta?: (content: string) => void;
  onMessageDelta?: (content: string) => void;
  /** Fired once a tool call's name + full (parsed) arguments are known. */
  onToolCallReady?: (call: { id: string; name: string; arguments: Record<string, unknown> }) => void;
  onError?: (error: Error) => void;
  onDone?: (finishReason: string | null) => void;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Streams one /v1/chat/completions turn. Returns the assistant message that
 * should be appended to the conversation (content + tool_calls), once the
 * stream completes — the caller is responsible for feeding that back in and
 * calling again if tool_calls is non-empty.
 *
 * Tool-call fragments are accumulated by `index`, defensively: LM Studio (and
 * OpenAI-compatible backends generally) may stream function name/arguments
 * in arbitrarily small fragments, including empty-string fragments, and by
 * index rather than guaranteed order — see
 * https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/649. We never
 * assume a tool call is "done" until finish_reason confirms it or the stream
 * ends.
 */
export async function streamChatCompletion(
  req: ChatCompletionsRequest,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] }> {
  const acc = new Map<number, ToolCallAccumulator>();
  let content = "";
  let finishReason: string | null = null;

  try {
    const res = await httpFetch(`${lmStudioBase()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req, stream: true }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Chat completions error ${res.status}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // skip unparseable fragments
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          callbacks.onReasoningDelta?.(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          callbacks.onMessageDelta?.(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index: number = typeof tc.index === "number" ? tc.index : 0;
            let entry = acc.get(index);
            if (!entry) {
              entry = { id: tc.id ?? `call_${index}`, name: "", arguments: "" };
              acc.set(index, entry);
            }
            if (tc.id) entry.id = tc.id; // some backends send id only on the first fragment
            if (typeof tc.function?.name === "string" && tc.function.name) {
              entry.name += tc.function.name;
            }
            if (typeof tc.function?.arguments === "string") {
              entry.arguments += tc.function.arguments;
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }

    const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
    for (const entry of acc.values()) {
      if (!entry.name) continue; // never got a name — drop rather than guess
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = entry.arguments.trim() ? JSON.parse(entry.arguments) : {};
      } catch {
        // Arguments didn't parse as JSON even after full accumulation — this
        // means either the stream was cut short or the model produced
        // malformed JSON. Surface it as an error rather than silently
        // guessing at partial arguments.
        callbacks.onError?.(
          new Error(`Tool call "${entry.name}" returned unparseable arguments: ${entry.arguments.slice(0, 200)}`)
        );
        continue;
      }
      toolCalls.push({ id: entry.id, name: entry.name, arguments: parsedArgs });
      callbacks.onToolCallReady?.({ id: entry.id, name: entry.name, arguments: parsedArgs });
    }

    callbacks.onDone?.(finishReason);
    return { content, toolCalls };
  } catch (err) {
    if (err instanceof Error && err.name !== "AbortError") {
      callbacks.onError?.(err);
    }
    throw err;
  }
}
