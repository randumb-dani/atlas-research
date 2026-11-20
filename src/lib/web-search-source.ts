/**
 * Unified web search + fetch source: ONE tool the model sees (`web_search`),
 * a provider chain underneath.
 *
 * - `web_search({query})`: DuckDuckGo direct (keyless) or the built-in
 *   multi-engine pool (DDG/Bing/Mojeek/Brave/Wikipedia, rate-limited), plus
 *   self-hosted SearXNG when configured, crw as local failover, and fastcrw
 *   cloud last when keyed.
 * - `web_search({url})`: the built-in scraper (robots-aware, per-host
 *   limited, cached) as primary, crw `crw_scrape` as failover for
 *   JS-rendered pages (only crw has a renderer) and for network/timeout
 *   failures — NOT for authoritative HTTP 4xx or policy blocks.
 *
 * One combined tool (not a search/fetch pair): fewer tools to describe,
 * one dispatch path, and the loop's nudge + text-call healing backstops
 * cover weak tool-callers that would otherwise answer in prose.
 */

import { mcpCallTool, mcpResultToText, type McpToolDef } from "./mcp-client";
import type { ToolSource } from "./tool-types";
import { timeoutForTool, toolArgQuery, toolArgUrl } from "./tool-types";
import { throttledSearch } from "./tool-loop";
import { httpFetch } from "./http";
import { linkSignals, withTimeout } from "./fetch-timeout";
import {
  DdgThrottledError,
  JsWalledError,
  ddgSearch,
  normalizeQuery,
  renderSearchResults,
} from "./ddg-search";
import { ScrapeError, fetchPage } from "./scraper";
import {
  builtinSearchDetailed,
  type BuiltinEngineId,
} from "./search-engines";
import { isSearxngConfigured, searxngSearch } from "./searxng";

export type SearchProviderOrder =
  | "builtin-first"
  | "ddg-first"
  | "crw-first"
  | "searxng-first";

let providerOrder: SearchProviderOrder = "builtin-first";

/** Runtime override (wired to Settings). */
export function setSearchProviderOrder(order: SearchProviderOrder): void {
  providerOrder = order;
}

export function getSearchProviderOrder(): SearchProviderOrder {
  return providerOrder;
}

export const WEB_SEARCH_TOOL_DEF: McpToolDef = {
  name: "web_search",
  description:
    "Search the web or fetch a page. Pass query to search (keyless multi-engine pool returning short Title/URL/Snippet blocks — call this FIRST to find source URLs) or url to fetch one exact page as Markdown text. If both are given, url wins. Search results are SNIPPETS, not evidence — fetch a promising URL with a second call before drawing conclusions or citing it. Issue one search at a time; parallel searches get throttled.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Web search query (3-10 distinctive terms work best)." },
      url: { type: "string", description: "Fetch this exact page URL (from a prior search) as Markdown text." },
      max_results: { type: "number", description: "Search results to return (default 5, max 10; 3-5 is usually enough)." },
    },
  },
};

function queryArg(args: Record<string, unknown>): string {
  return toolArgQuery(args);
}

function urlArg(args: Record<string, unknown>): string | undefined {
  const s = toolArgUrl(args);
  return s || undefined;
}

function maxResultsArg(args: Record<string, unknown>): number {
  const m = Number(args.max_results ?? args.limit ?? 5);
  if (!Number.isFinite(m)) return 5;
  return Math.min(10, Math.max(1, Math.floor(m)));
}

/**
 * Session-scoped crw health. Once a local crw attempt fails with a
 * connectivity error/timeout, stop burning fallback budgets on it for the
 * rest of the session (reset each run, on URL change, or on a successful
 * manual Test). Connection-refused fails fast anyway; this is for the
 * black-hole case (wrong LAN IP) that would otherwise eat 12s per call.
 */
let crwDownForSession = false;

/** Reset per session / URL change. */
export function resetCrwSessionFlag(): void {
  crwDownForSession = false;
}

/** The Settings Test button calls this on success. */
export function markCrwReachable(): void {
  crwDownForSession = false;
}

const CRW_CONNECTIVITY = /error sending request|ECONNREFUSED|connection refused|failed to fetch|network|load failed|timed out/i;

async function crwCall(
  crwServer: string,
  apiKey: string | undefined,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  /** Fallback attempts get a tighter budget so a dead crw can't stall us. */
  timeoutMs: number,
): Promise<string> {
  if (crwDownForSession) {
    throw new Error("crw skipped — unreachable earlier this session");
  }
  try {
    return mcpResultToText(await mcpCallTool(crwServer, name, args, apiKey, { signal, timeoutMs }));
  } catch (err) {
    if (!signal?.aborted && err instanceof Error && CRW_CONNECTIVITY.test(err.message)) {
      crwDownForSession = true;
    }
    throw err;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/**
 * fastcrw.com managed cloud (1000 free credits, no infrastructure): the
 * zero-config escape hatch when DDG is blocked and no local crw runs.
 * Firecrawl-compatible REST — no MCP handshake needed.
 */
const FASTCRW_BASE = "https://api.fastcrw.com";

async function fastcrwSearch(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const linked = linkSignals([signal], 20_000);
  try {
    const res = await httpFetch(`${FASTCRW_BASE}/v1/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, limit: maxResults }),
      signal: linked.signal,
    });
    if (!res.ok) throw new Error(`fastcrw search HTTP ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    const data = asRecord(body)?.data;
    if (!Array.isArray(data)) throw new Error("fastcrw: unexpected response shape");
    const rows = data
      .map((r) => {
        const rec = asRecord(r);
        if (!rec) return null;
        const title = typeof rec.title === "string" ? rec.title : "";
        const url = typeof rec.url === "string" ? rec.url : "";
        const snippet = typeof rec.snippet === "string" ? rec.snippet : typeof rec.description === "string" ? rec.description : "";
        if (!title || !url) return null;
        return { title: title.slice(0, 300), url, snippet: snippet.slice(0, 400) };
      })
      .filter((r): r is { title: string; url: string; snippet: string } => r !== null);
    if (rows.length === 0) throw new Error("fastcrw: no coverage for this query");
    return renderSearchResults(rows, undefined, 5);
  } finally {
    linked.cancel();
  }
}

async function fastcrwScrape(
  url: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const linked = linkSignals([signal], 30_000);
  try {
    const res = await httpFetch(`${FASTCRW_BASE}/v1/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url, formats: ["markdown"] }),
      signal: linked.signal,
    });
    if (!res.ok) throw new Error(`fastcrw scrape HTTP ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    const rec = asRecord(body);
    const data = asRecord(rec?.data) ?? rec;
    const text =
      (data && typeof data.markdown === "string" && data.markdown) ||
      (data && typeof data.content === "string" && data.content) ||
      (typeof rec?.data === "string" && rec.data) ||
      "";
    if (!text.trim()) throw new Error("fastcrw scrape returned no content");
    return text;
  } finally {
    linked.cancel();
  }
}

async function searchWithFallback(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  crwServer: string,
  apiKey: string | undefined,
): Promise<string> {
  // Provider order: the built-in engine pool (free, keyless, rate-limited)
  // by default; local crw next when it is up (free, unlimited); metered
  // fastcrw cloud last (only when a key is configured). "ddg-first" keeps
  // the historical DDG-only primary and then lets the rest of the pool
  // (Bing/Mojeek/Brave/Wikipedia) cover a DDG block.
  // A configured SearXNG instance slots in as self-hosted unmetered
  // capacity.
  const order =
    providerOrder === "searxng-first"
      ? (["searxng", "builtin", "crw", "fastcrw"] as const)
      : providerOrder === "crw-first"
        ? (["crw", "searxng", "builtin", "fastcrw"] as const)
        : providerOrder === "ddg-first"
          ? (["ddg", "searxng", "builtin", "crw", "fastcrw"] as const)
          : (["builtin", "searxng", "crw", "fastcrw"] as const);
  // Overfetch like Unsloth does for policy-filtered results: renderSearchResults
  // drops dictionary/reference pages and unfetchable URLs, so asking for only
  // `maxResults` could leave too few real results. Ask each provider for more,
  // then cap the rendered output back down to what the caller requested.
  const fetchLimit = Math.min(10, maxResults * 2);

  const failures: string[] = [];

  /** One provider attempt: null = no coverage, keep going; throws abort. */
  const tryStep = async (label: string, fn: () => Promise<string | null>): Promise<string | null> => {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    try {
      const text = await fn();
      if (!text || !text.trim() || /no\s+results?\s+found/i.test(text.slice(0, 300))) {
        failures.push(`${label}: no coverage for this query`);
        return null;
      }
      return text;
    } catch (err) {
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${label}: ${msg}`);
      // DDG throttle is expected under burst — don't log it as a scary
      // failure; the failover below is the designed path.
      if (!(err instanceof DdgThrottledError)) {
        console.warn(`[web-search] ${label} search failed: ${msg}`);
      }
      return null;
    }
  };

  for (const provider of order) {
    if (provider === "searxng") {
      if (!isSearxngConfigured()) continue;
      const searxngBudget = Math.max(10_000, timeoutForTool("web_search") - 8_000);
      const text = await tryStep("SearXNG", async () => {
        const results = await withTimeout(
          (sig) => searxngSearch(query, { signal: sig, maxResults: fetchLimit }),
          searxngBudget,
          "SearXNG search",
          signal,
        );
        return results.length > 0 ? renderSearchResults(results, undefined, maxResults) : null;
      });
      if (text) return text;
    } else if (provider === "ddg") {
      // Overall budget so the multi-endpoint ladder can't overrun the turn;
      // leaves room for the fallbacks below.
      const ddgBudget = Math.max(10_000, timeoutForTool("web_search") - 8_000);
      const text = await tryStep("DDG", async () => {
        const results = await withTimeout(
          (sig) => ddgSearch(query, { signal: sig, maxResults: fetchLimit }),
          ddgBudget,
          "DuckDuckGo search",
          signal,
        );
        return results.length > 0 ? renderSearchResults(results, undefined, maxResults) : null;
      });
      if (text) return text;
    } else if (provider === "builtin") {
      // Multi-engine pool. When DDG was already tried first, leave it out so
      // a throttle doesn't get retried immediately; the rest of the pool
      // covers the gap.
      const excludeEngines: BuiltinEngineId[] = providerOrder === "ddg-first" ? ["ddg"] : [];
      const budget = Math.max(10_000, timeoutForTool("web_search") - 6_000);
      const text = await tryStep("built-in", async () => {
        const outcome = await withTimeout(
          (sig) => builtinSearchDetailed(query, { signal: sig, maxResults: fetchLimit, excludeEngines }),
          budget,
          "Built-in search",
          signal,
        );
        if (outcome.results.length === 0) return null;
        // When every surviving result is an encyclopedia page, say so: the
        // model must not present thin Wikipedia-only coverage as current web
        // research (Unsloth labels its Wikipedia fallback the same way).
        const wikiOnly = outcome.results.every((r) => {
          try {
            const host = new URL(r.url).hostname.toLowerCase();
            return host === "wikipedia.org" || host.endsWith(".wikipedia.org");
          } catch {
            return false;
          }
        });
        return renderSearchResults(
          outcome.results,
          wikiOnly
            ? "General web search was unavailable or returned no usable results. " +
              "These are Wikipedia-only encyclopedia results, not current web coverage."
            : undefined,
          maxResults,
        );
      });
      if (text) return text;
    } else if (provider === "crw") {
      // crw fallback goes through the shared SearXNG pace gate:
      // failovers correlate across subagents, which is exactly the burst
      // shape SearXNG's upstreams punish. Skipped fast when session-down.
      const text = await tryStep("crw", () =>
        throttledSearch(() =>
          crwCall(crwServer, apiKey, "crw_search", { query, limit: fetchLimit }, signal, timeoutForTool("crw_search")),
        ),
      );
      if (text) return text;
    } else {
      if (!apiKey) continue;
      const text = await tryStep("fastcrw", () => fastcrwSearch(query, maxResults, apiKey, signal));
      if (text) return text;
    }
  }

  // Every provider failed. Say which half of the redundancy is down so the
  // event log is actionable: crw reachability (start it / check Settings)
  // and the cloud-key option (Settings) when nothing local works.
  const crwDown = failures.some((f) => f.startsWith("crw:"));
  throw new Error(
    `All search providers failed for "${query.slice(0, 120)}" (${failures.join(" | ")}). ` +
      (crwDown ? `Local crw is unreachable. ` : ``) +
      (!apiKey ? `Tip for the user: add a fastcrw.com API key in Settings (1000 free credits) for a managed fallback. ` : ``) +
      `Reformulate with different terms, try a different angle, or move on.`,
  );
}

async function fetchWithFallback(
  url: string,
  signal: AbortSignal | undefined,
  crwServer: string,
  apiKey: string | undefined,
): Promise<string> {
  try {
    return await fetchPage(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // Policy decisions are final: crw/fastcrw would only help us bypass
    // robots.txt or a size/content-type limit, which is not the deal.
    const policyBlock =
      err instanceof ScrapeError &&
      ["robots", "private-host", "invalid-url", "too-large", "unsupported"].includes(err.kind);
    if (policyBlock) throw err;
    // Authoritative origin answers (HTTP 4xx) fail over to nothing — every
    // provider would get the same 404. Everything else (JS wall, timeout,
    // network) tries local crw, then managed fastcrw cloud when keyed.
    const authoritative =
      err instanceof ScrapeError
        ? err.kind === "http" && (err.status ?? 0) >= 400 && (err.status ?? 0) < 500
        : /HTTP 4\d\d/.test(msg);
    if (authoritative) throw err;
    if (!(err instanceof JsWalledError)) {
      console.warn(`[web-search] direct fetch failed, trying crw_scrape: ${msg}`);
    }
    try {
      return await crwCall(crwServer, apiKey, "crw_scrape", { url }, signal, timeoutForTool("crw_scrape"));
    } catch (crwErr) {
      if (signal?.aborted) throw crwErr;
      const crwMsg = crwErr instanceof Error ? crwErr.message : String(crwErr);
      if (!apiKey) {
        throw new Error(`Direct fetch failed (${msg}) and crw_scrape also failed (${crwMsg}).`);
      }
      try {
        return await fastcrwScrape(url, apiKey, signal);
      } catch (fcErr) {
        if (signal?.aborted) throw fcErr;
        const fcMsg = fcErr instanceof Error ? fcErr.message : String(fcErr);
        throw new Error(
          `Direct fetch failed (${msg}); crw_scrape (${crwMsg}) and fastcrw cloud (${fcMsg}) also failed.`,
        );
      }
    }
  }
}

export function webSearchToolSource(crwUrl: string, apiKey?: string): ToolSource {
  const crwServer = `${crwUrl}/mcp`;
  return {
    label: "web",
    listTools: async () => [WEB_SEARCH_TOOL_DEF],
    callTool: async (name, args, opts) => {
      const signal = opts?.signal;
      const url = urlArg(args);
      const n = name.trim().toLowerCase();
      // Fetch path: explicit fetch names, or web_search carrying a URL.
      // A URL wins when both are present — fetching is the concrete action.
      if (n === "crw_scrape" || ((n === "web_search" || n === "web_fetch") && url)) {
        if (!url) throw new Error(`web_search needs {url} to fetch or {query} to search.`);
        return fetchWithFallback(url, signal, crwServer, apiKey);
      }
      // Search path.
      if (n === "web_search" || n === "web_fetch" || n === "crw_search") {
        const query = queryArg(args);
        if (!query) throw new Error(`web_search needs {query} to search or {url} to fetch.`);
        return searchWithFallback(query, maxResultsArg(args), signal, crwServer, apiKey);
      }
      throw new Error(`Unknown tool "${name}" — no registered source provides it.`);
    },
  };
}

/** Normalized-query helpers shared with the tool loop's failure gating. */
export function webSearchQueryOf(args: Record<string, unknown>): string {
  return normalizeQuery(queryArg(args));
}
