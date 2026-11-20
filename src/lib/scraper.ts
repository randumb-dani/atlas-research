/**
 * Built-in web scraper: fetch a page, check the rules, extract the reading
 * content as Markdown-ish text.
 *
 * This is the app's own scraper — no crw/SearXNG/fastcrw required. It layers
 * the network policy the old `ddgFetchPage` lacked:
 *
 *   1. URL validation + private/LAN host guard (the model supplies URLs, so
 *      this is an SSRF boundary; opt-out exists in Settings for intranet use).
 *   2. robots.txt (Allow/Disallow + Crawl-delay), cached per origin, with a
 *      visible Settings toggle so research users can opt out deliberately.
 *   3. Per-host token bucket: spacing + concurrency + sliding window, shared
 *      by every subagent, because tool calls dispatch concurrently.
 *   4. Retry budget for transient failures (429/5xx/network) honouring
 *      Retry-After, plus adaptive backoff from the shared limiter.
 *   5. Byte cap while streaming (Content-Length can lie), so a huge file
 *      can't exhaust memory or the model's context.
 *   6. Content-type allowlist: HTML → readable text, text/JSON/XML → verbatim,
 *      binaries → a clear error instead of mojibake.
 *   7. A short page cache — parallel subagents frequently fetch the same URL.
 *
 * JS-rendered pages still throw `JsWalledError` so the caller can fail over
 * to crw/fastcrw, which have real renderers.
 */

import { httpFetch } from "./http";
import { linkSignals, sleepJittered, TimeoutError } from "./fetch-timeout";
import { getLimiter, type RateLimitStats } from "./rate-limit";
import { checkRobots } from "./robots";

export type ScrapeErrorKind =
  | "invalid-url"
  | "private-host"
  | "robots"
  | "blocked"
  | "http"
  | "too-large"
  | "unsupported"
  | "js-walled"
  | "empty"
  | "timeout"
  | "network";

export class ScrapeError extends Error {
  readonly kind: ScrapeErrorKind;
  readonly status?: number;
  constructor(kind: ScrapeErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ScrapeError";
    this.kind = kind;
    this.status = status;
  }
}

/** Thrown when a page looks JS-rendered (our static fetch can't read it). */
export class JsWalledError extends ScrapeError {
  constructor(url: string) {
    super("js-walled", `Page needs JavaScript rendering, static fetch got almost no text: ${url}`);
    this.name = "JsWalledError";
  }
}

export interface ScrapeConfig {
  /** Honour robots.txt Disallow + Crawl-delay. Default true. */
  respectRobots: boolean;
  /** Minimum ms between fetches to the same host. Default 1500. */
  minHostIntervalMs: number;
  /** Max concurrent fetches per host (across subagents). Default 2. */
  maxConcurrentPerHost: number;
  /** Max fetches per host per minute. Default 60. */
  maxPerHostPerMinute: number;
  /** Per-attempt network timeout. Default 30_000. */
  fetchTimeoutMs: number;
  /** Max response bytes read before truncating/erroring. Default 2 MB. */
  maxBytes: number;
  /** Allow loopback/RFC1918/.local targets. Default false (SSRF guard). */
  allowPrivateHosts: boolean;
  /** Retries for transient failures (429/5xx/network). Default 2. */
  maxRetries: number;
}

const DEFAULT_SCRAPE_CONFIG: ScrapeConfig = {
  respectRobots: true,
  minHostIntervalMs: 1500,
  maxConcurrentPerHost: 2,
  maxPerHostPerMinute: 60,
  fetchTimeoutMs: 30_000,
  maxBytes: 2_000_000,
  allowPrivateHosts: false,
  maxRetries: 2,
};

let scrapeConfig: ScrapeConfig = { ...DEFAULT_SCRAPE_CONFIG };

const scrapeLimiter = getLimiter("scrape", {
  minIntervalMs: DEFAULT_SCRAPE_CONFIG.minHostIntervalMs,
  maxConcurrent: DEFAULT_SCRAPE_CONFIG.maxConcurrentPerHost,
  maxPerWindow: DEFAULT_SCRAPE_CONFIG.maxPerHostPerMinute,
  windowMs: 60_000,
  failurePenaltyMs: 1_000,
  maxPenaltyMs: 15_000,
  cooldownAfter: 4,
  cooldownMs: 15_000,
});

/** Runtime override (wired to Settings via syncSearchRuntime). */
export function configureScraper(patch: Partial<ScrapeConfig>): void {
  scrapeConfig = { ...scrapeConfig, ...patch };
  scrapeLimiter.configure({
    minIntervalMs: scrapeConfig.minHostIntervalMs,
    maxConcurrent: scrapeConfig.maxConcurrentPerHost,
    maxPerWindow: scrapeConfig.maxPerHostPerMinute,
    windowMs: 60_000,
  });
}

export function getScrapeConfig(): ScrapeConfig {
  return { ...scrapeConfig };
}

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Browser-grade headers that survive a real fetch. Bot detection 403s bare
 * HTTP clients, so we match a Chromium navigation. Deliberately NOT setting:
 * - Accept-Encoding/Connection/Host: the fetch layer owns these, hand-setting breaks decoding.
 * - DNT / Referer: forbidden headers the fetch spec strips. Tauri's plugin-http
 *   warns on every request for these; they never reach the server, so they're
 *   pointless. Set Referer only where a provider genuinely needs it and the
 *   transport can send it.
 */
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
};

export const MAX_FETCH_CHARS = 12_000;

// --- URL policy ---------------------------------------------------------

/**
 * Parse one numeric label of an IPv4 host, honoring the forms a real
 * resolver accepts: decimal ("127"), hex ("0x7f"), octal with leading zero
 * ("0177"). A leading-zero label containing 8/9 is invalid.
 */
function parseIpv4Part(part: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^[0-7]+$/.test(part) && part.length > 1 && part.startsWith("0")) return Number.parseInt(part, 8);
  if (/^\d+$/.test(part)) {
    if (part.length > 1 && part.startsWith("0")) return null; // invalid octal ("08")
    return Number.parseInt(part, 10);
  }
  return null;
}

/**
 * Normalize any numeric IPv4 spelling — dotted quad, abbreviated ("127.1"),
 * or a single decimal/hex/octal integer ("2130706433", "0x7f000001") — into
 * a 32-bit value, following the classful rules a resolver uses (the last
 * label absorbs all remaining bits). Returns null for non-IPv4 hosts.
 * Without this, decimal/hex encodings of loopback/private addresses slip
 * past the guard in isPrivateIpv4 (a classic SSRF bypass).
 */
function parseIpv4Number(host: string): number | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4 || parts.some((p) => p.length === 0)) return null;
  let value = 0;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const bits = isLast ? 32 - 8 * i : 8;
    if (bits <= 0) return null;
    const max = 2 ** bits - 1;
    const n = parseIpv4Part(parts[i]);
    if (n === null || n > max) return null;
    value += n * 2 ** bits;
  }
  return value;
}

function isPrivateIpv4(host: string): boolean {
  const num = parseIpv4Number(host);
  if (num === null) return false;
  const a = (num >>> 24) & 255;
  const b = (num >>> 16) & 255;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "localhost.localdomain" || host === "0.0.0.0") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isPrivateIpv4(host)) return true;
  // IPv6 loopback / unique-local / link-local.
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (host.startsWith("::ffff:")) return isPrivateIpv4(host.slice(7));
  return false;
}

export function parseScrapeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ScrapeError("invalid-url", `Not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ScrapeError("invalid-url", `Only http(s) URLs can be fetched, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ScrapeError("invalid-url", "URLs with embedded credentials are not fetched");
  }
  if (!scrapeConfig.allowPrivateHosts && isPrivateHostname(url.hostname)) {
    throw new ScrapeError(
      "private-host",
      `Refusing to fetch a private/loopback host (${url.hostname}). ` +
        `Enable "Allow LAN/private hosts" in Settings if this is intentional.`,
    );
  }
  return url;
}

// --- page cache ---------------------------------------------------------

const PAGE_CACHE_TTL_MS = 10 * 60_000;
const PAGE_CACHE_MAX = 80;
const pageCache = new Map<string, { at: number; text: string }>();

export function clearScrapeCache(): void {
  pageCache.clear();
}

export function resetScrapeState(): void {
  pageCache.clear();
  scrapeLimiter.reset();
  fetchCount = 0;
  failureCount = 0;
  robotsBlocked = 0;
}

let fetchCount = 0;
let failureCount = 0;
let robotsBlocked = 0;

export interface ScrapeStats {
  limiter: RateLimitStats;
  cacheEntries: number;
  fetches: number;
  failures: number;
  robotsBlocked: number;
}

export function getScrapeStats(): ScrapeStats {
  return {
    limiter: scrapeLimiter.stats(),
    cacheEntries: pageCache.size,
    fetches: fetchCount,
    failures: failureCount,
    robotsBlocked,
  };
}

function cacheGet(key: string): string | null {
  const hit = pageCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PAGE_CACHE_TTL_MS) {
    pageCache.delete(key);
    return null;
  }
  return hit.text;
}

function cacheSet(key: string, text: string): void {
  if (pageCache.size >= PAGE_CACHE_MAX) {
    const oldest = [...pageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) pageCache.delete(oldest[0]);
  }
  pageCache.set(key, { at: Date.now(), text });
}

// --- response reading ---------------------------------------------------

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return m ? m[1] : "utf-8";
}

function decodeBytes(bytes: Uint8Array, contentType: string): string {
  let label = charsetOf(contentType);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    label = "utf-8";
    return new TextDecoder(label).decode(bytes);
  }
}

/**
 * Read a response body with a hard byte cap, streaming so a lying
 * Content-Length can't exhaust memory. Exported for reuse by the engine
 * fetches in search-engines.ts.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ScrapeError("too-large", `Response is ${Math.round(declared / 1024)} KB (limit ${Math.round(maxBytes / 1024)} KB)`);
  }
  if (!res.body) {
    // String slice ≠ byte cap: encode first, then cut on BYTES so a
    // multibyte body can't slip past maxBytes.
    const bytes = new TextEncoder().encode(await res.text());
    return bytes.byteLength > maxBytes ? bytes.slice(0, maxBytes) : bytes;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.slice(0, Math.max(0, maxBytes - total)));
        total = maxBytes;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isBinaryContentType(contentType: string): boolean {
  if (!contentType) return false;
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/") ||
    contentType.includes("application/pdf") ||
    contentType.includes("application/zip") ||
    contentType.includes("application/gzip") ||
    contentType.includes("application/octet-stream") ||
    contentType.includes("application/x-tar")
  );
}

/** Lines that are pure page furniture, not content. Only dropped when a line
 * is COMPOSED of them — real prose merely quoting a fragment is kept. */
const FURNITURE_PATTERNS = [
  /^(skip to (content|main content|navigation|search))$/i,
  /^(sign in|log in|sign up|register|subscribe|menu|search|close)$/i,
  /^cookie/i,
  /^(accept|reject|manage|allow) (all )?(cookies|consent)/i,
  /^all rights reserved/i,
  /^(privacy|terms|contact|about|sitemap|help|faq|advertise)[\s|·,-]*$/i,
  /^(home|news|videos?|images?|maps?|shopping|more|settings|tools)$/i,
  /^(previous|next)( (page|article|post))?$/i,
  /^(share|tweet|pin it|follow us|newsletter)$/i,
  /^(loading|please wait|please reload|reload this page)[\s.…!]*$/i,
];

export function extractMainText(doc: Document): string {
  // Drop everything that can never be content.
  const drop = doc.querySelectorAll(
    "script, style, noscript, nav, footer, header, aside, form, iframe, dialog, [hidden], [aria-hidden='true']",
  );
  drop.forEach((el) => el.remove());

  // Scope: largest single article/main, else the body. Sibling
  // related-post/comment sections must not leak in.
  const candidates = Array.from(doc.querySelectorAll("article, main"));
  let scope: Element | null = null;
  let best = 0;
  for (const c of candidates) {
    const len = (c.textContent ?? "").length;
    if (len > best && len > 200) {
      best = len;
      scope = c;
    }
  }
  scope ??= doc.body;
  if (!scope) return "";

  // Walk block-level nodes so structure survives as line breaks.
  const blocks = scope.querySelectorAll(
    "h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td, th, figcaption",
  );
  const nodes = blocks.length > 3 ? Array.from(blocks) : [scope];
  const lines: string[] = [];
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    // Don't double-count nested blocks: only leaf-most block text.
    if (node !== scope && node.querySelector("p, li, pre, h1, h2, h3, h4")) continue;
    const text = (node.textContent ?? "").replace(/[ \t\u00a0]+/g, " ").trim();
    if (!text) continue;
    if (tag === "pre") {
      lines.push(`\`\`\`\n${text.slice(0, 2000)}\n\`\`\``);
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = "#".repeat(Number(tag[1]));
      lines.push(`${level} ${text}`);
      continue;
    }
    if (tag === "li") {
      lines.push(`- ${text}`);
      continue;
    }
    // Furniture filter: drop lines composed of furniture, keep real prose.
    const isFurniture =
      text.length < 120 &&
      FURNITURE_PATTERNS.some((re) => re.test(text)) &&
      text.split(/\s+/).length <= 8;
    if (isFurniture) continue;
    lines.push(text);
  }
  return lines
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Render an HTTP body as the text the model should see. */
function bodyToText(body: Uint8Array, contentType: string, url: string): string {
  const text = decodeBytes(body, contentType).replace(/^\uFEFF/, "");
  if (!text.trim()) throw new ScrapeError("empty", `Fetch returned an empty body for ${url}`);

  const lowerType = contentType.toLowerCase();
  // "html" only — application/xhtml+xml still matches; plain XML (RSS/Atom,
  // sitemaps, APIs) must NOT go through the HTML extractor, which would
  // mangle structured data into a text jumble. Serve it verbatim instead.
  const isHtml =
    lowerType.includes("html") ||
    (!lowerType && /<\s*(html|body|article|main|div|p)[\s>]/i.test(text.slice(0, 2000)));
  if (!isHtml) {
    // Plain text / markdown / json: serve verbatim (whitespace preserved).
    return text.slice(0, MAX_FETCH_CHARS);
  }

  const doc = new DOMParser().parseFromString(text, "text/html");
  const extracted = extractMainText(doc);
  if (extracted.length < 300) {
    // Static fetch got almost nothing out of a large HTML shell — almost
    // certainly a JS-rendered app. Don't burn context on chrome; fail over.
    const scriptCount = doc.querySelectorAll("script").length;
    if (text.length > 30_000 || scriptCount >= 8) {
      throw new JsWalledError(url);
    }
    if (!extracted) throw new ScrapeError("empty", `No readable content extracted from ${url}`);
  }
  return extracted.slice(0, MAX_FETCH_CHARS);
}

function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(15_000, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(15_000, Math.max(0, date - Date.now()));
  return 0;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

// --- fetch --------------------------------------------------------------

export interface FetchPageOptions {
  signal?: AbortSignal;
  /** Per-attempt timeout override (ms). */
  timeoutMs?: number;
  /** Skip the robots check for this call (Settings test / explicit override). */
  ignoreRobots?: boolean;
  /** Skip the in-memory page cache. */
  fresh?: boolean;
}

/**
 * Fetch one page and return readable text. Throws ScrapeError for policy
 * failures (robots/private/unsupported), TimeoutError-free is guaranteed:
 * timeouts are normalized to ScrapeError kind "timeout".
 */
export async function fetchPage(rawUrl: string, opts: FetchPageOptions = {}): Promise<string> {
  const url = parseScrapeUrl(rawUrl);
  const signal = opts.signal;
  // Fragment never reaches the server; keying on it would split one page
  // into many cache entries. Key on the hash-less URL.
  const cacheKey = `${url.origin}${url.pathname}${url.search}`;
  if (!opts.fresh) {
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
  }

  const policy = opts.ignoreRobots ? null : scrapeConfig.respectRobots
    ? await checkRobots(url, signal)
    : null;

  if (policy && !policy.allowed) {
    robotsBlocked++;
    throw new ScrapeError("robots", `robots.txt disallows this URL for automated clients (${policy.reason}): ${url}`);
  }

  const host = url.hostname.toLowerCase();
  const crawlDelayMs = policy?.crawlDelayMs ?? 0;
  const timeoutMs = opts.timeoutMs ?? scrapeConfig.fetchTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  const attempts = Math.max(0, scrapeConfig.maxRetries) + 1;
  let lastError: unknown = null;
  let deadlineHit = false;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      deadlineHit = true;
      break;
    }

    const release = await scrapeLimiter.acquire(host, signal, crawlDelayMs);
    const linked = linkSignals([signal], remaining);
    fetchCount++;
    try {
      const res = await httpFetch(url.toString(), {
        headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml,text/*;q=0.9" },
        signal: linked.signal,
        redirect: "follow",
      });

      if (!res.ok) {
        if (isRetryableStatus(res.status)) {
          lastError = new ScrapeError("blocked", `HTTP ${res.status} from ${host}`, res.status);
          if (attempt < attempts - 1) {
            // Penalize once per retry; the final attempt's penalty happens
            // in the catch below — reporting here too would double-count it.
            scrapeLimiter.reportFailure(host);
            const wait = retryAfterMs(res);
            await sleepJittered(wait || 900 * (attempt + 1), signal);
            continue;
          }
          throw lastError;
        }
        scrapeLimiter.reportSuccess(host);
        throw new ScrapeError("http", `Fetch failed with HTTP ${res.status} for ${url}`, res.status);
      }

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (isBinaryContentType(contentType)) {
        scrapeLimiter.reportSuccess(host);
        throw new ScrapeError(
          "unsupported",
          `Unsupported content type "${contentType.split(";")[0]}" for ${url} — fetch an HTML/text page instead.`,
        );
      }

      const body = await readCapped(res, scrapeConfig.maxBytes);
      const text = bodyToText(body, contentType, url.toString());
      scrapeLimiter.reportSuccess(host);
      cacheSet(cacheKey, text);
      return text;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof ScrapeError && !["blocked", "http", "timeout", "network"].includes(err.kind)) {
        // Policy/format decisions are final — retrying won't change them.
        throw err;
      }
      // Authoritative client errors (404/410/401…) are a successful network
      // interaction: don't penalize the host or burn retries on them.
      if (err instanceof ScrapeError && err.kind === "http" && (err.status ?? 0) >= 400 && (err.status ?? 0) < 500) {
        throw err;
      }
      if (linked.signal.aborted && linked.signal.reason instanceof TimeoutError) {
        lastError = new ScrapeError("timeout", `Fetch timed out after ${timeoutMs}ms: ${url}`);
      } else {
        lastError = err;
      }
      failureCount++;
      // Timeouts/network errors are transient; authoritative 4xx are final.
      // Classify by the structured status, not by regexing the error message
      // (a network error whose text happens to contain "HTTP 4xx" must not
      // be misread as an authoritative client error, and vice versa).
      const status = err instanceof ScrapeError ? err.status : undefined;
      const isFinalClientError =
        status !== undefined && status >= 400 && status < 500 && !isRetryableStatus(status);
      scrapeLimiter.reportFailure(host);
      if (attempt < attempts - 1 && !isFinalClientError) {
        await sleepJittered(700 * (attempt + 1), signal);
        continue;
      }
      break;
    } finally {
      linked.cancel();
      release();
    }
  }

  // Deadline exhausted: say so explicitly. A stale per-attempt error would
  // otherwise misreport *why* the fetch stopped (e.g. "HTTP 503" from the
  // first attempt when the real cause was the overall budget running out).
  if (deadlineHit) {
    throw new ScrapeError(
      "timeout",
      `Fetch timed out after ${timeoutMs}ms (including retries): ${url}`,
    );
  }
  if (lastError instanceof ScrapeError) throw lastError;
  if (lastError instanceof Error) throw lastError;
  throw new ScrapeError("network", `Fetch failed for ${url}`);
}

/** Back-compat alias: searxng.ts/web-search-source used ddgFetchPage. */
export async function ddgFetchPage(
  url: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  return fetchPage(url, opts);
}
