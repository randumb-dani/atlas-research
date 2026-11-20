import type { ChatRequest, ChatResponse, LMModel, LoadRequest, LoadResponse, SSEEvent, UnloadRequest, UnloadResponse } from "./types";
import { httpFetch } from "./http";
import { DEFAULT_STALL_TIMEOUTS, StallTimeoutError, StallWatcher, type StallTimeouts } from "./fetch-timeout";
import { mcpListTools } from "./mcp-client";
import { resolveLlmTarget } from "./llm-provider";
import { streamChatAsSSE } from "./openai-compat";

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { message?: string };
    if (typeof e.message === "string") return e.message;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }
  return "Unknown error";
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let res;
  try {
    res = await httpFetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  } catch (err) {
    throw new Error(`Network request to ${url} failed: ${toErrorMessage(err)}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Maps one OpenAI-compatible `/v1/models` entry onto the app's richer
 * LMModel shape. Open servers disagree about which optional fields they
 * include (Unsloth reports `loaded`; plain llama-server omits it), so every
 * field is read defensively and unknown metadata stays null rather than
 * inventing values the UI would then present as fact.
 */
function mapOpenAIModel(raw: unknown): LMModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const key =
    typeof m.id === "string" ? m.id : typeof m.model === "string" ? m.model : "";
  if (!key) return null;

  const label =
    (typeof m.name === "string" && m.name.trim()) ||
    (typeof m.display_name === "string" && m.display_name.trim()) ||
    key;
  const rawType = typeof m.type === "string" ? m.type.toLowerCase() : "";
  const isEmbedding = rawType === "embedding" || rawType === "embeddings";
  const loaded = m.loaded === true ? true : m.loaded === false ? false : undefined;
  const contextLength =
    Number(m.max_context_length ?? m.context_length ?? 0) || 0;
  const sizeBytes = Number(m.size_bytes ?? m.size ?? 0) || 0;

  return {
    type: isEmbedding ? "embedding" : "llm",
    publisher:
      typeof m.owned_by === "string" && m.owned_by.trim()
        ? m.owned_by
        : "unsloth",
    key,
    display_name: label,
    architecture: typeof m.architecture === "string" ? m.architecture : null,
    quantization: null,
    size_bytes: sizeBytes,
    params_string:
      typeof m.params_string === "string"
        ? m.params_string
        : typeof m.parameters === "string"
          ? m.parameters
          : null,
    // Unknown load state is treated as usable; only an explicit `loaded: false`
    // marks a model as needing to be loaded inside the server's own app.
    loaded_instances:
      loaded === false
        ? []
        : [{ id: key, config: { context_length: contextLength } }],
    max_context_length: contextLength,
    format: null,
    capabilities: undefined,
    description: typeof m.description === "string" ? m.description : null,
    loaded,
  };
}

export async function listModels(): Promise<LMModel[]> {
  const target = resolveLlmTarget();

  if (target.info.nativeApi) {
    const data = await request<{ models: LMModel[] }>(
      `${target.baseUrl}/api/v1/models`,
    );
    return data.models;
  }

  // OpenAI-compatible backends (Unsloth Studio, llama-server, vLLM, …) expose
  // only the standard list endpoint; `data` is the spec shape, `models` the
  // llama.cpp variant.
  const data = await request<{ data?: unknown[]; models?: unknown[] }>(
    `${target.baseUrl}/v1/models`,
    { headers: target.headers },
  );
  const raw = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.models)
      ? data.models
      : [];
  const seen = new Set<string>();
  const models: LMModel[] = [];
  for (const item of raw) {
    const mapped = mapOpenAIModel(item);
    if (!mapped || seen.has(mapped.key)) continue;
    seen.add(mapped.key);
    models.push(mapped);
  }
  return models;
}

export async function loadModel(req: LoadRequest): Promise<LoadResponse> {
  const target = resolveLlmTarget();
  if (!target.info.nativeApi) {
    throw new Error(
      `${target.info.label} loads models inside its own app — select and load a model there, then refresh the list here.`,
    );
  }
  return request(`${target.baseUrl}/api/v1/models/load`, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function unloadModel(req: UnloadRequest): Promise<UnloadResponse> {
  const target = resolveLlmTarget();
  if (!target.info.nativeApi) {
    throw new Error(
      `${target.info.label} manages model lifetime itself — unload the model from its app.`,
    );
  }
  return request(`${target.baseUrl}/api/v1/models/unload`, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** Non-streaming single turn (native LM Studio API only; the app's research
 * flow streams through `streamChat`). */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const target = resolveLlmTarget();
  if (!target.info.nativeApi) {
    throw new Error(`${target.info.label} supports streaming via /v1/chat/completions only.`);
  }
  return request(`${target.baseUrl}/api/v1/chat`, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/**
 * Orchestrator streaming entry point.
 *
 * LM Studio keeps using its native `/api/v1/chat` endpoint (server-side
 * history via `previous_response_id`, auto model-load). OpenAI-compatible
 * backends such as Unsloth Studio get the same event contract synthesized
 * from `/v1/chat/completions` — see `streamChatAsSSE` in openai-compat.ts.
 */
export function streamChat(
  req: ChatRequest,
  onEvent: (event: SSEEvent) => void,
  onError: (error: Error) => void,
  onDone: () => void,
  externalSignal?: AbortSignal,
  stall?: StallTimeouts,
): AbortController {
  const target = resolveLlmTarget();
  if (!target.info.nativeApi) {
    return streamChatAsSSE(req, onEvent, onError, onDone, externalSignal, stall);
  }
  return streamChatLmStudio(req, onEvent, onError, onDone, externalSignal, stall);
}

function streamChatLmStudio(
  req: ChatRequest,
  onEvent: (event: SSEEvent) => void,
  onError: (error: Error) => void,
  onDone: () => void,
  externalSignal?: AbortSignal,
  stall?: StallTimeouts,
): AbortController {
  const controller = new AbortController();

  if (externalSignal?.aborted) {
    controller.abort();
    return controller;
  }
  if (externalSignal) {
    externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  (async () => {
    const timeouts = { ...DEFAULT_STALL_TIMEOUTS, ...stall };
    // A stalled orchestrator stream (planning/gap-check/compile) used to hang
    // the whole run silently. The watcher aborts the request and reports a
    // StallTimeoutError so the caller can fail loudly instead.
    let stalled: StallTimeoutError | null = null;
    const watcher = new StallWatcher((kind) => {
      stalled = new StallTimeoutError(
        kind,
        kind === "time-to-first-token" ? timeouts.timeToFirstTokenMs : timeouts.interTokenMs,
      );
      try {
        onError(stalled);
      } catch {
        // never let a watcher callback throw
      }
      controller.abort(stalled);
    }, timeouts);
    try {
      const res = await httpFetch(`${resolveLlmTarget().baseUrl}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...req, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Chat error ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        watcher.progress();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6)) as SSEEvent;
              onEvent(data);
            } catch {
              // skip unparseable
            }
          }
        }
      }

      watcher.done();
      onDone();
    } catch (err) {
      watcher.done();
      if (stalled) {
        // Already reported via onError in the stall handler; the abort we
        // triggered ourselves just unwinds the reader loop.
        return;
      }
      if (err instanceof Error && err.name !== "AbortError") {
        onError(err);
      }
    }
  })();

  return controller;
}

export async function crwToolsList(crwUrl: string, apiKey?: string): Promise<string[]> {
  const tools = await mcpListTools(`${crwUrl}/mcp`, apiKey, { timeoutMs: 15_000 });
  return tools.map((t) => t.name);
}

export interface LlmTestResult {
  success: boolean;
  provider: string;
  baseUrl: string;
  /** Model ids reported by the backend, on success. */
  models?: string[];
  error?: string;
}

/**
 * Probes the *selected* inference backend through the exact code path the
 * research run uses (`listModels`), so a green result means Settings is
 * actually usable — a keyless Unsloth endpoint answers 401 here, which is
 * the failure users hit most often.
 */
export async function testLlmConnection(): Promise<LlmTestResult> {
  const target = resolveLlmTarget();
  try {
    const models = await listModels();
    return {
      success: true,
      provider: target.info.label,
      baseUrl: target.baseUrl,
      models: models.filter((m) => m.type === "llm").map((m) => m.key),
    };
  } catch (err) {
    return {
      success: false,
      provider: target.info.label,
      baseUrl: target.baseUrl,
      error: toErrorMessage(err),
    };
  }
}

export interface CrwTestResult {
  success: boolean;
  tools?: string[];
  error?: string;
}

export async function testCrwConnection(crwUrl: string, apiKey?: string): Promise<CrwTestResult> {
  try {
    // Same path the research loop itself uses (initialize handshake +
    // tools/list via mcp-client), so "Test" passing actually means research
    // will work — previously this used a hand-rolled tools/list call that
    // could succeed where the real path failed and vice versa.
    const tools = await crwToolsList(crwUrl, apiKey);
    return { success: true, tools };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}
