import { type McpToolDef } from "./mcp-client";
import { streamChatCompletion, type OpenAIMessage, type OpenAIToolDef } from "./openai-compat";
import type { SSEEvent } from "./types";
import { useSessionStore } from "./store";
import { toOpenAITool, toolArgQuery, toolArgUrl, type ResolvedToolset, type ToolSource } from "./tool-types";
export { setToolTimeouts, getToolTimeouts, timeoutForTool } from "./tool-types";
import { drainInbox } from "./mailbox-local";
import { isAbortError, sleepJittered, StallTimeoutError } from "./fetch-timeout";

/**
 * A tool the app itself can dispatch. `crw` tools are backed by a real MCP
 * server (any address — the app is the MCP client, so no SSRF restriction
 * applies). `mailbox` tools are backed by an in-memory registry local to
 * this module (see mailbox-local.ts) — it no longer needs to run as its own
 * MCP server/process at all, since the app is now the one calling tools
 * directly rather than handing a server_url to LM Studio.
 */

/**
 * Concurrency + rate gate for searches that reach crw/SearXNG.
 *
 * SearXNG fans a single search call out to EVERY enabled engine at once,
 * and those upstream engines (Brave, DuckDuckGo, KarmaSearch, Startpage,
 * Wikipedia, ...) CAPTCHA-wall or 429/403 under bursty concurrent load.
 * Primary search traffic now goes to DuckDuckGo direct (paced inside
 * ddg-search.ts), so this limiter only guards the crw-fallback path — but
 * failovers correlate (when DDG throttles, every subagent fails over at
 * once), which is exactly the burst shape SearXNG punishes. Kept tight.
 */
const MAX_CONCURRENT_SEARCHES = 2;
/** Minimum spacing, in ms, between the START of one crw-bound search call
 * and the next -- independent of the concurrency cap above. 1500ms was
 * chosen empirically as a starting point that keeps most SearXNG default
 * engine sets under their burst thresholds; tune down if your instance can
 * take it, up if you're still seeing 429s/CAPTCHAs.
 */
const MIN_SEARCH_INTERVAL_MS = 1500;
let activeSearches = 0;
let lastSearchStart = 0;
const searchQueue: (() => void)[] = [];

function acquireSearchSlot(): Promise<void> {
  return new Promise((resolve) => {
    const tryStart = () => {
      if (activeSearches >= MAX_CONCURRENT_SEARCHES) {
        // No free concurrency slot -- queue and let releaseSearchSlot() retry.
        searchQueue.push(tryStart);
        return;
      }
      const now = Date.now();
      const earliestStart = lastSearchStart + MIN_SEARCH_INTERVAL_MS;
      if (now >= earliestStart) {
        activeSearches++;
        lastSearchStart = now;
        resolve();
      } else {
        // A concurrency slot is free, but we're within the rate-limit
        // window -- wait out the remainder, then attempt again. Another
        // caller could grab the slot or advance lastSearchStart in the
        // meantime, so we re-check from the top rather than assuming this
        // wait was sufficient.
        setTimeout(tryStart, earliestStart - now);
      }
    };
    tryStart();
  });
}

function releaseSearchSlot() {
  activeSearches--;
  const next = searchQueue.shift();
  if (next) next();
}

/**
 * Runs `fn` through the shared crw/SearXNG pace gate. Used by the unified
 * web_search source for its crw-fallback path — DDG-direct traffic paces
 * itself inside ddg-search.ts instead.
 */
export async function throttledSearch<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSearchSlot();
  try {
    return await fn();
  } finally {
    releaseSearchSlot();
  }
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

/**
 * A turn with no tool calls normally ends the loop — but weak tool-callers
 * often open with preamble text ("Let me research…", "I'll start by…")
 * instead of a call, which would end the run with zero evidence gathered.
 * Nudge up to this many times before accepting a tool-less answer. Only
 * applies while the agent has never called any tool; once it has, a
 * tool-less turn is a legitimate finish.
 */
const MAX_NO_TOOL_NUDGES = 2;
const NO_TOOL_NUDGE =
  "[SYSTEM: You have not used any research tool yet. Do NOT write introductions, preambles, or statements of intent — your FIRST action must be a tool call (web_search with a query). Call it now.]";

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
 * Self-hosted models frequently write tool calls as TEXT (a JSON block in
 * the content stream) rather than emitting structured delta.tool_calls —
 * LM Studio then returns them as plain content and a naive loop ends with
 * zero evidence. These are the tools (and their required string args) the
 * healer below recognizes. Strict on purpose: unknown names or missing args
 * stay prose.
 */
const HEALABLE_TOOL_ARGS: Record<string, string[]> = {
  web_search: ["query"],
  crw_search: ["query"],
  crw_scrape: ["url"],
  send_to_subagent: ["to_subagent_key", "message"],
  broadcast_to_peers: ["my_subagent_key", "message"],
  check_inbox: ["my_subagent_key"],
};

/** Split top-level {...} objects out of text (strings-aware forward scan). */
function splitJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/**
 * Recovers one tool call a template-based caller wrote as text — e.g.
 * {"name": "web_search", "arguments": {"query": "..."}} — instead of
 * emitting structured delta.tool_calls. Accepted shapes:
 * {name, arguments}, {function: {name, arguments}}, and {name, ...args
 * inline}. The arguments object must carry every required key as a
 * non-empty string; anything else returns null and the prose stands.
 */
function healTextToolCall(
  content: string,
  iteration: number,
): { id: string; name: string; arguments: Record<string, unknown> } | null {
  if (!content || content.length > 8000) return null;
  for (const candidate of splitJsonObjects(content)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;
    const fn = asRecord(rec.function) ?? rec;
    if (typeof fn.name !== "string") continue;
    const normalized = fn.name.trim().toLowerCase();
    const required = HEALABLE_TOOL_ARGS[normalized];
    if (!required) continue;
    let args: Record<string, unknown> | null;
    if (typeof fn.arguments === "string") {
      // Double-encoded arguments string — decode once.
      try {
        args = asRecord(JSON.parse(fn.arguments));
      } catch {
        continue;
      }
    } else {
      args = asRecord(fn.arguments);
    }
    if (!args) {
      // Inline-args shape: everything except the name/function keys.
      args = {};
      for (const [k, v] of Object.entries(rec)) {
        if (k !== "name" && k !== "function" && k !== "arguments") args[k] = v;
      }
      const fnRec = asRecord(rec.function);
      if (fnRec) {
        for (const [k, v] of Object.entries(fnRec)) {
          if (k !== "name" && k !== "arguments") args[k] = v;
        }
      }
    }
    const valid = required.every((k) => typeof args[k] === "string" && (args[k] as string).trim() !== "");
    if (!valid) continue;
    return { id: `call_healed_${iteration}`, name: normalized, arguments: args };
  }
  return null;
}

/**
 * Runs a full ReAct-style tool-calling loop against an OpenAI-compatible
 * backend (LM Studio, Unsloth Studio, llama-server…)
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
  // Consecutive failures per normalized search query — after two strikes the
  // model is told to reformulate instead of hammering a throttled provider.
  const failedSearches = new Map<string, number>();
  const MAX_SEARCH_FAILURES = 2;

  let finalContent = "";
  let hitIterationCap = false;
  let sawToolCall = false;
  let nudgeCount = 0;

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
    let result: Awaited<ReturnType<typeof streamChatCompletion>>;
    try {
      result = await streamChatCompletion(
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
    } catch (err) {
      // A failed turn (network blip, LM stall, timeout) used to kill the
      // whole subagent with an empty report. Instead: close the open message
      // block, log the failure visibly, tell the model what happened, and try
      // the turn again — the loop budget still bounds total work. User Cancel
      // (AbortError) is the only thing that propagates.
      onEvent({ type: "message.end" });
      if (signal?.aborted || isAbortError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const type = err instanceof StallTimeoutError ? "stall" : "unknown";
      console.warn(`[tool-loop] turn ${iteration} failed (${type}), retrying next iteration: ${msg}`);
      onEvent({ type: "error", error: { type, message: `Turn failed (${msg}) — continuing with the next turn.` } });
      messages.push({
        role: "system",
        content: `[SYSTEM: your last turn failed to generate (${msg}). Continue your research from where you left off — do not restart, do not apologize, just proceed with your next search, scrape, or report step.]`,
      });
      try {
        await sleepJittered(2000, signal);
      } catch {
        throw signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
      }
      continue;
    }
    onEvent({ type: "message.end" });
    turnToolCalls.push(...result.toolCalls);

    // Text-form recovery: template-based callers often write the call as a
    // JSON block in the content stream instead of structured tool_calls
    // (LM Studio then returns it as plain text). Heal it into a real call —
    // but ONLY while the run has never made a structured call, so example
    // JSON inside a later final report can never be mistaken for intent.
    if (turnToolCalls.length === 0 && !sawToolCall) {
      const healed = healTextToolCall(turnContent || result.content, iteration);
      if (healed) {
        console.log(`[tool-loop] healed text-form tool call: ${healed.name}(${JSON.stringify(healed.arguments).slice(0, 120)})`);
        onEvent({ type: "tool_call.start", tool: healed.name, provider_info: { healed_from_text: true } });
        onEvent({ type: "tool_call.arguments", tool: healed.name, arguments: healed.arguments });
        turnToolCalls.push(healed);
      }
    }

    if (turnToolCalls.length > 0) sawToolCall = true;

    if (turnToolCalls.length === 0) {
      // No tool calls this turn. Normally a plain answer ends the loop —
      // UNLESS the agent hasn't used any tool yet: that's the "Let me
      // research…" preamble trap, which would end the run with zero
      // evidence. Keep the preamble in the transcript (so the model doesn't
      // repeat it), nudge once, and continue. Bounded so a genuinely
      // tool-averse model still terminates.
      if (!sawToolCall && nudgeCount < MAX_NO_TOOL_NUDGES && !isLastIteration) {
        nudgeCount++;
        messages.push({ role: "assistant", content: turnContent || result.content || null });
        messages.push({ role: "system", content: NO_TOOL_NUDGE });
        console.log(`[tool-loop] turn ${iteration} had no tool calls — nudge ${nudgeCount}/${MAX_NO_TOOL_NUDGES}`);
        onEvent({
          type: "error",
          error: {
            type: "no_tool_call",
            message: `Turn produced no tool call (nudge ${nudgeCount}/${MAX_NO_TOOL_NUDGES}) — asking the model to search first instead of ending the run.`,
          },
        });
        continue;
      }
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

    const isSearchTool = (name: string) => {
      const n = name.trim().toLowerCase();
      return n === "crw_search" || n === "web_search" || n === "web_fetch";
    };

    const isFetchTool = (name: string) => {
      const n = name.trim().toLowerCase();
      return n === "crw_scrape" || n === "web_fetch" || n === "web_search";
    };

    /** SearXNG-style throttling surfaces as silently-empty (or "no results")
     * output rather than an error — detect it so we can back off + retry
     * instead of letting the model build on nothing. */
    const isEmptySearchResult = (text: string): boolean => {
      const t = text.trim();
      if (!t) return true;
      return /no\s+results?\s+found/i.test(t.slice(0, 300));
    };

    const searchQueryOf = (call: { arguments: Record<string, unknown> }): string => {
      return toolArgQuery(call.arguments).toLowerCase();
    };

    const dispatchOne = async (call: { id: string; name: string; arguments: Record<string, unknown> }): Promise<string> => {
      try {
        return await dispatchInner(call);
      } catch (err) {
        // Absolute containment: no single tool call may ever reject the
        // turn. Aborts propagate (user Cancel); everything else becomes a
        // tool-role error message the model can react to.
        if (signal?.aborted || isAbortError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[tool-call] ${call.name} → UNCAUGHT: ${msg}`);
        onEvent({ type: "tool_call.failure", reason: msg, metadata: { tool_name: call.name } });
        return `[error] ${msg}`;
      }
    };

    const dispatchInner = async (call: { id: string; name: string; arguments: Record<string, unknown> }): Promise<string> => {
      // LM Studio (and OpenAI-compat backends) occasionally emit tool names
      // with stray whitespace or casing differences, which would otherwise
      // miss the exact-map lookup and surface as a spurious "Unknown tool"
      // failure. Normalize before resolving the source. The secondary
      // `dispatchLower` map (populated at resolve time) gives us O(1)
      // case-insensitive lookups without falling back to a linear scan on
      // every call.
      const normalizedName = call.name.trim().toLowerCase();
      const exactMatch = toolset.dispatch.get(call.name);
      const viaLower = toolset.dispatchLower.has(normalizedName)
        ? toolset.dispatch.get(toolset.dispatchLower.get(normalizedName)!)
        : undefined;
      const source = exactMatch ?? toolset.dispatch.get(normalizedName) ?? viaLower;
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

      // Route by ARGUMENTS, not just name: the unified web_search tool does
      // both jobs ({query} searches, {url} fetches). A URL wins when both
      // are present — fetching is the concrete action.
      const query = toolArgQuery(call.arguments);
      const url = toolArgUrl(call.arguments);

      // Query-bearing searches get retry-then-fail-fast (one retry with
      // jittered backoff on failure/timeout/empty). Fetch-mode calls (URL
      // present) fall through to the fetch path below.
      if (query && isSearchTool(call.name) && !url) {
        // Retry-then-fail-fast: one retry with jittered backoff on
        // failure/timeout/empty (throttle signature), then a clear error
        // telling the model to reformulate or move on. Repeated identical
        // failures are gated so a throttled provider isn't hammered.
        const key = searchQueryOf(call);
        const failures = failedSearches.get(key) ?? 0;
        if (failures >= MAX_SEARCH_FAILURES) {
          const errMsg = `[error] This exact search already failed ${failures} times (provider throttling or no coverage). Do NOT retry it verbatim — reformulate the query with different terms, or move on to your next source.`;
          console.log(`[tool-call] ${call.name}("${query}") → GATED (failed ${failures}x)`);
          onEvent({ type: "tool_call.failure", reason: errMsg, metadata: { tool_name: call.name } });
          return errMsg;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
          try {
            const outputText = await source.callTool(call.name, call.arguments, { signal });
            if (!isEmptySearchResult(outputText)) {
              failedSearches.delete(key);
              const preview = outputText.length > 200 ? `${outputText.substring(0, 200)}...` : outputText;
              console.log(`[tool-call] ${call.name} → OK (${preview})`);
              onEvent({ type: "tool_call.success", tool: call.name, arguments: call.arguments, output: outputText });
              return outputText;
            }
            throw new Error("Search returned no usable results (provider may be throttling).");
          } catch (err) {
            if (signal?.aborted || isAbortError(err)) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            const lastAttempt = attempt === 1;
            console.log(`[tool-call] ${call.name} → attempt ${attempt + 1} FAILED: ${msg}`);
            failedSearches.set(key, failures + attempt + 1);
            if (!lastAttempt) {
              onEvent({
                type: "tool_call.failure",
                reason: `Attempt ${attempt + 1} failed (${msg}) — backing off and retrying once.`,
                metadata: { tool_name: call.name, attempt: attempt + 1, retrying: true },
              });
              await sleepJittered(2000, signal);
              continue;
            }
            const errMsg = `[error] Search failed twice (${msg}). Reformulate with different terms, try a different angle, or move on — do not retry this exact query.`;
            onEvent({ type: "tool_call.failure", reason: errMsg, metadata: { tool_name: call.name } });
            return errMsg;
          }
        }
        // Unreachable — the loop always returns or throws.
        return "[error] Search failed unexpectedly.";
      }

      // Fetch path: explicit fetch names, plus web_search carrying a URL
      // (the unified tool does both jobs — the URL decides).
      if (url && (isFetchTool(call.name) || isSearchTool(call.name))) {
        // Gate: prevent re-scraping URLs that already failed (captcha/timeout/empty).
        const urlArg: string = url;
        if (failedUrls.has(urlArg)) {
          const errMsg = `[error] URL scrape failed previously (captcha/timeout/empty). Do not retry — move to next URL or summarize findings.`;
          console.log(`[tool-call] ${call.name}(${urlArg}) → GATED (already failed)`);
          onEvent({ type: "tool_call.failure", reason: errMsg, metadata: { tool_name: call.name, url: urlArg } });
          return errMsg;
        }
        try {
          const outputText = await source.callTool(call.name, call.arguments, { signal });
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
        const outputText = await source.callTool(call.name, call.arguments, { signal });
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

    // allSettled: one rogue tool call must never take down its siblings'
    // results. (dispatchOne already contains every error, so rejections here
    // would only come from truly unexpected failures — still, never trust it.)
    const settled = await Promise.allSettled(turnToolCalls.map(dispatchOne));
    const outputs = settled.map((s, i) =>
      s.status === "fulfilled" ? s.value : `[error] ${s.reason instanceof Error ? s.reason.message : String(s.reason)} (call ${turnToolCalls[i].name})`,
    );
    // User Cancel during tool dispatch: stop now rather than burning another
    // (already-aborted) LLM turn.
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    }
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