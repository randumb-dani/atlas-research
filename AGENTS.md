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
- `src/lib/api.ts` — LM Studio REST client (listModels, streamChat, crwToolsList)
- `src/lib/openai-compat.ts` — OpenAI-compatible `/v1/chat/completions` streaming client
- `src/lib/tool-loop.ts` — ReAct loop: calls LM Studio, dispatches tool calls against app-owned sources
- `src/lib/mcp-client.ts` — MCP-over-HTTP client (talks to crw directly)
- `src/lib/mailbox-local.ts` — in-memory subagent messaging (no separate server)
- `src/lib/store.ts` — Zustand store with localStorage persistence for config
- `src/lib/types.ts` — LM Studio API type definitions
- `src/components/research-chat.tsx` — main UI component orchestrating the research flow

### External services
- **LM Studio** (default `http://localhost:1234`, configurable in Settings) — LLM inference via OpenAI-compatible `/v1/chat/completions`
- **crw** at `http://localhost:3100` — MCP server for web research (scrape, search)

## Critical quirks

1. **App is the MCP client, not LM Studio.** LM Studio's `integrations`/`ephemeral_mcp` is NOT used (SSRF guard rejects loopback). Instead, `tool-loop.ts` calls `mcp-client.ts` directly, then feeds results back as tool-role messages. See comments in `lib.rs:1-10`, `mcp-client.ts:1-12`, `openai-compat.ts:1-9`.

2. **`reset()` preserves `toolset`.** The zustand `reset()` in `store.ts:226` keeps `orchestratorModel`, `subagentModel`, `toolset`, and `lmStudioUrl` across resets. `toolset` is connection-level (resolved once from crw) — changing crw URL re-resolves it.

3. **No Rust MCP server.** The old Axum-based mailbox server was removed. Mailbox is now in-memory TypeScript (`mailbox-local.ts`).

4. **TypeScript 6.0 + `erasableSyntaxOnly`.** No enums, no namespaces, no decorators — only erased syntax allowed.

5. **Tailwind v4 via Vite plugin.** `@tailwindcss/vite` in `vite.config.ts` — NOT PostCSS-based. CSS imports use `@import "tailwindcss"`.

6. **`SubagentState.report` is the source of truth for subagent conclusions.** Do not reconstruct reports from SSE event deltas — `store.ts:36-40` documents this.

7. **Tool results are truncated and compacted** in `tool-loop.ts` — `MAX_TOOL_RESULT_CHARS` (6000) per result, older results shrunk to 800 chars, to prevent context window exhaustion.

8. **Tool dispatch is CONCURRENT.** `tool-loop.ts:287` uses `Promise.all` — tool calls within a single turn run in parallel.

9. **CSP is null** in `tauri.conf.json:25` — allow any outbound request from the webview.

10. **Config persisted** under `localStorage` key `deep-research-config` (crwUrl, crwApiKey, lmStudioUrl, models). History under `deep-research-history` (max 20 entries).

## Android Build Prerequisites

- **JDK 17+** (not 1.8) required for Android Gradle plugin 8.11+
- Rust Android targets pre-installed: `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`
- NDK r28 found at `$ANDROID_HOME/ndk/28.2.13676358`

## Path aliases

`@/` maps to `./src/` (vite + tsconfig). shadcn aliases: `@/components`, `@/lib`, `@/hooks`.
