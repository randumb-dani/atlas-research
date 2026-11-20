/**
 * Built-in search engine: a small keyless engine pool the app owns.
 *
 * Each adapter talks to a different public search surface, so one block or
 * outage doesn't take research down with it:
 *
 *   ddg        DuckDuckGo JSON + scrape ladder (ddg-search.ts, has its own
 *              tuned pacing) — historically the only provider.
 *   bing       bing.com/search HTML (li.b_algo).
 *   mojeek      mojeek.com/search HTML — independent index, polite to
 *              well-paced clients.
 *   brave      search.brave.com HTML (best-effort; may challenge).
 *   wikipedia  MediaWiki search API — narrow but extremely reliable, and
 *              ideal for entity/definition queries.
 *
 * Everything is governed by the shared KeyedRateLimiter (one lane per
 * engine), so parallel subagent calls get serialized/paced instead of
 * hammering five engines at once. Results are deduped by URL and aggregated
 * in engine-priority order; the caller (`web_search`) only sees one list.
 *
 * Empty results mean "no coverage", not failure. An engine that answers with
 * a block/challenge records a failure (engaging adaptive backoff) and the
 * pool moves on.
 */

import { httpFetch } from "./http";
import { linkSignals, withTimeout } from "./fetch-timeout";
import { getLimiter, type RateLimitStats } from "./rate-limit";
import { BROWSER_HEADERS, readCapped } from "./scraper";
import { DdgThrottledError, ddgSearch, normalizeQuery } from "./ddg-search";

export interface BuiltinResult {
  title: string;
  url: string;
  snippet: string;
}

export type BuiltinEngineId = "ddg" | "bing" | "mojeek" | "brave" | "wikipedia";

export interface BuiltinEngineDef {
  id: BuiltinEngineId;
  label: string;
  /** Minimum ms between request starts for this engine. */
  minIntervalMs: number;
  /** Requests per minute cap. */
  maxPerMinute: number;
  /** Human note for Settings. */
  note: string;
}

export const BUILTIN_ENGINE_DEFS: BuiltinEngineDef[] = [
  { id: "ddg", label: "DuckDuckGo", minIntervalMs: 2000, maxPerMinute: 30, note: "Keyless, most coverage" },
  { id: "bing", label: "Bing", minIntervalMs: 1500, maxPerMinute: 30, note: "Keyless HTML" },
  { id: "mojeek", label: "Mojeek", minIntervalMs: 1500, maxPerMinute: 30, note: "Independent index" },
  { id: "brave", label: "Brave", minIntervalMs: 2500, maxPerMinute: 20, note: "Keyless, may challenge" },
  { id: "wikipedia", label: "Wikipedia", minIntervalMs: 400, maxPerMinute: 60, note: "Reliable entities" },
];

export interface BuiltinSearchConfig {
  /** Engine priority order; disabled engines are filtered out. */
  enabledEngines: BuiltinEngineId[];
  /** Per-engine deadline for one query. Default 12s. */
  perEngineTimeoutMs: number;
  /** Session cache TTL. Default 20 min. */
  cacheTtlMs: number;
}

const DEFAULT_BUILTIN_CONFIG: BuiltinSearchConfig = {
  enabledEngines: ["ddg", "bing", "mojeek", "brave", "wikipedia"],
  perEngineTimeoutMs: 12_000,
  cacheTtlMs: 20 * 60_000,
};

let builtinConfig: BuiltinSearchConfig = { ...DEFAULT_BUILTIN_CONFIG };

/**
 * Get the engine's limiter WITH its pacing config applied. Callers must go
 * through this (never bare `getLimiter`) so a limiter created lazily by a
 * direct call path — before `configureBuiltinSearch` ever ran — still gets
 * the engine's spacing/window caps instead of the generic defaults.
 */
function engineLimiter(id: BuiltinEngineId): ReturnType<typeof getLimiter> {
  const def = BUILTIN_ENGINE_DEFS.find((d) => d.id === id);
  if (!def) return getLimiter(`engine:${id}`);
  return getLimiter(`engine:${id}`, {
    minIntervalMs: def.minIntervalMs,
    maxConcurrent: 1,
    maxPerWindow: def.maxPerMinute,
    windowMs: 60_000,
    failurePenaltyMs: 900,
    maxPenaltyMs: 12_000,
  });
}

/** Runtime override (wired to Settings via syncSearchRuntime). */
export function configureBuiltinSearch(patch: Partial<BuiltinSearchConfig>): void {
  builtinConfig = { ...builtinConfig, ...patch };
  for (const def of BUILTIN_ENGINE_DEFS) {
    if (def.id === "ddg") continue; // DDG paces itself inside ddg-search.ts.
    engineLimiter(def.id);
  }
}

export function getBuiltinSearchConfig(): BuiltinSearchConfig {
  return { ...builtinConfig, enabledEngines: [...builtinConfig.enabledEngines] };
}

// --- diagnostics --------------------------------------------------------

export interface EngineTrace {
  engine: BuiltinEngineId;
  ok: boolean;
  ms: number;
  results: number;
  error?: string;
  /** True when the engine was skipped without a request (e.g. cooling down). */
  skipped?: boolean;
}

export interface BuiltinSearchOutcome {
  results: BuiltinResult[];
  traces: EngineTrace[];
  fromCache: boolean;
}

let lastTraces: EngineTrace[] = [];

export function getLastEngineTraces(): EngineTrace[] {
  return lastTraces;
}

export interface BuiltinSearchStats {
  limiters: RateLimitStats[];
  cacheEntries: number;
  lastTraces: EngineTrace[];
}

export function getBuiltinSearchStats(): BuiltinSearchStats {
  return {
    limiters: ["bing", "mojeek", "brave", "wikipedia"].map((id) =>
      engineLimiter(id as BuiltinEngineId).stats(),
    ),
    cacheEntries: resultCache.size,
    lastTraces,
  };
}

// --- cache + dedup ------------------------------------------------------

const resultCache = new Map<string, { at: number; results: BuiltinResult[]; traces: EngineTrace[] }>();
const inflight = new Map<string, Promise<BuiltinSearchOutcome>>();

export function clearBuiltinSearchCache(): void {
  resultCache.clear();
}

export function resetBuiltinSearch(): void {
  resultCache.clear();
  lastTraces = [];
  for (const def of BUILTIN_ENGINE_DEFS) {
    if (def.id === "ddg") continue;
    engineLimiter(def.id).reset();
  }
}

function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function pushResult(
  out: BuiltinResult[],
  seen: Set<string>,
  title: string,
  url: string,
  snippet: string,
  maxResults: number,
): void {
  if (out.length >= maxResults) return;
  const clean = canonicalUrl(url);
  if (!clean || seen.has(clean)) return;
  const t = title.trim().replace(/\s+/g, " ");
  if (!t) return;
  seen.add(clean);
  out.push({
    title: t.slice(0, 300),
    url: clean,
    snippet: snippet.trim().replace(/\s+/g, " ").slice(0, 400),
  });
}

// --- HTML helpers -------------------------------------------------------

function cleanSnippet(...nodes: (Element | null)[]): string {
  for (const node of nodes) {
    const text = (node?.textContent ?? "").trim();
    if (text) return text.replace(/\s+/g, " ");
  }
  return "";
}

function unwrapBingHref(href: string): string | null {
  try {
    const url = new URL(href, "https://www.bing.com");
    if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname.startsWith("/ck/a")) {
      const u = url.searchParams.get("u");
      if (u?.startsWith("a1")) {
        const b64 = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const decoded = atob(padded);
        return /^https?:\/\//i.test(decoded) ? decoded : null;
      }
      return null;
    }
    if (!/^https?:\/\//i.test(url.toString())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Generic extraction when an engine's markup drifts. NARROW on purpose: a
 * no-results or challenge page still has plenty of external links (footer,
 * "definition" cards, ads) and accepting any of them produces bogus results.
 * Only links inside a result-like container with an actual snippet qualify.
 */
function parseGenericAnchors(
  doc: Document,
  engineHost: string,
  maxResults: number,
): BuiltinResult[] {
  const out: BuiltinResult[] = [];
  const seen = new Set<string>();
  const anchors = Array.from(
    doc.querySelectorAll(
      "#results li a[href], #web li a[href], main li a[href], article a[href], .result a[href], li.b_algo a[href]",
    ),
  );
  for (const a of anchors) {
    if (out.length >= maxResults) break;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, `https://${engineHost}`);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.hostname === engineHost || url.hostname.endsWith(`.${engineHost}`)) continue;
    const title = (a.textContent ?? "").trim().replace(/\s+/g, " ");
    if (title.length < 10 || title.length > 300) continue;
    const container = a.closest("li, article, .result");
    const snippet = cleanSnippet(container?.querySelector("p, .b_caption, .snippet, .result__snippet") ?? null);
    if (snippet.length < 20) continue;
    pushResult(out, seen, title, url.toString(), snippet, maxResults);
  }
  return out;
}

const BLOCK_MARKERS = [
  "captcha",
  "anomaly-modal",
  "challenge-form",
  "unusual traffic",
  "verify you are human",
  "are you a robot",
  "access denied",
];

/** Visible head text: scripts/styles stripped so a JS bundle mentioning
 * "captcha" doesn't flag an otherwise normal results page. */
function visibleHead(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return `${title} ${stripped}`.slice(0, 6_000).toLowerCase();
}

function looksBlocked(status: number, html: string): boolean {
  if (status === 429 || status === 403 || status === 202) return true;
  if (status < 200 || status >= 300) return true;
  const head = visibleHead(html);
  return BLOCK_MARKERS.some((m) => head.includes(m));
}

/** Hard cap on one engine results page (they are normally ~100 KB). */
const MAX_ENGINE_PAGE_BYTES = 1_500_000;

async function fetchEngineHtml(
  engine: BuiltinEngineId,
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const limiter = engineLimiter(engine);
  if (limiter.isCoolingDown(engine)) {
    throw new Error(`${engine} cooling down after repeated failures`);
  }
  const release = await limiter.acquire(engine, signal);
  const linked = linkSignals([signal], timeoutMs);
  try {
    const res = await httpFetch(url, {
      headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      signal: linked.signal,
      redirect: "follow",
    });
    // Byte-capped read: an engine (or a hijacked redirect) must not be able
    // to hand us an unbounded body that res.text() buffers whole.
    const body = await readCapped(res, MAX_ENGINE_PAGE_BYTES);
    const html = new TextDecoder().decode(body);
    if (!res.ok || looksBlocked(res.status, html)) {
      const what = res.ok ? "served a challenge page" : `blocked the request (HTTP ${res.status})`;
      throw new Error(`${engine} ${what}`);
    }
    limiter.reportSuccess(engine);
    return html;
  } catch (err) {
    if (!signal?.aborted && !(err instanceof DdgThrottledError)) {
      limiter.reportFailure(engine);
    }
    throw err;
  } finally {
    linked.cancel();
    release();
  }
}

// --- adapters -----------------------------------------------------------

function parseBing(html: string, maxResults: number): BuiltinResult[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: BuiltinResult[] = [];
  const seen = new Set<string>();
  for (const li of Array.from(doc.querySelectorAll("li.b_algo"))) {
    if (out.length >= maxResults) break;
    const a = li.querySelector("h2 a[href]");
    if (!a) continue;
    const href = a.getAttribute("href") ?? "";
    const url = unwrapBingHref(href);
    if (!url) continue;
    const title = (a.textContent ?? "").trim();
    const snippet = cleanSnippet(
      li.querySelector(".b_caption p"),
      li.querySelector(".b_snippet"),
      li.querySelector("p"),
    );
    pushResult(out, seen, title, url, snippet, maxResults);
  }
  if (out.length === 0) return parseGenericAnchors(doc, "bing.com", maxResults);
  return out;
}

function parseMojeek(html: string, maxResults: number): BuiltinResult[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: BuiltinResult[] = [];
  const seen = new Set<string>();
  const rows = doc.querySelectorAll("ul.results-standard li, .results-standard li, .results li");
  for (const li of Array.from(rows)) {
    if (out.length >= maxResults) break;
    const a = li.querySelector("h2 a[href], a.title, a.ob");
    if (!a) continue;
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) continue;
    const snippet = cleanSnippet(li.querySelector("p.s"), li.querySelector("p"));
    pushResult(out, seen, (a.textContent ?? "").trim(), href, snippet, maxResults);
  }
  if (out.length === 0) return parseGenericAnchors(doc, "mojeek.com", maxResults);
  return out;
}

function parseBrave(html: string, maxResults: number): BuiltinResult[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: BuiltinResult[] = [];
  const seen = new Set<string>();
  const cards = doc.querySelectorAll("#results .snippet, .snippet[data-type='web'], .snippet");
  for (const card of Array.from(cards)) {
    if (out.length >= maxResults) break;
    const a = card.querySelector("a[href]");
    if (!a) continue;
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) continue;
    const title =
      (card.querySelector(".title, .snippet-title")?.textContent ?? a.textContent ?? "").trim();
    const snippet = cleanSnippet(
      card.querySelector(".snippet-description"),
      card.querySelector(".snippet-content"),
      card.querySelector("p"),
    );
    pushResult(out, seen, title, href, snippet, maxResults);
  }
  if (out.length === 0) return parseGenericAnchors(doc, "search.brave.com", maxResults);
  return out;
}

function stripHtml(input: string): string {
  const doc = new DOMParser().parseFromString(input, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function wikipediaSearch(
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxResults: number,
): Promise<BuiltinResult[]> {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: String(Math.max(1, Math.min(10, maxResults))),
    format: "json",
    utf8: "1",
    origin: "*",
  });
  const limiter = engineLimiter("wikipedia");
  const release = await limiter.acquire("wikipedia", signal);
  const linked = linkSignals([signal], timeoutMs);
  try {
    const res = await httpFetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
      signal: linked.signal,
    });
    if (!res.ok) {
      limiter.reportFailure("wikipedia");
      throw new Error(`wikipedia HTTP ${res.status}`);
    }
    const json: unknown = await res.json().catch(() => null);
    const rows =
      json && typeof json === "object" && !Array.isArray(json)
        ? (json as Record<string, unknown>).query
        : null;
    const list =
      rows && typeof rows === "object" && !Array.isArray(rows)
        ? (rows as Record<string, unknown>).search
        : null;
    if (!Array.isArray(list)) {
      limiter.reportFailure("wikipedia");
      throw new Error("wikipedia: unexpected response shape");
    }
    limiter.reportSuccess("wikipedia");
    const out: BuiltinResult[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (out.length >= maxResults) break;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const title = typeof rec.title === "string" ? rec.title : "";
      if (!title) continue;
      const snippet = typeof rec.snippet === "string" ? stripHtml(rec.snippet) : "";
      const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
      pushResult(out, seen, title, url, snippet, maxResults);
    }
    return out;
  } finally {
    linked.cancel();
    release();
  }
}

async function runHtmlEngine(
  engine: "bing" | "mojeek" | "brave",
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxResults: number,
): Promise<BuiltinResult[]> {
  const q = encodeURIComponent(query);
  const url =
    engine === "bing"
      ? `https://www.bing.com/search?q=${q}&count=${Math.max(5, maxResults)}&setlang=en&cc=us`
      : engine === "mojeek"
        ? `https://www.mojeek.com/search?q=${q}`
        : `https://search.brave.com/search?q=${q}&source=web`;
  const html = await fetchEngineHtml(engine, url, signal, timeoutMs);
  const results =
    engine === "bing" ? parseBing(html, maxResults)
      : engine === "mojeek" ? parseMojeek(html, maxResults)
        : parseBrave(html, maxResults);
  return results;
}

async function engineSearch(
  engine: BuiltinEngineId,
  query: string,
  signal: AbortSignal | undefined,
  maxResults: number,
): Promise<BuiltinResult[]> {
  const timeoutMs = builtinConfig.perEngineTimeoutMs;
  switch (engine) {
    case "ddg":
      return ddgSearch(query, { signal, maxResults });
    case "wikipedia":
      return wikipediaSearch(query, signal, timeoutMs, maxResults);
    default:
      return runHtmlEngine(engine, query, signal, timeoutMs, maxResults);
  }
}

// --- public search ------------------------------------------------------

export interface BuiltinSearchOptions {
  signal?: AbortSignal;
  maxResults?: number;
  /** Engines to leave out (e.g. DDG was already tried in the provider chain). */
  excludeEngines?: BuiltinEngineId[];
}

/**
 * Query the engine pool in priority order, stopping once enough results are
 * collected. Returns `[]` for "no coverage"; throws only when every engine
 * errored (so the caller can fail over to SearXNG/crw/cloud).
 */
export async function builtinSearchDetailed(
  query: string,
  opts: BuiltinSearchOptions = {},
): Promise<BuiltinSearchOutcome> {
  const q = normalizeQuery(query);
  if (!q) return { results: [], traces: [], fromCache: false };

  const maxResults = Math.max(1, Math.min(10, opts.maxResults ?? 5));
  const excluded = new Set(opts.excludeEngines ?? []);
  const engines = builtinConfig.enabledEngines.filter((id) => !excluded.has(id));
  if (engines.length === 0) {
    throw new Error("No built-in search engines enabled (add one in Settings).");
  }

  const key = `${engines.join("+")}|${maxResults}|${q}`;
  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.at < builtinConfig.cacheTtlMs) {
    return { results: cached.results.slice(0, maxResults), traces: cached.traces, fromCache: true };
  }
  const ongoing = inflight.get(key);
  if (ongoing) return ongoing;

  const run = (async (): Promise<BuiltinSearchOutcome> => {
    const results: BuiltinResult[] = [];
    const seen = new Set<string>();
    const traces: EngineTrace[] = [];
    const signal = opts.signal;

    for (const engine of engines) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
      if (results.length >= maxResults) break;

      const started = Date.now();
      try {
        const hits = await withTimeout(
          (sig) => engineSearch(engine, q, sig, maxResults),
          builtinConfig.perEngineTimeoutMs,
          `${engine} search`,
          signal,
        );
        for (const hit of hits) {
          const canonical = canonicalUrl(hit.url);
          if (!canonical || seen.has(canonical)) continue;
          seen.add(canonical);
          results.push(hit);
          if (results.length >= maxResults) break;
        }
        traces.push({
          engine,
          ok: true,
          ms: Date.now() - started,
          results: hits.length,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        traces.push({
          engine,
          ok: false,
          ms: Date.now() - started,
          results: 0,
          error: message,
        });
        // DDG throttle is expected under burst — the pool moving on is the
        // designed path, so don't log it as a scary failure.
        if (!(err instanceof DdgThrottledError)) {
          console.warn(`[builtin-search] ${engine} failed: ${message}`);
        }
      }
    }

    lastTraces = traces;

    if (results.length === 0) {
      const failures = traces.filter((t) => !t.ok);
      if (failures.length === traces.length && traces.length > 0) {
        throw new Error(
          `All built-in engines failed for "${query.slice(0, 120)}" ` +
            `(${failures.map((t) => `${t.engine}: ${t.error ?? "failed"}`).join(" | ")}). ` +
            `Reformulate, or move on.`,
        );
      }
      // Some engine answered legitimately with nothing — no coverage.
      resultCache.set(key, { at: Date.now(), results: [], traces });
      return { results: [], traces, fromCache: false };
    }

    resultCache.set(key, { at: Date.now(), results, traces });
    return { results, traces, fromCache: false };
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** Convenience wrapper for callers that only need the results. */
export async function builtinSearch(
  query: string,
  opts: BuiltinSearchOptions = {},
): Promise<BuiltinResult[]> {
  const outcome = await builtinSearchDetailed(query, opts);
  return outcome.results;
}

export interface BuiltinTestResult {
  ok: boolean;
  ms: number;
  results: number;
  traces: EngineTrace[];
  error?: string;
}

/** Live self-diagnostic for the Settings Test button. */
export async function testBuiltinSearch(query = "wikipedia"): Promise<BuiltinTestResult> {
  const started = Date.now();
  try {
    const outcome = await builtinSearchDetailed(query, { maxResults: 3 });
    return {
      ok: outcome.results.length > 0,
      ms: Date.now() - started,
      results: outcome.results.length,
      traces: outcome.traces,
      error: outcome.results.length === 0 ? "Engines answered but returned no parseable results." : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      results: 0,
      traces: lastTraces,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
