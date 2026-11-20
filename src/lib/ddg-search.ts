/**
 * DuckDuckGo search + page-fetch, called directly from the app (no SearXNG,
 * no metasearch fan-out, no API key).
 *
 * Why this exists: crw's SearXNG backend fans one query out to every enabled
 * upstream engine at once, and those engines CAPTCHA/429 bursty parallel
 * clients — exactly our subagent × parallel-call pattern. DDG's own
 * endpoints tolerate a well-paced sequential client far better, and they're
 * keyless, so DDG is the primary provider with crw as automatic failover
 * (see the unified `web_search` source in tool-loop.ts).
 *
 * Rate-limit defense (DDG limits by IP, answers with 429/202/403, a
 * challenge page, or silently-empty results):
 *  1. Global serialization with an adaptive throttle — one DDG search in
 *     flight, min spacing + jitter between starts, and a shared
 *     consecutive-error counter: failures add exponential backoff to every
 *     lane, successes ease it back off, and only sustained failure (5+
 *     consecutive failed calls) engages a short fail-fast cooldown.
 *     Fetches are NOT paced here: they hit thousands of different hosts.
 *  2. Small max_results (default 5) — one result page is one HTTP request;
 *     we never paginate.
 *  3. Endpoint rotation: lite (POST, its native form usage) → html
 *     subdomain → duckduckgo.com/html. A block on one endpoint often still
 *     serves on another.
 *  4. Throttle cooldown as above, so the caller fails over to crw instead
 *     of burning a block window on doomed retries.
 *  5. Session cache + in-flight dedup: parallel subagents asking the same
 *     thing share one request. Long model-generated queries are trimmed to
 *     DDG's ~80-char sweet spot (word-boundary) before sending.
 */

import { httpFetch } from "./http";
import { linkSignals, sleep, TimeoutError } from "./fetch-timeout";
import { BROWSER_HEADERS, fetchPage, parseScrapeUrl } from "./scraper";

export { JsWalledError } from "./scraper";

export interface DdgSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DdgConfig {
  /** Minimum ms between the START of two DDG searches. Default 2000. */
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

const DEFAULT_DDG_CONFIG: DdgConfig = {
  minIntervalMs: 2000,
  searchTimeoutMs: 20_000,
  fetchTimeoutMs: 30_000,
  maxResults: 5,
  cacheTtlMs: 30 * 60_000,
};

let ddgConfig: DdgConfig = { ...DEFAULT_DDG_CONFIG };

/** Runtime override (wired to Settings). */
export function configureDdg(patch: Partial<DdgConfig>): void {
  ddgConfig = { ...ddgConfig, ...patch };
}

export function getDdgConfig(): DdgConfig {
  return { ...ddgConfig };
}

/** Thrown when DDG is actively blocking us — the caller should fail over. */
export class DdgThrottledError extends Error {
  constructor(message = "DuckDuckGo is rate-limiting this machine right now.") {
    super(message);
    this.name = "DdgThrottledError";
  }
}

// --- adaptive throttle + pacing (module-level: shared across subagents) ---

// Sustained failure engages a short fail-fast cooldown (caller fails over
// to crw meanwhile). Capped so a long run always recovers mid-run.
const THROTTLE_COOLDOWN_CAP_MS = 30_000;

let consecutiveErrors = 0;
let cooldownUntil = 0;

function inCooldown(): boolean {
  return Date.now() < cooldownUntil;
}

/** Call when a DDG call fully succeeds — eases error pressure back off. */
function reportDdgSuccess(): void {
  consecutiveErrors = Math.max(0, consecutiveErrors - 1);
}

/**
 * Call when a DDG call fails on every endpoint. Only sustained failure
 * (5+ consecutive failed calls) engages the fail-fast cooldown; isolated
 * failures just add backoff to subsequent pacing (see currentPenaltyMs).
 */
function reportDdgError(): void {
  consecutiveErrors++;
  if (consecutiveErrors >= 5) {
    cooldownUntil = Date.now() + Math.min(THROTTLE_COOLDOWN_CAP_MS, consecutiveErrors * 3_000);
    console.warn(`[ddg] ${consecutiveErrors} consecutive failures — failing fast briefly`);
  }
}

/** Extra delay (ms) error pressure currently adds to pacing; 0 when healthy. */
function currentPenaltyMs(): number {
  const remaining = cooldownUntil - Date.now();
  if (remaining > 0) return remaining;
  if (consecutiveErrors >= 2) return Math.min(8_000, consecutiveErrors * 800);
  return 0;
}

/** Reset error pressure — call at the start of a new research session. */
export function resetDdgThrottle(): void {
  consecutiveErrors = 0;
  cooldownUntil = 0;
}

interface PaceWaiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
}

let lastSearchStart = 0;
const paceQueue: PaceWaiter[] = [];
let paceDraining = false;

/**
 * FIFO pace gate: one DDG search in flight, min spacing + random jitter
 * between starts, plus the adaptive error penalty. Resolves once this call
 * may start; rejects if its signal aborts while queued or waiting.
 */
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
      const jitter = Math.floor(Math.random() * 600);
      const effectiveDelay = ddgConfig.minIntervalMs + jitter + currentPenaltyMs();
      const wait = Math.max(0, effectiveDelay - (Date.now() - lastSearchStart));
      if (wait > 0) {
        try {
          await sleep(wait, waiter.signal);
        } catch (err) {
          // Aborted mid-wait: drop this waiter, keep draining the rest.
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

// --- result cache + in-flight dedup ---

const resultCache = new Map<string, { at: number; results: DdgSearchResult[] }>();
const inflight = new Map<string, Promise<DdgSearchResult[]>>();

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Max query length sent to DDG — it chokes on 100+ char queries. */
const MAX_DDG_QUERY_LENGTH = 80;

/**
 * Per-endpoint cap inside the ladder (Unsloth does the same for its engine
 * tiers): a blocked endpoint must not eat the entire search budget before
 * later endpoints and the Instant Answers fallback get a chance to answer.
 * The caller's overall withTimeout still bounds the whole ladder.
 */
const DDG_ENDPOINT_CAP_MS = 8_000;

/** Trim a query to DDG's sweet spot without cutting mid-word. */
function trimQuery(query: string): string {
  if (query.length <= MAX_DDG_QUERY_LENGTH) return query;
  const cut = query.slice(0, MAX_DDG_QUERY_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
}

/** Cleared on new research runs so a fresh run never serves stale results. */
export function clearDdgCache(): void {
  resultCache.clear();
}

export interface DdgTestResult {
  ok: boolean;
  endpoint?: string;
  results?: number;
  ms?: number;
  error?: string;
}

/** Live self-diagnostic: runs one real search and reports what happened. */
export async function testDdgConnection(): Promise<DdgTestResult> {
  const t0 = Date.now();
  try {
    const results = await ddgSearch("duckduckgo", { maxResults: 3 });
    const ms = Date.now() - t0;
    if (results.length === 0) {
      return { ok: false, ms, error: "Connected but no parseable results." };
    }
    return { ok: true, endpoint: lastWorkingEndpoint ?? undefined, results: results.length, ms };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- search ---

interface DdgEndpoint {
  /** Short label for diagnostics (Test DDG button, logs). */
  name: string;
  url: (q: string) => string;
  method: "GET" | "POST";
}

/** Last endpoint that served a successful search (diagnostics only). */
let lastWorkingEndpoint: string | null = null;

export function getLastWorkingEndpoint(): string | null {
  return lastWorkingEndpoint;
}

const DDG_ENDPOINTS: DdgEndpoint[] = [
  // lite's own form posts — match its native usage.
  { name: "lite", url: () => "https://lite.duckduckgo.com/lite/", method: "POST" },
  { name: "html", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, method: "GET" },
  { name: "duckduckgo.com/html", url: (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`, method: "GET" },
];

// --- best-effort cookie jar -------------------------------------------
// DDG's bot detection is kinder to clients that accept and resend cookies.
// Response header access varies by fetch implementation (getSetCookie may
// not exist; a merged set-cookie header mangles Expires commas), so this
// is defensive: whatever parses cleanly is kept, the rest ignored.

const cookieJar = new Map<string, string>();
const COOKIE_ATTRS = new Set(["expires", "max-age", "path", "domain", "secure", "httponly", "samesite"]);

function storeCookies(res: Response): void {
  try {
    const headers = res.headers as unknown as { getSetCookie?: () => string[] };
    let raws: string[] = [];
    if (typeof headers.getSetCookie === "function") {
      raws = headers.getSetCookie.call(res.headers);
    } else {
      const single = res.headers.get("set-cookie");
      if (single) raws = [single];
    }
    for (const raw of raws) {
      // name=value pairs; skip known cookie attributes (and Expires dates,
      // whose commas break naive splitting).
      const pairs = raw.match(/([A-Za-z0-9_-]+)=([^;,]*)/g) ?? [];
      for (const pair of pairs) {
        const eq = pair.indexOf("=");
        const k = pair.slice(0, eq).trim();
        if (!k || COOKIE_ATTRS.has(k.toLowerCase())) continue;
        cookieJar.set(k, pair.slice(eq + 1).trim());
      }
    }
  } catch {
    // best effort only
  }
}

function cookieHeader(): Record<string, string> {
  if (cookieJar.size === 0) return {};
  return { Cookie: [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") };
}

/** Markers of a DDG block/challenge page rather than real results. */
const BLOCK_MARKERS = ["anomaly-modal", "challenge-form", "captcha", "blocked"];

function looksBlocked(status: number, html: string): boolean {
  if (status === 429 || status === 202 || status === 403) return true;
  const head = html.slice(0, 20_000).toLowerCase();
  return BLOCK_MARKERS.some((m) => head.includes(m));
}

/**
 * Pull a real destination URL out of DDG's redirect wrapper
 * (`//duckduckgo.com/l/?uddg=<encoded>`). Returns null for DDG-internal/ad links.
 */
function unwrapDdgHref(href: string): string | null {
  let h = href.trim();
  if (!h) return null;
  if (h.startsWith("//")) h = "https:" + h;
  let url: URL;
  try {
    url = new URL(h, "https://duckduckgo.com");
  } catch {
    return null;
  }
  if (url.hostname === "duckduckgo.com") {
    if (url.pathname === "/l/") {
      const target = url.searchParams.get("uddg");
      if (!target) return null;
      try {
        const decoded = new URL(target);
        if (decoded.protocol !== "http:" && decoded.protocol !== "https:") return null;
        return decoded.toString();
      } catch {
        return null;
      }
    }
    return null; // DDG-internal link (y.js ad click, etc.)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}

function cleanSnippet(text: string | null | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ").slice(0, 400);
}

/**
 * Snippet for a result anchor. Tries the link's own container first
 * (/html/ shape: div.result holds .result__snippet), then walks up to 4
 * following table rows (lite shape: the snippet sits in a sibling
 * <tr><td class="result-snippet"> AFTER the link row). Stops at the next
 * result link so one result never steals the next one's snippet.
 */
function snippetForAnchor(a: Element, container: Element | null): string {
  const direct = container?.querySelector(".result__snippet, td.result-snippet, .result-snippet");
  const dt = cleanSnippet(direct?.textContent);
  if (dt) return dt;
  let tr: Element | null = a.closest("tr");
  for (let i = 0; i < 4 && tr; i++) {
    tr = tr.nextElementSibling;
    if (!tr) break;
    if (tr.querySelector("a.result-link")) break;
    const t = cleanSnippet(tr.querySelector("td.result-snippet")?.textContent);
    if (t) return t;
  }
  return "";
}

function parseResultPage(html: string, maxResults: number): DdgSearchResult[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: DdgSearchResult[] = [];
  const seen = new Set<string>();

  // /html/ endpoint shape…
  const htmlAnchors = Array.from(doc.querySelectorAll("div.result a.result__a"));
  // …lite endpoint shape (result rows + snippet cells)…
  const liteAnchors = Array.from(doc.querySelectorAll("a.result-link"));
  const anchors = [...htmlAnchors, ...liteAnchors];

  for (const a of anchors) {
    if (out.length >= maxResults) break;
    const url = unwrapDdgHref(a.getAttribute("href") ?? "");
    if (!url || seen.has(url)) continue;
    const title = (a.textContent ?? "").trim().replace(/\s+/g, " ");
    if (!title) continue;
    // Snippet: nearest result container's snippet node (/html/ shape), else
    // the lite shape where the snippet lives in a FOLLOWING sibling row.
    const container = a.closest("div.result, tr, td") ?? a.parentElement;
    const snippet = snippetForAnchor(a, container);
    seen.add(url);
    out.push({ title: title.slice(0, 300), url, snippet });
  }

  // Markup-drift fallback — deliberately NARROW. Scraping "any external link
  // with text" was the bug that produced dictionary/footer links (e.g.
  // "ISOLATION Definition & Meaning - Merriam-Webster") as if they were search
  // results whenever DDG served a no-results or soft-block page. Only look
  // inside real result containers, and require an actual snippet. If the
  // markup drifted so far that we can't recognise results, return [] — the
  // caller then fails over to the next endpoint/provider instead of caching
  // and reporting junk as a successful search.
  if (out.length === 0) {
    const containers = Array.from(doc.querySelectorAll("#links, #results, .results, .serp__results, .result, tr"));
    const visited = new Set<Element>();
    for (const container of containers) {
      for (const a of Array.from(container.querySelectorAll("a[href]"))) {
        if (out.length >= maxResults) break;
        if (visited.has(a)) continue;
        visited.add(a);
        const url = unwrapDdgHref(a.getAttribute("href") ?? "");
        if (!url || seen.has(url)) continue;
        const title = (a.textContent ?? "").trim().replace(/\s+/g, " ");
        if (title.length < 10 || title.length > 300) continue;
        const snippet = snippetForAnchor(a, container);
        if (snippet.length < 20) continue;
        seen.add(url);
        out.push({ title, url, snippet });
      }
    }
  }
  return out;
}

async function fetchSearchPage(
  endpoint: DdgEndpoint,
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: number; html: string }> {
  const linked = linkSignals([signal], timeoutMs);
  try {
    const target = endpoint.url(query);
    const headers: Record<string, string> = {
      ...BROWSER_HEADERS,
      ...cookieHeader(),
    };
    const init: RequestInit = { headers, signal: linked.signal, method: endpoint.method };
    if (endpoint.method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = `q=${encodeURIComponent(query)}`;
    }
    const res = await httpFetch(target, init);
    storeCookies(res);
    const html = await res.text().catch(() => "");
    return { status: res.status, html };
  } catch (err) {
    if (linked.signal.aborted && linked.signal.reason instanceof TimeoutError) {
      throw new Error(`DuckDuckGo search timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    linked.cancel();
  }
}

/**
 * DDG's own JSON search API (what the real site's frontend calls): fetch a
 * `vqd` token from a token page, then query links.duckduckgo.com/d.js.
 * Meaningfully different traffic from scraping /html|/lite, so it often
 * works when the scrape endpoints are blocked — and JSON needs no parsing
 * heuristics. Defensive throughout: unknown shapes fall through to the
 * scrape ladder rather than failing.
 */
function extractVqd(html: string): string | null {
  const m = /vqd\s*=\s*['"]([^'"]+)['"]/.exec(html);
  return m ? m[1] : null;
}

function strField(r: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function parseDjsPayload(json: unknown, maxResults: number): DdgSearchResult[] {
  const out: DdgSearchResult[] = [];
  const seen = new Set<string>();
  const root =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? ((json as Record<string, unknown>).results ?? json)
      : json;
  if (!Array.isArray(root)) return out;
  for (const item of root) {
    if (out.length >= maxResults) break;
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const title = strField(r, "title", "t", "heading", "name");
    const rawUrl = strField(r, "url", "u", "href", "firsturl");
    const snippet = strField(r, "snippet", "a", "body", "abstract", "description");
    if (!title || !rawUrl) continue;
    // d.js also carries instant-answer objects (definition cards, "did you
    // mean" entries) with a title+url but no real result snippet. Those were
    // surfaced as bogus results ("ISOLATION Definition & Meaning -
    // Merriam-Webster"). A real web result has substantive snippet text.
    if (snippet.length < 20) continue;
    if (/\bdefinition\s*(?:&|and)\s+meaning\b/i.test(title)) continue;
    const clean = unwrapDdgHref(rawUrl) ?? (/^https?:\/\//i.test(rawUrl) ? rawUrl : null);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({ title: title.slice(0, 300), url: clean, snippet: snippet.slice(0, 400) });
  }
  return out;
}

async function fetchDjsResults(
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxResults: number,
): Promise<DdgSearchResult[]> {
  // 1. Token page (also primes the cookie jar).
  const tokenLinked = linkSignals([signal], Math.min(timeoutMs, 12_000));
  let pageHtml: string;
  try {
    const res = await httpFetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
      headers: { ...BROWSER_HEADERS, ...cookieHeader() },
      signal: tokenLinked.signal,
    });
    storeCookies(res);
    if (!res.ok) {
      if (res.status === 429 || res.status === 202 || res.status === 403) {
        throw new DdgThrottledError(`DuckDuckGo token page blocked (HTTP ${res.status}).`);
      }
      throw new Error(`DuckDuckGo token page HTTP ${res.status}.`);
    }
    pageHtml = await res.text().catch(() => "");
  } finally {
    tokenLinked.cancel();
  }
  const vqd = extractVqd(pageHtml);
  if (!vqd) throw new Error("No vqd token on DDG token page.");

  // 2. The JSON API itself.
  const params = new URLSearchParams({ q: query, vqd, kl: "wt-wt", o: "json", api: "d.js" });
  const apiLinked = linkSignals([signal], timeoutMs);
  try {
    const res = await httpFetch(`https://links.duckduckgo.com/d.js?${params.toString()}`, {
      headers: { ...BROWSER_HEADERS, ...cookieHeader() },
      signal: apiLinked.signal,
    });
    storeCookies(res);
    if (!res.ok) {
      if (res.status === 429 || res.status === 202 || res.status === 403) {
        throw new DdgThrottledError(`DuckDuckGo d.js blocked (HTTP ${res.status}).`);
      }
      throw new Error(`DuckDuckGo d.js HTTP ${res.status}.`);
    }
    const text = await res.text().catch(() => "");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Tolerate a JSONP-style wrapper: callback({...}).
      const m = /^\s*[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(text);
      if (!m) throw new Error("d.js returned non-JSON.");
      json = JSON.parse(m[1]);
    }
    return parseDjsPayload(json, maxResults);
  } finally {
    apiLinked.cancel();
  }
}

/**
 * DDG's official Instant Answers API — different infrastructure from search,
 * rarely blocked, but only covers well-known entities (abstracts + related
 * topics). Last-ditch: better than nothing when every search path 403s.
 */
function parseInstantAnswers(json: unknown, query: string, maxResults: number): DdgSearchResult[] {
  const out: DdgSearchResult[] = [];
  const seen = new Set<string>();
  const rec = (json !== null && typeof json === "object" && !Array.isArray(json))
    ? (json as Record<string, unknown>)
    : null;
  if (!rec) return out;
  const push = (title: string, url: string, snippet: string) => {
    const t = title.trim().replace(/\s+/g, " ");
    const s = snippet.trim().replace(/\s+/g, " ");
    if (!t || !url || seen.has(url) || out.length >= maxResults) return;
    if (!/^https?:\/\//i.test(url)) return;
    // Instant Answers "RelatedTopics" point at duckduckgo.com/<topic> pages —
    // internal navigation, not fetchable sources. Skip them.
    try {
      const host = new URL(url).hostname;
      if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return;
    } catch {
      return;
    }
    seen.add(url);
    out.push({ title: t.slice(0, 300), url, snippet: s.slice(0, 400) });
  };
  const absText = typeof rec.AbstractText === "string" ? rec.AbstractText : "";
  const absUrl = typeof rec.AbstractURL === "string" ? rec.AbstractURL : "";
  const absSource = typeof rec.AbstractSource === "string" && rec.AbstractSource ? rec.AbstractSource : query;
  if (absText && absUrl) push(absSource, absUrl, absText);
  const flatten = (topics: unknown): void => {
    if (!Array.isArray(topics)) return;
    for (const item of topics) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const r = item as Record<string, unknown>;
      if (Array.isArray(r.Topics)) {
        flatten(r.Topics);
        continue;
      }
      if (typeof r.FirstURL === "string" && typeof r.Text === "string") {
        push(r.Text.split(/(?:\s+[–—-]\s+|\.\s+)/)[0] || r.Text, r.FirstURL, r.Text);
      }
    }
  };
  flatten(rec.RelatedTopics);
  return out;
}

async function fetchInstantAnswers(
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxResults: number,
): Promise<DdgSearchResult[]> {
  const params = new URLSearchParams({ q: query, format: "json", no_html: "1", skip_disambig: "1" });
  const linked = linkSignals([signal], Math.min(timeoutMs, 10_000));
  try {
    const res = await httpFetch(`https://api.duckduckgo.com/?${params.toString()}`, {
      headers: { ...BROWSER_HEADERS, ...cookieHeader() },
      signal: linked.signal,
    });
    storeCookies(res);
    if (!res.ok) throw new Error(`Instant Answers HTTP ${res.status}`);
    const json: unknown = await res.json().catch(() => null);
    return parseInstantAnswers(json, query, maxResults);
  } finally {
    linked.cancel();
  }
}

/**
 * Search DDG directly. Returns results (possibly []) — empty means "no
 * coverage", NOT throttling. Throws DdgThrottledError when DDG is blocking
 * us (caller fails over to crw), or Error on network/timeout failure.
 */
export async function ddgSearch(
  query: string,
  opts?: { signal?: AbortSignal; maxResults?: number },
): Promise<DdgSearchResult[]> {
  const q = trimQuery(normalizeQuery(query));
  if (!q) return [];
  const maxResults = opts?.maxResults ?? ddgConfig.maxResults;
  const signal = opts?.signal;

  const cached = resultCache.get(q);
  if (cached && Date.now() - cached.at < ddgConfig.cacheTtlMs) {
    return cached.results.slice(0, maxResults);
  }
  const ongoing = inflight.get(q);
  if (ongoing) return ongoing.then((r) => r.slice(0, maxResults));

  const run = (async (): Promise<DdgSearchResult[]> => {
    if (inCooldown()) {
      throw new DdgThrottledError();
    }
    await acquirePaceSlot(signal);

    let lastError: unknown = null;
    // Distinguish "engines answered but had nothing" (no coverage, NOT a
    // failure) from "engines errored" so a genuinely obscure query doesn't
    // add DDG failure pressure / engage the cooldown.
    let sawCleanEmpty = false;

    // 1. DDG's own JSON API (vqd + d.js) — different traffic shape from
    // scraping, often unblocked when /html|/lite are not.
    if (!signal?.aborted) {
      try {
        const hits = await fetchDjsResults(q, signal, ddgConfig.searchTimeoutMs, maxResults);
        if (hits.length > 0) {
          resultCache.set(q, { at: Date.now(), results: hits });
          reportDdgSuccess();
          lastWorkingEndpoint = "d.js";
          return hits;
        }
        lastError = new Error("d.js returned no parseable results.");
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
      }
    }

    // 2-4. Scrape ladder: lite (POST) → html → duckduckgo.com/html.
    for (const endpoint of DDG_ENDPOINTS) {
      if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
      try {
        const { status, html } = await fetchSearchPage(
          endpoint,
          q,
          signal,
          Math.min(ddgConfig.searchTimeoutMs, DDG_ENDPOINT_CAP_MS),
        );
        if (looksBlocked(status, html)) {
          lastError = new DdgThrottledError(`DuckDuckGo blocked the request (HTTP ${status}).`);
          continue; // try the next endpoint before giving up
        }
        if (status < 200 || status >= 300) {
          lastError = new Error(`DuckDuckGo search failed with HTTP ${status}.`);
          continue;
        }
        const results = parseResultPage(html, maxResults);
        if (results.length === 0) {
          // A 200 with no real results is a soft block / "did you mean" page,
          // NOT success. Keep trying endpoints, then let the caller fail over.
          sawCleanEmpty = true;
          lastError = new Error(`DuckDuckGo ${endpoint.name} returned no parseable results.`);
          continue;
        }
        resultCache.set(q, { at: Date.now(), results });
        reportDdgSuccess();
        lastWorkingEndpoint = endpoint.name;
        return results;
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
        // Network/timeout on one endpoint: try the next before failing.
      }
    }

    // 5. Official Instant Answers API — narrow coverage (entities only)
    // but rarely blocked; worth one cheap call before giving up.
    if (!signal?.aborted) {
      try {
        const hits = await fetchInstantAnswers(q, signal, ddgConfig.searchTimeoutMs, maxResults);
        if (hits.length > 0) {
          resultCache.set(q, { at: Date.now(), results: hits });
          reportDdgSuccess();
          lastWorkingEndpoint = "instant";
          return hits;
        }
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
      }
    }

    // Every endpoint failed. A clean "no coverage" (all answered, nothing
    // parseable) is expected for obscure queries — don't inflate failure
    // pressure or engage the cooldown for it. Only real errors do that.
    if (!sawCleanEmpty) reportDdgError();
    if (inCooldown()) {
      throw lastError instanceof DdgThrottledError
        ? lastError
        : new DdgThrottledError(
            `DuckDuckGo keeps failing (${lastError instanceof Error ? lastError.message : String(lastError)}) — cooling down briefly.`,
          );
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  })();

  inflight.set(q, run);
  try {
    return await run;
  } finally {
    inflight.delete(q);
  }
}

// --- fetch ---
// Page fetching lives in scraper.ts (robots, per-host limits, byte caps,
// retries, cache). This thin wrapper keeps the historical name working for
// callers that predate the built-in scraper.

export async function ddgFetchPage(
  url: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  return fetchPage(url, {
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs ?? ddgConfig.fetchTimeoutMs,
  });
}

/** Drop results we could never fetch — non-http(s), embedded credentials, or
 * private/loopback hosts when the scraper policy disallows them. Search engines
 * occasionally surface internal/odd URLs; handing those to the model wastes a
 * turn on a fetch that our own guard would refuse anyway. */
function isFetchableResultUrl(url: string): boolean {
  try {
    parseScrapeUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dictionary/definition reference pages ("X Definition & Meaning -
 * Merriam-Webster", Wiktionary, dictionary.com...) are not research sources.
 * Search engines return them for the first word of a multi-word query, and
 * agents then treat the definition as an answer. This is the LAST line of
 * defense: every provider's results funnel through renderSearchResults, so a
 * junk result from Bing/crw/SearXNG is caught even when that provider's own
 * parser accepted it. Direct `web_search({url})` fetches are unaffected —
 * this only filters *search* results.
 */
function isReferencePage(r: DdgSearchResult): boolean {
  const title = r.title.toLowerCase();
  // Dictionary/definition cards are reference lookups, not research sources.
  // Match generically (title OR URL path) so Cambridge, vocabulary.com,
  // definitions.net etc. are caught too, not just a fixed host list.
  if (/\bdefinition\b|\bmeaning\b|\bsynonyms\b|\bthesaurus\b|\bwhat does\b/i.test(title)) return true;
  let path = "";
  let host = "";
  try {
    const u = new URL(r.url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/\/(dictionary|define|definition|meaning|thesaurus|synonyms)\//.test(path)) return true;
  return (
    host.endsWith(".wiktionary.org") ||
    host === "dictionary.com" || host.endsWith(".dictionary.com") ||
    host === "thesaurus.com" || host.endsWith(".thesaurus.com") ||
    host === "merriam-webster.com" || host.endsWith(".merriam-webster.com")
  );
}

/**
 * Render results in the Title/URL/Snippet block format the prompts expect.
 * `note` prefixes a provenance warning (e.g. Wikipedia-only fallback), and a
 * trailing reminder pushes the agent to fetch full pages rather than writing
 * a report from snippets — the same discipline Unsloth bakes into its tool
 * output. Both are shared by every provider (DDG, built-in pool, SearXNG,
 * cloud) since they all funnel through this renderer.
 */
export function renderSearchResults(results: DdgSearchResult[], note?: string, limit?: number): string {
  const usable = results.filter((r) => isFetchableResultUrl(r.url) && !isReferencePage(r));
  if (usable.length === 0) return ""; // let the caller treat it as no coverage
  const capped = typeof limit === "number" ? usable.slice(0, Math.max(1, limit)) : usable;
  const body = capped
    .map((r) => `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet || "(no snippet)"}`)
    .join("\n\n---\n\n");
  const parts: string[] = [];
  if (note?.trim()) parts.push(note.trim());
  parts.push(body);
  parts.push(
    "IMPORTANT: these are only short snippets. To read a full page before drawing " +
      'conclusions, call web_search with {"url": "<URL>"}. A snippet is an address, not a finding.',
  );
  return parts.join("\n\n---\n\n");
}
