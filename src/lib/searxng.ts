/**
 * Self-hosted SearXNG search + page-scrape, called directly from the app
 * (no API key, no metasearch fan-out beyond what your own instance does).
 *
 * Why this exists: DuckDuckGo's public endpoints rate-limit bursty clients
 * (subagent x parallel-call pattern), and crw/fastcrw are optional extras.
 * A local SearXNG instance is the self-hosted answer — you control the
 * engines, the rate limits, and the privacy — so it slots into the unified
 * `web_search` chain in web-search-source.ts as a first-class provider:
 * SearXNG -> DDG-direct -> local crw -> fastcrw cloud (each skipped when
 * unconfigured/unreachable).
 *
 * Search: GET `{base}/search?q=...&format=json` (the instance's native JSON
 * API). When an instance disables `format=json`, we fall back to parsing the
 * HTML result page generically (any external link with real text).
 *
 * Scrape: SearXNG is a metasearcher, not a renderer — it has no page-content
 * API. Page fetches therefore reuse the app's static extractor
 * (`ddgFetchPage`, which is engine-agnostic despite the name) as primary,
 * with crw/fastcrw as failover for JS-rendered pages. `searxngFetchPage`
 * below is that static fetch under a SearXNG-flavoured name so the fetch
 * chain reads symmetrically and the Settings Test button can report it.
 */

import { httpFetch } from "./http";
import { linkSignals, sleep } from "./fetch-timeout";
import { ddgFetchPage, normalizeQuery } from "./ddg-search";

export interface SearxngSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearxngConfig {
  /** Base URL of the instance, e.g. http://localhost:8888. Empty = disabled. */
  baseUrl: string;
  /** Minimum ms between the START of two SearXNG searches. Default 500. */
  minIntervalMs: number;
  /** Per-attempt search timeout. Default 20_000. */
  searchTimeoutMs: number;
  /** Page-fetch timeout. Default 30_000. */
  fetchTimeoutMs: number;
  /** Results per search (one page = one request; never paginated). Default 5. */
  maxResults: number;
  /** Session result-cache TTL. Default 30 min. */
  cacheTtlMs: number;
}

const DEFAULT_SEARXNG_CONFIG: SearxngConfig = {
  baseUrl: "http://localhost:8888",
  minIntervalMs: 500,
  searchTimeoutMs: 20_000,
  fetchTimeoutMs: 30_000,
  maxResults: 5,
  cacheTtlMs: 30 * 60_000,
};

let searxngConfig: SearxngConfig = { ...DEFAULT_SEARXNG_CONFIG };

/** Runtime override (wired to Settings via syncSearchRuntime). */
export function configureSearxng(patch: Partial<SearxngConfig>): void {
  searxngConfig = { ...searxngConfig, ...patch };
}

export function getSearxngConfig(): SearxngConfig {
  return { ...searxngConfig };
}

/** Normalized base URL (no trailing slash), or "" when disabled. */
export function searxngBase(): string {
  return searxngConfig.baseUrl.trim().replace(/\/+$/, "");
}

export function isSearxngConfigured(): boolean {
  return searxngBase().length > 0;
}

/** Thrown when the instance is blocking/failing us — caller fails over. */
export class SearxngError extends Error {
  constructor(message = "SearXNG request failed.") {
    super(message);
    this.name = "SearxngError";
  }
}

// --- lightweight pace gate (module-level: shared across subagents) ---

let lastSearchStart = 0;

interface PaceWaiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
}

const paceQueue: PaceWaiter[] = [];
let paceDraining = false;

function acquirePaceSlot(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    paceQueue.push({ resolve, reject, signal });
    void drainPaceQueue();
  });
}

async function drainPaceQueue(): Promise<void> {
  if (paceDraining) return;
  paceDraining = true;
  try {
    while (paceQueue.length > 0) {
      const waiter = paceQueue[0];
      if (waiter.signal?.aborted) {
        paceQueue.shift();
        waiter.reject(waiter.signal.reason ?? new Error("Aborted"));
        continue;
      }
      const wait = Math.max(0, searxngConfig.minIntervalMs - (Date.now() - lastSearchStart));
      if (wait > 0) {
        try {
          await sleep(wait, waiter.signal);
        } catch (err) {
          paceQueue.shift();
          waiter.reject(err);
          continue;
        }
      }
      if (waiter.signal?.aborted) {
        paceQueue.shift();
        waiter.reject(waiter.signal.reason ?? new Error("Aborted"));
        continue;
      }
      lastSearchStart = Date.now();
      paceQueue.shift();
      waiter.resolve();
    }
  } finally {
    paceDraining = false;
  }
}

/** Reset pacing state — call at the start of a new research session. */
export function resetSearxngThrottle(): void {
  lastSearchStart = 0;
}

// --- result cache + in-flight dedup ---

const resultCache = new Map<string, { at: number; results: SearxngSearchResult[] }>();
const inflight = new Map<string, Promise<SearxngSearchResult[]>>();

function cacheKey(q: string): string {
  return `${searxngBase()}|${normalizeQuery(q)}`;
}

/** Cleared on new research runs so a fresh run never serves stale results. */
export function clearSearxngCache(): void {
  resultCache.clear();
}

// --- response parsing ---

function strField(r: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function pushRow(
  out: SearxngSearchResult[],
  seen: Set<string>,
  title: string,
  url: string,
  snippet: string,
  maxResults: number,
): void {
  const t = title.trim().replace(/\s+/g, " ");
  const u = url.trim();
  if (!t || !u || out.length >= maxResults) return;
  if (!/^https?:\/\//i.test(u)) return;
  if (seen.has(u)) return;
  // Drop SearXNG-internal links (infobox thumbnails served by the instance).
  if (u.startsWith(searxngBase())) return;
  seen.add(u);
  out.push({ title: t.slice(0, 300), url: u, snippet: snippet.trim().replace(/\s+/g, " ").slice(0, 400) });
}

function parseJsonResults(json: unknown, maxResults: number): SearxngSearchResult[] {
  const out: SearxngSearchResult[] = [];
  const seen = new Set<string>();
  const rec = asRecord(json);
  const raw = rec?.results ?? json;
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (out.length >= maxResults) break;
    const r = asRecord(item);
    if (!r) continue;
    pushRow(
      out,
      seen,
      strField(r, "title", "t"),
      strField(r, "url", "u"),
      strField(r, "content", "snippet", "a"),
      maxResults,
    );
  }
  return out;
}

/** Generic HTML fallback for instances with `format=json` disabled. */
function parseHtmlResults(html: string, maxResults: number): SearxngSearchResult[] {
  const out: SearxngSearchResult[] = [];
  const seen = new Set<string>();
  const doc = new DOMParser().parseFromString(html, "text/html");
  // SearXNG default theme marks results as article.result...
  const anchors = Array.from(doc.querySelectorAll("article.result a[href], .result a[href], h3 a[href], h4 a[href]"));
  const pool = anchors.length > 0 ? anchors : Array.from(doc.querySelectorAll("a[href]"));
  for (const a of pool) {
    if (out.length >= maxResults) break;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href || !/^https?:\/\//i.test(href)) continue;
    const title = (a.textContent ?? "").trim().replace(/\s+/g, " ");
    if (title.length < 10 || title.length > 300) continue;
    const container = a.closest("article, .result, div") ?? a.parentElement;
    const snippet = (container?.querySelector("p.content, .content, p")?.textContent ?? "")
      .trim()
      .replace(/\s+/g, " ");
    pushRow(out, seen, title, href, snippet, maxResults);
  }
  return out;
}

async function fetchJsonResults(
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxResults: number,
): Promise<SearxngSearchResult[]> {
  const base = searxngBase();
  const params = new URLSearchParams({
    q: query,
    format: "json",
    language: "en",
    safesearch: "0",
    categories: "general",
    pageno: "1",
  });
  const linked = linkSignals([signal], timeoutMs);
  try {
    const res = await httpFetch(`${base}/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: linked.signal,
    });
    if (!res.ok) throw new SearxngError(`SearXNG search HTTP ${res.status}.`);
    const json: unknown = await res.json().catch(() => null);
    return parseJsonResults(json, maxResults);
  } finally {
    linked.cancel();
  }
}

async function fetchHtmlResults(
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxResults: number,
): Promise<SearxngSearchResult[]> {
  const base = searxngBase();
  const params = new URLSearchParams({ q: query, language: "en", pageno: "1" });
  const linked = linkSignals([signal], timeoutMs);
  try {
    const res = await httpFetch(`${base}/search?${params.toString()}`, {
      headers: { Accept: "text/html" },
      signal: linked.signal,
    });
    if (!res.ok) throw new SearxngError(`SearXNG HTML fallback HTTP ${res.status}.`);
    const html = await res.text().catch(() => "");
    return parseHtmlResults(html, maxResults);
  } finally {
    linked.cancel();
  }
}

/**
 * Search via the configured SearXNG instance. Returns results (possibly [])
 * — empty means "no coverage", NOT failure. Throws SearxngError when the
 * instance is unreachable/blocking us (caller fails over to the next
 * provider), or when no instance is configured at all.
 */
export async function searxngSearch(
  query: string,
  opts?: { signal?: AbortSignal; maxResults?: number },
): Promise<SearxngSearchResult[]> {
  if (!isSearxngConfigured()) {
    throw new SearxngError("No SearXNG instance configured (set one in Settings).");
  }
  const q = normalizeQuery(query);
  if (!q) return [];
  const maxResults = opts?.maxResults ?? searxngConfig.maxResults;
  const signal = opts?.signal;
  const key = cacheKey(q);

  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.at < searxngConfig.cacheTtlMs) {
    return cached.results.slice(0, maxResults);
  }
  const ongoing = inflight.get(key);
  if (ongoing) return ongoing.then((r) => r.slice(0, maxResults));

  const run = (async (): Promise<SearxngSearchResult[]> => {
    await acquirePaceSlot(signal);
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");

    let lastError: unknown = null;
    // 1. Native JSON API.
    try {
      const hits = await fetchJsonResults(q, signal, searxngConfig.searchTimeoutMs, maxResults);
      if (hits.length > 0) {
        resultCache.set(key, { at: Date.now(), results: hits });
        return hits;
      }
      lastError = new Error("SearXNG returned no parseable results.");
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
    }
    // 2. HTML fallback (instances with search formats restricted).
    if (!signal?.aborted) {
      try {
        const hits = await fetchHtmlResults(q, signal, searxngConfig.searchTimeoutMs, maxResults);
        if (hits.length > 0) {
          resultCache.set(key, { at: Date.now(), results: hits });
          return hits;
        }
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
      }
    }
    resultCache.set(key, { at: Date.now(), results: [] });
    throw lastError instanceof Error ? lastError : new SearxngError(String(lastError));
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Scrape a page as Markdown-ish text when SearXNG is the active provider.
 * SearXNG itself has no content API, so this is the app's static extractor
 * (engine-agnostic) with the instance's fetch timeout applied — JS-rendered
 * pages still fail over to crw/fastcrw in the web_search chain.
 */
export async function searxngFetchPage(
  url: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  return ddgFetchPage(url, {
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs ?? searxngConfig.fetchTimeoutMs,
  });
}

export interface SearxngTestResult {
  ok: boolean;
  results?: number;
  ms?: number;
  error?: string;
}

/** Live self-diagnostic: one real search against the configured instance. */
export async function testSearxngConnection(baseUrl?: string): Promise<SearxngTestResult> {
  const t0 = Date.now();
  const override = typeof baseUrl === "string" && baseUrl.trim();
  const prev = searxngConfig.baseUrl;
  if (override) searxngConfig.baseUrl = override.trim();
  try {
    const results = await searxngSearch("wikipedia", { maxResults: 3 });
    const ms = Date.now() - t0;
    if (results.length === 0) {
      return { ok: false, ms, error: "Connected but no parseable results (check enabled engines/formats)." };
    }
    return { ok: true, results: results.length, ms };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (override) searxngConfig.baseUrl = prev;
  }
}
