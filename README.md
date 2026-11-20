# Atlas

A deep research agent with a built-in, keyless web search engine and hardened web scraper, running local LLMs through LM Studio or Unsloth Studio.

![ad](git-header.png)

## Overview

Atlas is a desktop application built with Tauri 2, React 19, and TypeScript 6. It acts as an MCP (Model Context Protocol) client that:

- **Orchestrates research** using local LLMs via LM Studio or Unsloth Studio (OpenAI-compatible `/v1/chat/completions`)
- **Searches and scrapes the web itself** — a built-in multi-engine search pool (DuckDuckGo, Bing, Mojeek, Brave, Wikipedia) plus a polite, hardened scraper. No API keys required; crw/SearXNG/fastcrw are optional failovers only
- **Runs a ReAct tool loop** locally in the app (not in the inference backend) to avoid SSRF issues
- **Manages subagents** via in-memory mailbox for parallel research tasks

## Inference backends

Selected in Settings → LLM Engine:

| Backend | Default URL | Auth | Model management |
|---------|-------------|------|------------------|
| **LM Studio** | `http://127.0.0.1:1234` | none | Load/unload from Atlas (native REST API) |
| **Unsloth Studio** | `http://127.0.0.1:8888` | bearer key (`sk-unsloth-…`) | Load models inside Unsloth; Atlas only lists and uses them |

Both speak OpenAI-compatible `/v1/chat/completions`, so the subagent tool loop is backend-agnostic. Unsloth's orchestrator streams are adapted to the app's native SSE event contract via `streamChatAsSSE` (`openai-compat.ts`). The Unsloth key is created in Unsloth: avatar → Settings → API.

## Architecture

```
┌──────────────────┐   OpenAI-compatible     ┌──────────────────┐
│      Atlas       │───────────────────────▶│  LM Studio       │
│ (Tauri + React)  │◀───────────────────────│  or Unsloth      │
└──────┬───────────┘  tool calls (tool-role) └──────────────────┘
       │
       │ app-owned tools
       ▼
┌──────────────────────────────────────┐
│ Built-in search pool + hardened      │  primary path (keyless):
│ scraper (robots.txt, rate limits,    │  engines → per-engine limiters
│ byte caps, page cache)               │  → scraper policy → extraction
└──────┬───────────────────────────────┘
       │ failover only
       ▼
┌─────────────┐
│    crw      │  (optional MCP server; also SearXNG / fastcrw cloud)
│  (localhost)│
└─────────────┘
```

**Key architectural decisions:**
- The app is the MCP client, not the inference backend. LM Studio's `integrations`/`ephemeral_mcp` is NOT used (SSRF guard rejects loopback). Instead, `tool-loop.ts` calls `mcp-client.ts` directly, then feeds results back as tool-role messages.
- The built-in search/scraper is the primary path (`builtin-first` order). crw/fastcrw are failover only — never used to bypass a robots/policy/private-host block.

## Prerequisites

- **LM Studio** (default `http://localhost:1234`) *or* **Unsloth Studio** (default `http://127.0.0.1:8888`, with API key)
- **crw** MCP server (optional, default `http://localhost:3100`) — the app works fully without it
- **Node.js** 20+ and **Rust** 1.78+ for development
- **JDK 17+** for Android builds

## Quick Start

```bash
# Install dependencies
npm install

# Start development server (Vite + Tauri)
npm run dev          # Vite dev server only
cargo tauri dev      # Tauri dev window (native)

# Build for production
npm run build        # Vite build
cargo tauri build    # Desktop distributable
cargo tauri android build  # Android APK/AAB
```

## Configuration

Settings are persisted to `localStorage` under `deep-research-config`:

- **LLM Engine** — `lmstudio` or `unsloth`, plus the backend URL and (Unsloth only) API key
- **crw URL / API Key** — optional MCP failover; API key doubles as the fastcrw cloud key
- **SearXNG URL** — optional self-hosted search failover
- **Search provider order** — `builtin-first` (default), `ddg-first`, `searxng-first`, `crw-first`
- **Built-in engines** — per-engine toggles (DDG, Bing, Mojeek, Brave, Wikipedia)
- **Scraping policy** — respect robots.txt (default on), per-host spacing, max concurrency, max page size, LAN/private-host block (default on)
- **Orchestrator / Subagent models** — per-role model selection
- **Toolset** — resolved once from crw on connection; re-resolved when crw URL changes

History persists under `deep-research-history` (max 20 entries).

## Key Implementation Details

| File | Purpose |
|------|---------|
| `src/lib/llm-provider.ts` | Provider registry (LM Studio / Unsloth) + `resolveLlmTarget()` for base URL and bearer headers |
| `src/lib/tool-loop.ts` | ReAct loop: calls the backend, dispatches tool calls against app-owned sources, feeds results back |
| `src/lib/mcp-client.ts` | MCP-over-HTTP client talking to crw |
| `src/lib/openai-compat.ts` | OpenAI-compatible streaming client + `streamChatAsSSE` orchestrator adapter |
| `src/lib/api.ts` | Provider-aware inference client (listModels, streamChat, load/unload, connection test) |
| `src/lib/web-search-source.ts` | Unified `web_search` tool: built-in pool → SearXNG → crw → fastcrw failover chain |
| `src/lib/search-engines.ts` | Built-in engine pool with parsers, dedupe, cache, per-engine limiters, diagnostics |
| `src/lib/scraper.ts` | Hardened page fetch: URL/SSRF validation, robots check, retries, byte caps, extraction, cache |
| `src/lib/robots.ts` | robots.txt fetch/parse/evaluate (Allow/Disallow longest-match, Crawl-delay) |
| `src/lib/rate-limit.ts` | Shared keyed limiter (spacing, concurrency, sliding window, adaptive backoff) |
| `src/lib/apply-search-settings.ts` | `syncSearchRuntime()` — bridges persisted settings into runtime modules |
| `src/lib/store.ts` | Zustand store with localStorage persistence |
| `src/lib/mailbox-local.ts` | In-memory subagent messaging (no separate server) |
| `src/components/research-chat.tsx` | Main UI orchestrating research flow |

**Quirks to know:**
- Tool results are truncated (`MAX_TOOL_RESULT_CHARS=6000`) and older results compacted to 800 chars
- Tool dispatch is concurrent (`Promise.all` in `tool-loop.ts`)
- `SubagentState.report` is the source of truth for subagent conclusions (not SSE deltas)
- `store.reset()` preserves connection-level settings: models, toolset, provider, backend URLs/keys, and all search/scrape tuning
- Scrape policy failures (`robots`, `private-host`, `invalid-url`, `too-large`, `unsupported`) are final — failover never bypasses them
- New research runs reset search caches/limiters (`resetBuiltinSearch()` + `resetScrapeState()`)
- Load/unload and capability filters apply only to LM Studio; OpenAI-compatible backends own model lifetime
- CSP is `null` in Tauri config — webview allows any outbound request

## Android Build

Requires:
- JDK 17+ (not 1.8)
- Android SDK with NDK r28 at `$ANDROID_HOME/ndk/28.2.13676358`
- Rust targets: `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`

```bash
cargo tauri android build
```

## Stack

- **Frontend**: React 19, TypeScript 6.0 (erasableSyntaxOnly), Vite 8, Tailwind CSS v4
- **Desktop**: Tauri 2 (Rust, thin shell — app logic is TypeScript)
- **State**: Zustand with localStorage persistence
- **UI**: shadcn/ui (base-nova style), lucide-react, cmdk
- **Fonts**: Inter (body), Space Grotesk (headings) via @fontsource
- **Linting**: Oxlint (not ESLint) — `npm run lint`
