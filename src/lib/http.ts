import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "@tauri-apps/api/core";

/**
 * Platform-aware fetch.
 *
 * In a Tauri window (desktop OR Android) requests are routed through Rust via
 * `@tauri-apps/plugin-http`, which bypasses the webview's CORS and
 * mixed-content restrictions entirely — the request is made by the native
 * process, not the browser engine. In a plain browser we fall back to the
 * standard `fetch`, where CORS/mixed-content are inherent and depend on the
 * target server's configuration.
 *
 * `plugin-http` returns a standard `Response` whose `body` is a streamable
 * `ReadableStream`, so streaming callers (api.ts, openai-compat.ts) work
 * unchanged.
 */
export const httpFetch: typeof globalThis.fetch = isTauri()
  ? (tauriFetch as typeof globalThis.fetch)
  : globalThis.fetch.bind(globalThis);
