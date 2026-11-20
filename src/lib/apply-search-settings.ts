/**
 * Bridges persisted search tuning (zustand store) into the runtime modules
 * that actually enforce it (web-search-source, search-engines, ddg-search,
 * searxng, scraper, tool-types).
 *
 * Call after any search-setting change and once at session start — the
 * runtime modules intentionally don't import the store (import direction:
 * components → this module → runtimes).
 */
import { useSessionStore } from "./store";
import { setSearchProviderOrder } from "./web-search-source";
import { configureDdg } from "./ddg-search";
import { configureSearxng } from "./searxng";
import { configureBuiltinSearch } from "./search-engines";
import { configureScraper } from "./scraper";
import { setToolTimeouts } from "./tool-types";

export function syncSearchRuntime(): void {
  const s = useSessionStore.getState();
  setSearchProviderOrder(s.searchProviderOrder);
  configureDdg({
    minIntervalMs: s.ddgMinIntervalMs,
    searchTimeoutMs: s.searchTimeoutMs,
    fetchTimeoutMs: s.scrapeTimeoutMs,
  });
  configureSearxng({
    baseUrl: s.searxngUrl,
    searchTimeoutMs: s.searchTimeoutMs,
    fetchTimeoutMs: s.scrapeTimeoutMs,
  });
  configureBuiltinSearch({
    enabledEngines: s.builtinSearchEngines,
    // One engine shouldn't eat the whole search budget: leave headroom for
    // the rest of the pool and the crw/cloud failover below it.
    perEngineTimeoutMs: Math.max(5_000, Math.min(15_000, s.searchTimeoutMs)),
  });
  configureScraper({
    respectRobots: s.robotsRespect,
    minHostIntervalMs: s.scrapeMinIntervalMs,
    maxConcurrentPerHost: s.scrapeMaxConcurrent,
    fetchTimeoutMs: s.scrapeTimeoutMs,
    maxBytes: s.maxPageBytes,
    allowPrivateHosts: s.allowPrivateHosts,
  });
  setToolTimeouts({ searchMs: s.searchTimeoutMs, scrapeMs: s.scrapeTimeoutMs });
}
