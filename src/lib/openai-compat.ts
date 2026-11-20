/**
 * Client for the OpenAI-compatible /v1/chat/completions endpoint exposed by
 * local inference backends — LM Studio, Unsloth Studio (`unsloth run`),
 * llama-server, vLLM.
 *
 * Why not LM Studio's native /api/v1/chat? That endpoint only accepts
 * `integrations` (plugins or ephemeral MCP) and enforces an SSRF guard on
 * ephemeral_mcp server URLs. /v1/chat/completions accepts a plain
 * client-supplied `tools` array, same as the OpenAI API. Since the *app*
 * dispatches tool calls itself (see tool-loop.ts), there's no address
 * restriction to work around — the backend never makes an outbound
 * connection to the tool server at all. Unsloth Studio exposes only this
 * OpenAI-compatible surface, so the same path serves both providers.
 */

import { resolveLlmTarget } from "./llm-provider";
import type { ChatRequest, ChatResponse, SSEEvent } from "./types";

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

import {
  DEFAULT_STALL_TIMEOUTS,
  fetchWithTimeout,
  StallTimeoutError,
  StallWatcher,
  TimeoutError,
  type StallTimeouts,
} from "./fetch-timeout";

/**
 * Streaming callbacks mirroring the shape of the app's existing SSEEvent
 * union, so the rest of the UI (SSETimeline etc.) barely has to change even
 * though these events are now synthesized by our own loop rather than
 * emitted natively by the backend.
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
  stall?: StallTimeouts,
): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] }> {
  const acc = new Map<number, ToolCallAccumulator>();
  let content = "";
  let finishReason: string | null = null;
  const timeouts = { ...DEFAULT_STALL_TIMEOUTS, ...stall };
  const target = resolveLlmTarget();

  // The fetch itself (headers + first byte) is covered by the TTFT budget:
  // a cold model load that never starts responding must fail loudly rather
  // than hang the research loop forever.
  let stalledKind: "time-to-first-token" | "inter-token" | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const watcher = new StallWatcher(
    (kind) => {
      stalledKind = kind;
      // Unblock a pending reader.read() so the loop below can exit and throw.
      reader?.cancel().catch(() => {});
    },
    timeouts,
  );

  try {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${target.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...target.headers },
        body: JSON.stringify({ ...req, stream: true }),
        signal,
        timeoutMs: timeouts.timeToFirstTokenMs,
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new StallTimeoutError("time-to-first-token", err.timeoutMs);
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Chat completions error ${res.status}: ${text}`);
    }

    reader = res.body?.getReader() ?? null;
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (err) {
        // A stalled stream's reader.cancel() surfaces here — convert it into
        // the stall error the caller is waiting for.
        if (stalledKind) throw new StallTimeoutError(stalledKind, timeouts.interTokenMs);
        throw err;
      }
      if (read.done) break;
      const value = read.value;

      // Any bytes at all prove the model/connection is alive.
      watcher.progress();

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
            let index: number;
            if (typeof tc.index === "number") {
              index = tc.index;
            } else {
              // Some backends omit `index` entirely and identify calls only
              // by id. Merging everything at 0 would glue N parallel tool
              // calls into one broken call. Without an index: a fragment
              // carrying a NEW id while a call is already under way starts a
              // new accumulator; anything else continues the latest one.
              const lastIdx = acc.size > 0 ? Math.max(...acc.keys()) : 0;
              const last = acc.get(lastIdx);
              index =
                tc.id && last && tc.id !== last.id && (last.name || last.arguments)
                  ? lastIdx + 1
                  : lastIdx;
            }
            let entry = acc.get(index);
            if (!entry) {
              entry = { id: tc.id ?? `call_${index}`, name: "", arguments: "" };
              acc.set(index, entry);
            }
            if (tc.id) entry.id = tc.id; // some backends send id only on the first fragment
            if (typeof tc.function?.name === "string" && tc.function.name) {
              // Two provider dialects, one rule (mirrors Unsloth's loop):
              // OpenAI streams the name in fragments ("web" then "_search",
              // append) while llama-server re-sends the growing whole name
              // ("web" then "web_search", assign). A fragment that already
              // starts with what we have is the whole name re-sent.
              const fragment: string = tc.function.name;
              entry.name = fragment.startsWith(entry.name) ? fragment : entry.name + fragment;
            }
            if (typeof tc.function?.arguments === "string") {
              entry.arguments += tc.function.arguments;
            } else if (tc.function?.arguments != null && typeof tc.function.arguments === "object") {
              // llama-server has shipped decoded objects where a string
              // fragment belongs. Assign (don't append): a repeated full
              // object is a resend, and gluing two JSON objects together
              // would only produce unparseable sludge.
              if (!entry.arguments) {
                try {
                  entry.arguments = JSON.stringify(tc.function.arguments);
                } catch {
                  // unstringifiable — leave empty, recovered below as {}
                }
              }
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }

    if (stalledKind) {
      // reader.cancel() resolved the loop instead of rejecting — still a stall.
      throw new StallTimeoutError(stalledKind, timeouts.interTokenMs);
    }
    watcher.done();

    const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
    for (const entry of acc.values()) {
      if (!entry.name) continue; // never got a name — drop rather than guess
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = entry.arguments.trim() ? JSON.parse(entry.arguments) : {};
      } catch {
        // Arguments didn't parse as JSON even after full accumulation — this
        // means either the stream was cut short or the model produced
        // malformed/non-JSON arguments (e.g. XML-style <parameter> tags).
        // Rather than DROP the call and surface a scary "tool failed" error
        // (which is exactly what makes a harmless check_inbox look like a
        // failure), recover with empty args and let the tool itself decide
        // what to do. Mailbox tools tolerate missing keys; crw tools will
        // report a real error if an argument they need is genuinely absent.
        console.warn(
          `Tool call "${entry.name}" had unparseable arguments (recovered as empty): ${entry.arguments.slice(0, 200)}`,
        );
        parsedArgs = {};
      }
      toolCalls.push({ id: entry.id, name: entry.name, arguments: parsedArgs });
      callbacks.onToolCallReady?.({ id: entry.id, name: entry.name, arguments: parsedArgs });
    }

    callbacks.onDone?.(finishReason);
    return { content, toolCalls };
  } catch (err) {
    watcher.done();
    if (err instanceof Error && err.name !== "AbortError") {
      callbacks.onError?.(err);
    }
    throw err;
  }
}

/** Flattens the app's ChatRequest input (string or content parts) to text. */
function chatInputToText(input: ChatRequest["input"]): string {
  if (typeof input === "string") return input;
  return input
    .map((part) => (part && typeof part.content === "string" ? part.content : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Orchestrator adapter for OpenAI-compatible backends.
 *
 * The research loop's orchestrator calls (`streamChat` in api.ts) were built
 * around LM Studio's native SSE events. Unsloth Studio only speaks
 * `/v1/chat/completions`, so this wraps `streamChatCompletion` and emits the
 * same `reasoning.*` / `message.*` / `chat.end` events the callers already
 * understand.
 *
 * `previous_response_id` is intentionally ignored: OpenAI's Responses API
 * history is unsupported by Unsloth, and every orchestrator prompt in this
 * app is self-contained (query + reports), so replaying history would only
 * cost context.
 */
export function streamChatAsSSE(
  req: ChatRequest,
  onEvent: (event: SSEEvent) => void,
  onError: (error: Error) => void,
  onDone: () => void,
  externalSignal?: AbortSignal,
  stall?: StallTimeouts,
): AbortController {
  const controller = new AbortController();

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
    return controller;
  }
  externalSignal?.addEventListener("abort", () => controller.abort(externalSignal.reason), {
    once: true,
  });

  (async () => {
    const messages: OpenAIMessage[] = [];
    if (req.system_prompt) {
      messages.push({ role: "system", content: req.system_prompt });
    }
    messages.push({ role: "user", content: chatInputToText(req.input) });

    let reasoningStarted = false;
    let messageStarted = false;

    try {
      const result = await streamChatCompletion(
        {
          model: req.model,
          messages,
          temperature: req.temperature,
          max_tokens: req.max_output_tokens,
        },
        {
          onReasoningDelta: (content) => {
            if (!reasoningStarted) {
              reasoningStarted = true;
              onEvent({ type: "reasoning.start" });
            }
            onEvent({ type: "reasoning.delta", content });
          },
          onMessageDelta: (content) => {
            if (!messageStarted) {
              messageStarted = true;
              onEvent({ type: "message.start" });
            }
            onEvent({ type: "message.delta", content });
          },
        },
        controller.signal,
        stall,
      );

      if (reasoningStarted) onEvent({ type: "reasoning.end" });
      if (messageStarted) onEvent({ type: "message.end" });

      // Keep the ChatResponse shape the callers expect; there is no
      // server-side response id on this path, and token stats aren't
      // reported by the OpenAI stream.
      const response: ChatResponse = {
        model_instance_id: req.model,
        output: result.content
          ? [{ type: "message", content: result.content }]
          : [],
        stats: {
          input_tokens: 0,
          total_output_tokens: 0,
          reasoning_output_tokens: 0,
          tokens_per_second: 0,
          time_to_first_token_seconds: 0,
        },
        response_id: undefined,
      };
      onEvent({ type: "chat.end", result: response });
      onDone();
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        onError(err);
      }
    }
  })();

  return controller;
}
