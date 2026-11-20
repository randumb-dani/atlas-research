# Deep Research — AGENTS.md

## Stack

- **Frontend:** React 19 + TypeScript 6.0 + Vite 8 + Tailwind CSS v4
- **Desktop shell:** Tauri v2 (Rust, thin — app logic is all TS)
- **State:** Zustand store (`src/lib/store.ts`)
- **UI base:** shadcn/ui base-nova style, lucide-react icons, cmdk
- **Fonts:** Inter (body), Space Grotesk (headings) — via `@fontsource`
- **Linter:** Oxlint (not ESLint) — `npm run lint`

## Commands

| Command | Action |
|---------|--------|
| `npm run dev` | Start Vite dev server (port 5173) |
| `npm run build` | `tsc -b` then `vite build` |
| `npm run lint` | `oxlint` |
| `npm run preview` | `vite preview` |
| `cargo tauri dev` | Run Tauri app (desktop native window) |
| `cargo tauri build` | Build desktop distributable |
| `cargo tauri android dev` | Run on connected Android device/emulator |
| `cargo tauri android build` | Build Android APK/AAB |

## Architecture

### Entrypoints
- `src/main.tsx` — React mount
- `src-tauri/src/main.rs` -> `lib.rs` — Rust entry (plugins: http, log)

### Key files
- `src/lib/api.ts` — inference client, provider-aware (listModels, streamChat, crwToolsList)
- `src/lib/llm-provider.ts` — provider registry (`lmstudio` native REST + `unsloth` OpenAI-compatible) + `resolveLlmTarget()` (base URL, bearer headers)
- `src/lib/openai-compat.ts` — OpenAI-compatible `/v1/chat/completions` streaming client
- `src/lib/tool-loop.ts` — ReAct loop: calls LM Studio, dispatches tool calls against app-owned sources
- `src/lib/web-search-source.ts` — Unified `web_search` tool (built-in engine pool → SearXNG → local crw → fastcrw cloud failover chain)
- `src/lib/search-engines.ts` — Built-in multi-engine search pool (DDG, Bing, Mojeek, Brave, Wikipedia) with parsers, dedupe, cache, diagnostics
- `src/lib/scraper.ts` — Built-in page scraper: robots.txt, per-host limits, retries, byte caps, content-type policy, extraction, page cache
- `src/lib/rate-limit.ts` — Shared keyed rate limiter (spacing, concurrency, sliding window, adaptive backoff/cooldown)
- `src/lib/robots.ts` — robots.txt fetch/parse/evaluate (Allow/Disallow longest-match, Crawl-delay)
- `src/lib/searxng.ts` — Self-hosted SearXNG search (JSON API + HTML fallback) + static page scrape; pacing, cache/dedup, connection test
- `src/lib/ddg-search.ts` — DuckDuckGo search+fetch: pacing, throttle cooldown, cache/dedup, HTML→text extraction
- `src/lib/mcp-client.ts` — MCP-over-HTTP client (talks to crw directly)
- `src/lib/mailbox-local.ts` — in-memory subagent messaging (no separate server)
- `src/lib/store.ts` — Zustand store with localStorage persistence for config
- `src/lib/types.ts` — LM Studio API type definitions
- `src/components/research-chat.tsx` — main UI component orchestrating the research flow

### External services
- **LM Studio** (default `http://localhost:1234`, configurable in Settings) — LLM inference via native `/api/v1/chat` (orchestrator) + OpenAI-compatible `/v1/chat/completions` (tool loop)
- **Unsloth Studio** (optional, default `http://127.0.0.1:8888`) — pure OpenAI-compatible backend (`/v1/models`, `/v1/chat/completions`) with bearer key `sk-unsloth-…`. Selected via Settings → LLM Engine; models load inside Unsloth (no load/unload from Atlas); orchestrator streams are adapted via `streamChatAsSSE` in `openai-compat.ts`
- **crw** (optional, default `http://localhost:3100`) — local MCP server used as search/scrape failover when reachable; the app works fully without it (built-in engine pool + scraper primary, fastcrw cloud when a key is set)

## Critical quirks

1. **App is the MCP client, not LM Studio.** LM Studio's `integrations`/`ephemeral_mcp` is NOT used (SSRF guard rejects loopback). Instead, `tool-loop.ts` calls `mcp-client.ts` directly, then feeds results back as tool-role messages. See comments in `lib.rs:1-10`, `mcp-client.ts:1-12`, `openai-compat.ts:1-9`.

2. **`reset()` preserves `toolset` + search tuning.** The zustand `reset()` in `store.ts` keeps `orchestratorModel`, `subagentModel`, `toolset`, `lmStudioUrl`, `searxngUrl`, and the search settings (`searchProviderOrder`, `ddgMinIntervalMs`, `searchTimeoutMs`, `scrapeTimeoutMs`, `builtinSearchEngines`, `robotsRespect`, `scrapeMinIntervalMs`, `scrapeMaxConcurrent`, `maxPageBytes`, `allowPrivateHosts`) across resets. `toolset` is connection-level (resolved once from crw) — changing crw URL re-resolves it. Runtime modules (ddg-search, search-engines, scraper, web-search-source, tool-types timeouts) don't read the store directly — call `syncSearchRuntime()` (`apply-search-settings.ts`) after setting changes and at session start.

3. **The built-in search/scraper is the primary path.** `builtin-first` (default) runs the engine pool (DDG → Bing → Mojeek → Brave → Wikipedia, configurable) through per-engine limiters. Page fetches go through `scraper.ts`: robots.txt is honoured by default (Disallow + Crawl-delay), private/loopback hosts are blocked unless `allowPrivateHosts` is on, per-host spacing/concurrency is shared across subagents, responses are byte-capped, and successes are cached 10 minutes. crw/fastcrw are failover only — never used to bypass a robots/policy block. New research runs reset search caches/limiters via `resetBuiltinSearch()` + `resetScrapeState()`.

4. **No Rust MCP server.** The old Axum-based mailbox server was removed. Mailbox is now in-memory TypeScript (`mailbox-local.ts`).

5. **TypeScript 6.0 + `erasableSyntaxOnly`.** No enums, no namespaces, no decorators — only erased syntax allowed.

6. **Tailwind v4 via Vite plugin.** `@tailwindcss/vite` in `vite.config.ts` — NOT PostCSS-based. CSS imports use `@import "tailwindcss"`.

7. **`SubagentState.report` is the source of truth for subagent conclusions.** Do not reconstruct reports from SSE event deltas — `store.ts:36-40` documents this.

8. **Tool results are truncated and compacted** in `tool-loop.ts` — `MAX_TOOL_RESULT_CHARS` (6000) per result, older results shrunk to 800 chars, to prevent context window exhaustion.

9. **Tool dispatch is CONCURRENT.** `tool-loop.ts:287` uses `Promise.all` — tool calls within a single turn run in parallel.

10. **CSP is null** in `tauri.conf.json:25` — allow any outbound request from the webview.

11. **Config persisted** under `localStorage` key `deep-research-config` (crwUrl, crwApiKey, lmStudioUrl, models). History under `deep-research-history` (max 20 entries).

## Android Build Prerequisites

- **JDK 17+** (not 1.8) required for Android Gradle plugin 8.11+
- Rust Android targets pre-installed: `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`
- NDK r28 found at `$ANDROID_HOME/ndk/28.2.13676358`

## Path aliases

`@/` maps to `./src/` (vite + tsconfig). shadcn aliases: `@/components`, `@/lib`, `@/hooks`.
