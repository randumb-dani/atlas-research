import type { ChatRequest, ChatResponse, LMModel, LoadRequest, LoadResponse, SSEEvent, UnloadRequest, UnloadResponse } from "./types";
import { useSessionStore } from "./store";
import { httpFetch } from "./http";

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

function lmStudioBase(): string {
  return useSessionStore.getState().lmStudioUrl || "http://127.0.0.1:1234";
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

export async function listModels(): Promise<LMModel[]> {
  const data = await request<{ models: LMModel[] }>(`${lmStudioBase()}/api/v1/models`);
  return data.models;
}

export async function loadModel(req: LoadRequest): Promise<LoadResponse> {
  return request(`${lmStudioBase()}/api/v1/models/load`, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function unloadModel(req: UnloadRequest): Promise<UnloadResponse> {
  return request(`${lmStudioBase()}/api/v1/models/unload`, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  return request(`${lmStudioBase()}/api/v1/chat`, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function streamChat(
  req: ChatRequest,
  onEvent: (event: SSEEvent) => void,
  onError: (error: Error) => void,
  onDone: () => void,
  externalSignal?: AbortSignal,
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
    try {
      const res = await httpFetch(`${lmStudioBase()}/api/v1/chat`, {
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

      onDone();
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        onError(err);
      }
    }
  })();

  return controller;
}

export async function crwToolsList(crwUrl: string, apiKey?: string): Promise<string[]> {
  const headers = apiKey ? { "Authorization": `Bearer ${apiKey}` } : undefined;
  const data = await request<{ result?: { tools: { name: string }[] } }>(`${crwUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/list",
    }),
  });
  return data.result?.tools?.map((t) => t.name) ?? [];
}

export interface CrwTestResult {
  success: boolean;
  tools?: string[];
  error?: string;
}

export async function testCrwConnection(crwUrl: string, apiKey?: string): Promise<CrwTestResult> {
  try {
    const headers = apiKey ? { "Authorization": `Bearer ${apiKey}` } : undefined;
    const data = await request<{ result?: { tools: { name: string }[] } }>(`${crwUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/list",
      }),
    });
    return { success: true, tools: data.result?.tools?.map((t) => t.name) ?? [] };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}
