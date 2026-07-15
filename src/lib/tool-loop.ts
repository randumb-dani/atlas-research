import { mcpListTools, mcpCallTool, mcpResultToText, type McpToolDef } from "./mcp-client";
import { streamChatCompletion, type OpenAIMessage, type OpenAIToolDef } from "./openai-compat";
import type { SSEEvent } from "./types";
import { useSessionStore } from "./store";
import { toOpenAITool, type ResolvedToolset, type ToolSource } from "./tool-types";
import { drainInbox } from "./mailbox-local";

/**
 * A tool the app itself can dispatch. `crw` tools are backed by a real MCP
 * server (any address — the app is the MCP client, so no SSRF restriction
 * applies). `mailbox` tools are backed by an in-memory registry local to
 * this module (see mailbox-local.ts) — it no longer needs to run as its own
 * MCP server/process at all, since the app is now the one calling tools
 * directly rather than handing a server_url to LM Studio.
 */

/**
 * SearXNG fans a single crw_search call out to EVERY enabled engine at once,
 * and those upstream engines (Brave, DuckDuckGo, KarmaSearch, Startpage,
 * Wikipedia, ...) CAPTCHA-wall or 429/403 under bursty concurrent load. Two
 * things stack to create that burst here: multiple subagents research in
 * parallel (Promise.all in research-chat.tsx), AND a single subagent's turn
 * can itself request several crw_search calls at once (see the
 * Promise.all(turnToolCalls.map(dispatchOne)) below, which intentionally
 * parallelizes all tool calls within one turn). So the real concurrency
 * hitting SearXNG is subagent-count × per-turn-search-count, not just
 * subagent count. SearXNG returns a throttled engine's failure as a
 * silently-empty result set rather than an error, so this doesn't look like
 * a crash — a throttled run just quietly comes back with nothing.
 *
 * This limiter caps how many crw_search calls are in flight AT ONCE across
 * every subagent, turn, and cycle, module-level (matching how the mailbox
 * registry is scoped) so it holds regardless of how much parallelism is
 * requested above it. Extra calls queue and run in submission order once a
 * slot frees up, rather than failing or being dropped. crw_scrape is NOT
 * throttled here — unlike crw_search it isn't fanning out to a shared
 * rate-limited backend, so gating it would only slow research down for no
 * protective benefit.
 */
const MAX_CONCURRENT_SEARCHES = 2;
let activeSearches = 0;
const searchQueue: (() => void)[] = [];

function acquireSearchSlot(): Promise<void> {
  if (activeSearches < MAX_CONCURRENT_SEARCHES) {
    activeSearches++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    searchQueue.push(() => {
      activeSearches++;
      resolve();
    });
  });
}

function releaseSearchSlot() {
  activeSearches--;
  const next = searchQueue.shift();
  if (next) next();
}

async function throttledSearch<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSearchSlot();
  try {
    return await fn();
  } finally {
    releaseSearchSlot();
  }
}

function mcpSource(label: string, serverUrl: string, apiKey?: string): ToolSource {
  return {
    label,
    listTools: () => mcpListTools(serverUrl, apiKey),
    callTool: async (name, args) => {
      const call = async () => mcpResultToText(await mcpCallTool(serverUrl, name, args, apiKey));
      // Only crw_search goes through the concurrency limiter -- see comment
      // above. Everything else (crw_scrape, etc.) dispatches immediately.
      if (name === "crw_search") {
        return throttledSearch(call);
      }
      return call();
    },
  };
}

export function crwToolSource(crwUrl: string, apiKey?: string): ToolSource {
  return mcpSource("crw", `${crwUrl}/mcp`, apiKey);
}

/** Fetches tool lists from every source and builds a combined dispatch table. Later sources win on name collisions. */
export async function resolveToolset(sources: ToolSource[]): Promise<ResolvedToolset> {
  const tools: OpenAIToolDef[] = [];
  const dispatch = new Map<string, ToolSource>();
  const dispatchLower = new Map<string, string>();

  for (const source of sources) {
    let defs: McpToolDef[] = [];
    try {
      defs = await source.listTools();
    } catch (err) {
      // A single unreachable tool source shouldn't take down the whole
      // research run — surface the failure via the caller's own reachability
      // check/banner instead of throwing here.
      console.warn(`Failed to list tools from "${source.label}":`, err);
      continue;
    }
    for (const def of defs) {
      tools.push(toOpenAITool(def));
      dispatch.set(def.name, source);
      const lowered = def.name.toLowerCase().trim();
      // Store the first-seen original key for each lowercased name -- later
      // sources win on exact matches above, but case-insensitive lookups are
      // best-effort so we keep whichever registered first.
      if (!dispatchLower.has(lowered)) {
        dispatchLower.set(lowered, def.name);
      }
    }
  }

  // [LOG] show what tools were resolved from each source — useful for debugging.
  const toolNames = [...dispatch.keys()].sort();
  console.log(`[startup] resolved ${toolNames.length} tool(s): ${toolNames.join(', ')}`);

  return { tools, dispatch, dispatchLower };
}

export interface ToolLoopOptions {
  model: string;
  systemPrompt: string;
  userInput: string;
  toolset: ResolvedToolset;
  temperature?: number;
  /** Hard ceiling on ReAct iterations, in case a model loops on tool calls indefinitely. */
  maxIterations?: number;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  /** Subagent key for source attribution */
  subagentKey?: string;
}

// A scraped page can easily be several thousand tokens of markdown. Keeping
// every tool result verbatim in the transcript for the rest of the run means
// a genuinely thorough research pass (5+ scrapes, as the subagent prompt now
// requires) can exhaust even a generous context window well before the
// model gets to write its report — producing a technically-successful but
// empty completion on the final turn, which looks like a mysterious silent
// failure rather than what it actually is (context exhaustion). Two
// mitigations: cap each individual tool result's stored length, and
// separately compact OLDER tool results further on each turn, since the
// model already used a result's full content in the turn right after
// receiving it — there's little value in keeping page 1's full text around
// 12 turns later when it's page 9 that's actually relevant.
const MAX_TOOL_RESULT_CHARS = 6000;
const OLD_RESULT_KEEP_RECENT = 3; // how many of the most recent tool results stay uncompacted
const OLD_RESULT_COMPACT_CHARS = 800;

function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[...truncated, ${text.length - MAX_TOOL_RESULT_CHARS} more characters omitted to stay within context budget...]`;
}

/** Mutates `messages` in place, shrinking all but the most recent N tool-role messages. */
function compactOlderToolResults(messages: OpenAIMessage[]): void {
  const toolIndices = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const toCompact = toolIndices.slice(0, Math.max(0, toolIndices.length - OLD_RESULT_KEEP_RECENT));
  for (const i of toCompact) {
    const msg = messages[i];
    if (typeof msg.content === "string" && msg.content.length > OLD_RESULT_COMPACT_CHARS) {
      messages[i] = {
        ...msg,
        content: msg.content.slice(0, OLD_RESULT_COMPACT_CHARS) + "\n\n[...older tool result compacted to save context space...]",
      };
    }
  }
}

/**
 * Runs a full ReAct-style tool-calling loop against LM Studio's OpenAI-compat
 * endpoint: stream a turn, dispatch any requested tool calls against the
 * app's own tool sources, feed results back as tool-role messages, repeat
 * until the model stops requesting tools (or maxIterations is hit).
 *
 * Emits synthetic SSEEvents matching the shape the rest of the app already
 * renders (SSETimeline etc.), even though LM Studio itself never emits
 * tool_call.* events for this endpoint — this loop is what produces them.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<string> {
  const { model, systemPrompt, userInput, toolset, temperature = 0, maxIterations = 12, onEvent, signal, subagentKey } = opts;


  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userInput },
  ];

  // Track URLs that have already failed scraping — prevents the model
  // from retrying the same captcha/timeout/empty page over and over.
  const failedUrls = new Set<string>();

  let finalContent = "";
  let hitIterationCap = false;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let turnContent = "";
    const turnToolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

    // Shrink older tool results before building this turn's request — keeps
    // the transcript's footprint roughly bounded even across many
    // iterations of a thorough, multi-scrape research run.
    compactOlderToolResults(messages);
    // On the last allowed iteration, force a synthesis turn: no tools offered,
    // and an explicit instruction to write up findings now. Without this, a
    // model that's still mid-research when the cap hits (e.g. "I'll do one
    // more search, then compile the report") gets cut off with no answer at
    // all, and the UI has no real final content to show — worse than an
    // explicit "ran out of budget" disclosure, since it looks like silence
    // rather than a known, disclosed limitation.
    const isLastIteration = iteration === maxIterations - 1;
    if (isLastIteration) {
      messages.push({
        role: "user",
        content: "You are almost out of research budget. Do not call any more tools. Write your final report now, using whatever information you've already gathered, and note explicitly if any planned research (a search or scrape you intended to do) was cut short.",
      });
    }

    // Auto-inject unread peer messages before every turn so timing races
    // don't lose mailbox deliveries. The agent still has check_inbox as a
    // tool for explicit polling, but this guarantees nothing is missed.
    if (subagentKey) {
      const unread = drainInbox(subagentKey);
      if (unread.length > 0) {
        useSessionStore.getState().addSubagentPeerMessages(subagentKey, unread);
        messages.push({
          role: "system",
          content: `[PEER MESSAGES — delivered to your inbox since your last check]\n${unread.join("\n---\n")}\n\nIncorporate any relevant findings into your report and attribute them to the originating subagent.`,
        });
      }
    }

    onEvent({ type: "message.start" });
    const result = await streamChatCompletion(
      {
        model,
        messages,
        tools: isLastIteration ? undefined : (toolset.tools.length > 0 ? toolset.tools : undefined),
        temperature,
      },
      {
        onReasoningDelta: (c) => onEvent({ type: "reasoning.delta", content: c }),
        onMessageDelta: (c) => {
          turnContent += c;
          onEvent({ type: "message.delta", content: c });
        },
        onError: (err) => onEvent({ type: "error", error: { type: "unknown", message: err.message } }),
      },
      signal,
    );
    onEvent({ type: "message.end" });
    turnToolCalls.push(...result.toolCalls);

    if (turnToolCalls.length === 0) {
      // Plain answer — this is the end of the loop.
      finalContent = turnContent || result.content;
      break;
    }

    if (isLastIteration) {
      // We explicitly asked for no tools, but the model requested some
      // anyway — it doesn't get another turn regardless. Take whatever
      // prose it did produce as the final content (may be empty), and flag
      // the cap so the caller can disclose the shortfall.
      finalContent = turnContent || result.content;
      hitIterationCap = true;
      break;
    }

    // Record the assistant's tool-call request in the transcript, then
    // dispatch every requested tool call CONCURRENTLY — a model can (and
    // often should) request several scrapes in one turn, and running them
    // sequentially means N scrapes take N times as long even though crw has
    // no rate limit and each scrape is independent. Results are pushed back
    // in call order (not completion order) so the transcript stays
    // deterministic regardless of which call finishes first; the model
    // matches tool results to calls by tool_call_id, not position, so this
    // is safe either way.
    messages.push({
      role: "assistant",
      content: turnContent || null,
      tool_calls: turnToolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    const dispatchOne = async (call: { id: string; name: string; arguments: Record<string, unknown> }): Promise<string> => {
      // LM Studio (and OpenAI-compat backends) occasionally emit tool names
      // with stray whitespace or casing differences, which would otherwise
      // miss the exact-map lookup and surface as a spurious "Unknown tool"
      // failure. Normalize before resolving the source. The secondary
      // `dispatchLower` map (populated at resolve time) gives us O(1)
      // case-insensitive lookups without falling back to a linear scan on
      // every call.
      const normalizedName = call.name.trim().toLowerCase();
      const exactMatch = toolset.dispatch.get(call.name);
      const source =
        exactMatch ??
        toolset.dispatch.get(normalizedName) ??
        toolset.dispatchLower.has(normalizedName)
          ? toolset.dispatch.get(toolset.dispatchLower.get(normalizedName)!)!
          : undefined;
      // [LOG] tool-call attempt: name, source label if found, and whether it's registered.
      console.log(`[tool-call] ${call.name}(${JSON.stringify(call.arguments)}) → ${source ? `${source.label}` : 'unregistered'}`);

      onEvent({ type: "tool_call.start", tool: call.name, provider_info: {} });
      onEvent({ type: "tool_call.arguments", tool: call.name, arguments: call.arguments });

      if (!source) {
        const errMsg = `[error] Unknown tool "${call.name}" — no registered source provides it.`;
        console.log(`[tool-call] ${call.name} → FAILED: ${errMsg}`);
        onEvent({ type: "tool_call.failure", reason: errMsg, metadata: { tool_name: call.name } });
        return errMsg;
      }

      if (call.name === "crw_scrape") {
        // Gate: prevent re-scraping URLs that already failed (captcha/timeout/empty).
        const urlArg = (call.arguments.url ?? call.arguments.Url ?? call.arguments.URL) as string | undefined;
        if (urlArg && failedUrls.has(urlArg)) {
          const errMsg = `[error] URL scrape failed previously (captcha/timeout/empty). Do not retry — move to next URL or summarize findings.`;
          console.log(`[tool-call] ${call.name}(${urlArg}) → GATED (already failed)`);
          onEvent({ type: "tool_call.failure", reason: errMsg, metadata: { tool_name: call.name, url: urlArg } });
          return errMsg;
        }
        try {
          const outputText = await source.callTool(call.name, call.arguments);
          if (subagentKey && urlArg) {
            const title = extractTitleFromMarkdown(outputText);
            const favicon = extractFaviconFromUrl(urlArg);
            useSessionStore.getState().addSource({
              url: urlArg,
              title,
              favicon,
              subagentKey,
              timestamp: Date.now(),
              status: "success",
            });
          }
          const preview = outputText.length > 200 ? `${outputText.substring(0, 200)}...` : outputText;
          console.log(`[tool-call] ${call.name} → OK (${preview})`);
          onEvent({ type: "tool_call.success", tool: call.name, arguments: call.arguments, output: outputText });
          return outputText;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (urlArg) failedUrls.add(urlArg);
          if (subagentKey && urlArg) {
            useSessionStore.getState().addSource({
              url: urlArg,
              subagentKey,
              timestamp: Date.now(),
              status: "failed",
              error: msg,
            });
          }
          console.log(`[tool-call] ${call.name} → FAILED: ${msg}`);
          onEvent({ type: "tool_call.failure", reason: msg, metadata: { tool_name: call.name, url: urlArg } });
          return `[error] ${msg}`;
        }
      }

      try {
        const outputText = await source.callTool(call.name, call.arguments);
        const preview = outputText.length > 200 ? `${outputText.substring(0, 200)}...` : outputText;
        console.log(`[tool-call] ${call.name} → OK (${preview})`);
        onEvent({ type: "tool_call.success", tool: call.name, arguments: call.arguments, output: outputText });
        return outputText;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[tool-call] ${call.name} → FAILED: ${msg}`);
        onEvent({ type: "tool_call.failure", reason: msg, metadata: { tool_name: call.name } });
        return `[error] ${msg}`;
      }
    };

    const outputs = await Promise.all(turnToolCalls.map(dispatchOne));
    turnToolCalls.forEach((call, i) => {
      messages.push({ role: "tool", tool_call_id: call.id, content: capToolResult(outputs[i]) });
    });
    // loop again with the tool results appended
  }

  // Drain any peer messages that arrived during the final LLM call (which
  // takes seconds/minutes of wall-clock time) — the auto-injection before
  // that call couldn't see them. Append to the report so the data isn't
  // lost, and persist to the store for the detail panel.
  if (subagentKey) {
    const lateMessages = drainInbox(subagentKey);
    if (lateMessages.length > 0) {
      useSessionStore.getState().addSubagentPeerMessages(subagentKey, lateMessages);
      finalContent = (finalContent || "") +
        "\n\n---\n**Late-arriving peer messages (received while final report was being written):**\n" +
        lateMessages.join("\n---\n");
    }
  }

  if (!finalContent) {
    // Even the forced no-tools synthesis turn (if we reached it) produced
    // nothing — a genuine failure, not just a budget constraint.
    onEvent({
      type: "error",
      error: { type: "unknown", message: `Tool loop hit maxIterations (${maxIterations}) without producing any final answer, even after a forced synthesis turn.` },
    });
  } else if (hitIterationCap) {
    // We got real content, but only because we cut research short and
    // forced a synthesis turn — surface this as a visible (non-fatal)
    // notice so it's clear the report may be less complete than a normal run.
    onEvent({
      type: "error",
      error: { type: "iteration_cap", message: `Research budget (${maxIterations} iterations) ran out before the model finished searching — this report was written from whatever was gathered so far.` },
    });
  }

  return finalContent;
}

// Extract title from markdown content (first # heading) or return undefined
function extractTitleFromMarkdown(md: string): string | undefined {
  const lines = md.split("\n");
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return undefined;
}

// Generate favicon URL using Google's favicon service with fallback
function extractFaviconFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return "";
  }
}