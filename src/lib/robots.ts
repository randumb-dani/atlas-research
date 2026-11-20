/**
 * robots.txt fetching, parsing, and evaluation for the built-in scraper.
 *
 * Policy (user-selectable in Settings, respects-by-default):
 *   - 2xx            → parse rules, honour Disallow/Allow + Crawl-delay.
 *   - 401/403        → treat as "everything disallowed".
 *   - other 4xx      → allow all (standard interpretation: no policy).
 *   - network/5xx    → allow all, but remember the failure so the UI can say
 *                      the check was inconclusive rather than silently sure.
 *
 * Rules are cached per origin for an hour. The research loop can fetch the
 * same origin from many subagents in one turn; refetching robots.txt per
 * page would itself be rude (and slow).
 *
 * Matching uses longest-match-wins with Allow winning ties, `*` wildcards and
 * `$` end anchors — the de-facto REP behaviour.
 */

import { httpFetch } from "./http";
import { linkSignals } from "./fetch-timeout";

/** Identifying token used when matching robots.txt user-agent groups. */
export const ROBOTS_USER_AGENT =
  "AtlasResearchBot/0.1 (+local deep-research app; respects robots.txt)";

const ROBOTS_TTL_MS = 60 * 60_000;
const ROBOTS_TIMEOUT_MS = 8_000;

type RobotsStatus = "ok" | "allow-all" | "disallow-all";

interface RobotsRule {
  allow: boolean;
  pattern: string;
  /** Length of the meaningful pattern, for longest-match comparisons. */
  weight: number;
  regex: RegExp;
}

export interface RobotsPolicy {
  fetchedAt: number;
  status: RobotsStatus;
  rules: RobotsRule[];
  crawlDelayMs: number;
  sitemaps: string[];
  /** Present when the fetch was inconclusive (network/5xx). */
  error?: string;
}

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs: number;
  reason: string;
  status: RobotsStatus | "skipped";
}

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; pattern: string }[];
  crawlDelayMs: number;
}

const cache = new Map<string, RobotsPolicy>();

/** In-flight fetches, so parallel subagents hitting the same origin in one
 * turn share a single robots.txt request instead of stampeding it. */
const inflight = new Map<string, Promise<RobotsPolicy>>();

export function clearRobotsCache(): void {
  cache.clear();
  inflight.clear();
}

function compileRule(allow: boolean, pattern: string): RobotsRule {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return {
    allow,
    pattern,
    weight: body.replace(/\*/g, "").length,
    regex: new RegExp(`^${escaped}${anchored ? "$" : ""}`),
  };
}

/** Parse robots.txt into groups. Exported for the Test button/diagnostics. */
export function parseRobotsTxt(text: string): RobotsPolicy {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      lastLineWasAgent = false;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      lastLineWasAgent = false;
      continue;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      // A user-agent line starts a new group unless it directly follows
      // another user-agent line (same group, multiple agents).
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [], crawlDelayMs: 0 };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (!current) continue;

    if (field === "allow" || field === "disallow") {
      // An empty Disallow means "allow everything" and is not a rule.
      if (field === "disallow" && value === "") continue;
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        current.crawlDelayMs = Math.min(60_000, Math.round(seconds * 1000));
      }
    } else if (field === "sitemap") {
      if (value) sitemaps.push(value);
    }
  }

  return selectPolicy(groups, sitemaps);
}

function agentMatches(agent: string, token: string): boolean {
  if (!agent) return false;
  // Exact product-token match (case-insensitive), tolerating a version
  // suffix in the robots file ("AtlasResearchBot/0.1" → "atlasresearchbot").
  // Loose substring/prefix matching selected wrong groups: a "bot" or
  // "google" group hijacked our rules because "atlasresearchbot" merely
  // contained "bot". REP matches the UA product token itself, not arbitrary
  // substrings of it.
  return agent.split(/[/\s]/)[0] === token;
}

function selectPolicy(groups: RobotsGroup[], sitemaps: string[]): RobotsPolicy {
  const token = "atlasresearchbot";
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && agentMatches(a, token)),
  );
  const selected =
    specific.length > 0
      ? specific
      : groups.filter((g) => g.agents.some((a) => a === "*"));

  const rules: RobotsRule[] = [];
  let crawlDelayMs = 0;
  for (const group of selected) {
    for (const rule of group.rules) {
      rules.push(compileRule(rule.allow, rule.pattern));
    }
    crawlDelayMs = Math.max(crawlDelayMs, group.crawlDelayMs);
  }

  // Deterministic: longest pattern first, allow wins ties.
  rules.sort((a, b) => b.weight - a.weight || Number(b.allow) - Number(a.allow));

  return {
    fetchedAt: Date.now(),
    status: "ok",
    rules,
    crawlDelayMs,
    sitemaps,
  };
}

function allowAll(error?: string): RobotsPolicy {
  return {
    fetchedAt: Date.now(),
    status: "allow-all",
    rules: [],
    crawlDelayMs: 0,
    sitemaps: [],
    error,
  };
}

function disallowAll(): RobotsPolicy {
  return {
    fetchedAt: Date.now(),
    status: "disallow-all",
    rules: [],
    crawlDelayMs: 0,
    sitemaps: [],
  };
}

/** Fetch + parse robots.txt for an origin, cached for an hour. */
export async function robotsFor(origin: string, signal?: AbortSignal): Promise<RobotsPolicy> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;

  // Concurrent checks for the same origin join one in-flight fetch rather
  // than each issuing its own robots.txt request (tool calls dispatch in
  // parallel, and stampeding robots.txt is both rude and slow).
  let pending = inflight.get(origin);
  if (!pending) {
    pending = fetchRobots(origin).finally(() => inflight.delete(origin));
    inflight.set(origin, pending);
  }
  if (!signal) return await pending;

  // The shared fetch keeps running for other callers, but THIS caller must
  // still unwind promptly when its own signal aborts.
  const linked = linkSignals([signal]);
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        linked.signal.addEventListener("abort", () => {
          reject(linked.signal.reason instanceof Error ? linked.signal.reason : new Error("Aborted"));
        });
      }),
    ]);
  } finally {
    linked.cancel();
  }
}

async function fetchRobots(origin: string): Promise<RobotsPolicy> {
  const linked = linkSignals([], ROBOTS_TIMEOUT_MS);
  try {
    const res = await httpFetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": ROBOTS_USER_AGENT, Accept: "text/plain,*/*;q=0.8" },
      signal: linked.signal,
      redirect: "follow",
    });
    let policy: RobotsPolicy;
    if (res.status === 401 || res.status === 403) {
      policy = disallowAll();
    } else if (!res.ok) {
      policy = allowAll(res.status >= 500 ? `robots.txt HTTP ${res.status}` : undefined);
    } else {
      const text = await res.text().catch(() => "");
      // An HTML page where robots.txt should be is not a robots file.
      policy = /^\s*</.test(text) ? allowAll("robots.txt served HTML") : parseRobotsTxt(text);
    }
    cache.set(origin, policy);
    return policy;
  } catch (err) {
    // Inconclusive (timeout/5xx/network): allow all but record why. Don't
    // pin this for the full hour — a transient blip shouldn't make every
    // later check silently "inconclusive"; cache it briefly instead.
    const policy = allowAll(err instanceof Error ? err.message : String(err));
    policy.fetchedAt = Date.now() - ROBOTS_TTL_MS + 30_000;
    cache.set(origin, policy);
    return policy;
  } finally {
    linked.cancel();
  }
}

/** Evaluate a URL against its origin's robots policy. */
export async function checkRobots(url: URL, signal?: AbortSignal): Promise<RobotsDecision> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: true, crawlDelayMs: 0, reason: "non-HTTP scheme", status: "skipped" };
  }
  const policy = await robotsFor(url.origin, signal);
  if (policy.status === "allow-all") {
    return {
      allowed: true,
      crawlDelayMs: 0,
      reason: policy.error ? `robots inconclusive (${policy.error})` : "no robots policy",
      status: policy.status,
    };
  }
  if (policy.status === "disallow-all") {
    return {
      allowed: false,
      crawlDelayMs: 0,
      reason: "robots.txt forbids automated access (HTTP 401/403)",
      status: policy.status,
    };
  }

  const path = url.pathname + (url.search || "");
  const match = policy.rules.find((rule) => rule.regex.test(path));
  return {
    allowed: !match || match.allow,
    crawlDelayMs: policy.crawlDelayMs,
    reason: match
      ? `${match.allow ? "Allow" : "Disallow"} ${match.pattern}`
      : "no matching rule",
    status: policy.status,
  };
}
