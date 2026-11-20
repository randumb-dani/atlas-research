/**
 * LLM provider resolution.
 *
 * Atlas can talk to two local inference backends:
 *
 *  - `lmstudio` — LM Studio. Uses its native REST API for model metadata and
 *    load/unload, and its `/api/v1/chat` endpoint for orchestrator turns.
 *  - `unsloth` — Unsloth Studio / `unsloth run`. Pure OpenAI-compatible:
 *    `GET /v1/models`, `POST /v1/chat/completions`, bearer API key
 *    (`sk-unsloth-…`), and models are loaded from the Unsloth app itself.
 *
 * Both expose `/v1/chat/completions`, so the subagent tool loop
 * (openai-compat.ts) is provider-agnostic; only the base URL + auth headers
 * differ. The orchestrator path in api.ts branches on `nativeApi`.
 */

import { useSessionStore } from "./store";

export type LlmProvider = "lmstudio" | "unsloth";

export interface LlmProviderInfo {
  id: LlmProvider;
  label: string;
  /** Default base URL when the user hasn't typed one. */
  defaultUrl: string;
  /** True when the backend requires a bearer token. */
  requiresApiKey: boolean;
  /** True for LM Studio's native REST API (rich model metadata + load/unload). */
  nativeApi: boolean;
  /** One-line description shown under the URL field. */
  hint: string;
  /** Where the user gets an API key, when applicable. */
  keyHint?: string;
}

export const LLM_PROVIDERS: Record<LlmProvider, LlmProviderInfo> = {
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    defaultUrl: "http://127.0.0.1:1234",
    requiresApiKey: false,
    nativeApi: true,
    hint: "LM Studio's local server. Models are loaded/unloaded from Atlas.",
  },
  unsloth: {
    id: "unsloth",
    label: "Unsloth Studio",
    defaultUrl: "http://127.0.0.1:8888",
    requiresApiKey: true,
    nativeApi: false,
    hint: "OpenAI-compatible endpoint from Unsloth Studio (unsloth run). Load the model inside Unsloth; Atlas only lists and uses it.",
    keyHint: "Create a key in Unsloth: avatar → Settings → API. It starts with sk-unsloth-…",
  },
};

export const LLM_PROVIDER_IDS: LlmProvider[] = ["lmstudio", "unsloth"];

export function normalizeLlmProvider(value: unknown): LlmProvider {
  return value === "unsloth" ? "unsloth" : "lmstudio";
}

export function stripTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface LlmTarget {
  provider: LlmProvider;
  info: LlmProviderInfo;
  /** Base URL without a trailing slash, e.g. `http://127.0.0.1:8888`. */
  baseUrl: string;
  /** Bearer token, or "" when the backend doesn't need one. */
  apiKey: string;
  /** Headers to merge into every request against this backend. */
  headers: Record<string, string>;
}

export function resolveLlmTarget(): LlmTarget {
  const s = useSessionStore.getState();
  const provider = normalizeLlmProvider(s.llmProvider);
  const info = LLM_PROVIDERS[provider];

  const rawUrl = provider === "unsloth" ? s.unslothUrl : s.lmStudioUrl;
  const baseUrl = stripTrailingSlashes(rawUrl || "") || info.defaultUrl;
  const apiKey = provider === "unsloth" ? (s.unslothApiKey || "").trim() : "";

  return {
    provider,
    info,
    baseUrl,
    apiKey,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  };
}
