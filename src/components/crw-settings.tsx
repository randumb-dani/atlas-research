import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSessionStore } from "@/lib/store";
import { testCrwConnection } from "@/lib/api";
import { testDdgConnection } from "@/lib/ddg-search";
import { testSearxngConnection } from "@/lib/searxng";
import {
  BUILTIN_ENGINE_DEFS,
  testBuiltinSearch,
  type BuiltinEngineId,
} from "@/lib/search-engines";
import { getScrapeStats } from "@/lib/scraper";
import { markCrwReachable } from "@/lib/web-search-source";
import { syncSearchRuntime } from "@/lib/apply-search-settings";
import { Wifi, WifiOff, Loader2, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function CrwSettings({ inline }: { inline?: boolean }) {
  const crwUrl = useSessionStore((s) => s.crwUrl);
  const crwApiKey = useSessionStore((s) => s.crwApiKey);
  const setCrwUrl = useSessionStore((s) => s.setCrwUrl);
  const setCrwApiKey = useSessionStore((s) => s.setCrwApiKey);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(crwUrl);
  const [apiKey, setApiKey] = useState(crwApiKey);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [ddgTestResult, setDdgTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ddgTesting, setDdgTesting] = useState(false);
  const [searxngTestResult, setSearxngTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [searxngTesting, setSearxngTesting] = useState(false);
  const [builtinTestResult, setBuiltinTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [builtinTesting, setBuiltinTesting] = useState(false);

  const searchProviderOrder = useSessionStore((s) => s.searchProviderOrder);
  const setSearchProviderOrder = useSessionStore((s) => s.setSearchProviderOrder);
  const searxngUrl = useSessionStore((s) => s.searxngUrl);
  const setSearxngUrl = useSessionStore((s) => s.setSearxngUrl);
  const ddgMinIntervalMs = useSessionStore((s) => s.ddgMinIntervalMs);
  const setDdgMinIntervalMs = useSessionStore((s) => s.setDdgMinIntervalMs);
  const searchTimeoutMs = useSessionStore((s) => s.searchTimeoutMs);
  const setSearchTimeoutMs = useSessionStore((s) => s.setSearchTimeoutMs);
  const scrapeTimeoutMs = useSessionStore((s) => s.scrapeTimeoutMs);
  const setScrapeTimeoutMs = useSessionStore((s) => s.setScrapeTimeoutMs);
  const builtinSearchEngines = useSessionStore((s) => s.builtinSearchEngines);
  const setBuiltinSearchEngines = useSessionStore((s) => s.setBuiltinSearchEngines);
  const robotsRespect = useSessionStore((s) => s.robotsRespect);
  const setRobotsRespect = useSessionStore((s) => s.setRobotsRespect);
  const scrapeMinIntervalMs = useSessionStore((s) => s.scrapeMinIntervalMs);
  const setScrapeMinIntervalMs = useSessionStore((s) => s.setScrapeMinIntervalMs);
  const scrapeMaxConcurrent = useSessionStore((s) => s.scrapeMaxConcurrent);
  const setScrapeMaxConcurrent = useSessionStore((s) => s.setScrapeMaxConcurrent);
  const maxPageBytes = useSessionStore((s) => s.maxPageBytes);
  const setMaxPageBytes = useSessionStore((s) => s.setMaxPageBytes);
  const allowPrivateHosts = useSessionStore((s) => s.allowPrivateHosts);
  const setAllowPrivateHosts = useSessionStore((s) => s.setAllowPrivateHosts);

  // The local fields initialize once from the store — resync whenever the
  // store values change elsewhere so Save/Test never act on stale text.
  useEffect(() => {
    setUrl(crwUrl);
    setApiKey(crwApiKey);
  }, [crwUrl, crwApiKey]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await testCrwConnection(url, apiKey);
    if (r.success) {
      markCrwReachable();
      setTestResult({ ok: true, msg: `Connected — ${r.tools?.length ?? 0} tools available` });
    } else {
      setTestResult({ ok: false, msg: r.error ?? "Connection failed" });
    }
    setTesting(false);
  };

  const handleDdgTest = async () => {
    setDdgTesting(true);
    setDdgTestResult(null);
    const r = await testDdgConnection();
    if (r.ok) {
      setDdgTestResult({
        ok: true,
        msg: `DDG OK — ${r.results ?? 0} results${r.endpoint ? ` via ${r.endpoint}` : ""}${r.ms != null ? ` in ${(r.ms / 1000).toFixed(1)}s` : ""}`,
      });
    } else {
      setDdgTestResult({ ok: false, msg: r.error ?? "DDG search failed" });
    }
    setDdgTesting(false);
  };

  const handleSearxngTest = async () => {
    setSearxngTesting(true);
    setSearxngTestResult(null);
    syncSearchRuntime();
    const r = await testSearxngConnection(searxngUrl);
    if (r.ok) {
      setSearxngTestResult({
        ok: true,
        msg: `SearXNG OK — ${r.results ?? 0} results${r.ms != null ? ` in ${(r.ms / 1000).toFixed(1)}s` : ""}`,
      });
    } else {
      setSearxngTestResult({ ok: false, msg: r.error ?? "SearXNG search failed" });
    }
    setSearxngTesting(false);
  };

  const handleBuiltinTest = async () => {
    setBuiltinTesting(true);
    setBuiltinTestResult(null);
    syncSearchRuntime();
    const r = await testBuiltinSearch("wikipedia");
    const parts = r.traces
      .map((t) =>
        t.ok
          ? `${t.engine} ${t.results}r/${(t.ms / 1000).toFixed(1)}s`
          : `${t.engine} failed`,
      )
      .join(" · ");
    const scrape = getScrapeStats();
    setBuiltinTestResult({
      ok: r.ok,
      msg:
        `${r.ok ? "OK" : "No results"}${parts ? ` — ${parts}` : ""}` +
        `${r.error ? ` — ${r.error}` : ""}` +
        ` · page cache ${scrape.cacheEntries}, ${scrape.fetches} fetches`,
    });
    setBuiltinTesting(false);
  };

  const toggleEngine = (id: BuiltinEngineId) => {
    const next = builtinSearchEngines.includes(id)
      ? builtinSearchEngines.filter((e) => e !== id)
      : [...builtinSearchEngines, id];
    setBuiltinSearchEngines(next);
    syncSearchRuntime();
  };

  const handleSave = () => {
    setCrwUrl(url);
    setCrwApiKey(apiKey);
    setOpen(false);
  };

  const handleUrlChange = (v: string) => {
    setUrl(v);
    if (inline) setCrwUrl(v);
  };

  const handleKeyChange = (v: string) => {
    setApiKey(v);
    if (inline) setCrwApiKey(v);
  };

  const form = (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">CRW Connection</h3>
      <div className="space-y-2">
        <label htmlFor="crw-url" className="text-xs font-medium text-muted-foreground">MCP Server URL</label>
        <Input
          id="crw-url"
          value={url}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder="http://localhost:3100"
        />
        <p className="text-[11px] text-muted-foreground/80">
          On a phone or another device, use the host machine's LAN address (e.g. http://192.168.1.50:3100).
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor="crw-key" className="text-xs font-medium text-muted-foreground">API Key (optional)</label>
        <Input
          id="crw-key"
          value={apiKey}
          onChange={(e) => handleKeyChange(e.target.value)}
          placeholder="crw_live_..."
          type="password"
        />
        <p className="text-[11px] text-muted-foreground/80">
          fastcrw.com cloud key (1000 free credits) — used automatically as a managed fallback when DDG is blocked and no local crw runs. Also used as the Bearer token for hosted crw.
        </p>
      </div>
      {testResult && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
          testResult.ok
            ? "border-success/30 bg-success-muted text-success"
            : "border-destructive/30 bg-destructive-muted text-destructive"
        }`}>
          {testResult.ok ? <Wifi className="mt-0.5 size-3 shrink-0" /> : <WifiOff className="mt-0.5 size-3 shrink-0" />}
          <span>{testResult.msg}</span>
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={handleTest} disabled={testing || !url.trim()}>
          {testing && <Loader2 className="mr-1 size-3 animate-spin" />}
          Test Connection
        </Button>
        <Button variant="secondary" onClick={handleDdgTest} disabled={ddgTesting}>
          {ddgTesting && <Loader2 className="mr-1 size-3 animate-spin" />}
          Test DDG
        </Button>
        {!inline && <Button onClick={handleSave} className="ml-auto">Save</Button>}
      </div>
      {ddgTestResult && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
          ddgTestResult.ok
            ? "border-success/30 bg-success-muted text-success"
            : "border-destructive/30 bg-destructive-muted text-destructive"
        }`}>
          {ddgTestResult.ok ? <Wifi className="mt-0.5 size-3 shrink-0" /> : <WifiOff className="mt-0.5 size-3 shrink-0" />}
          <span>{ddgTestResult.msg}</span>
        </div>
      )}
      <div className="space-y-2 pt-1">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Search Providers</h3>
        <div className="space-y-2">
          <label htmlFor="searxng-url" className="text-xs font-medium text-muted-foreground">SearXNG URL (optional, self-hosted)</label>
          <Input
            id="searxng-url"
            value={searxngUrl}
            onChange={(e) => { setSearxngUrl(e.target.value); syncSearchRuntime(); }}
            placeholder="http://localhost:8888"
          />
          <p className="text-[11px] text-muted-foreground/80">
            Your own SearXNG instance for search (JSON API at /search?q=...&format=json). Scraping uses the built-in static fetch plus crw/fastcrw failover. Leave empty to disable.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border/50 p-1">
          {(
            [
              { value: "builtin-first", label: "Built-in first" },
              { value: "ddg-first", label: "DDG first" },
              { value: "searxng-first", label: "SearXNG first" },
              { value: "crw-first", label: "crw first" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={value}
              onClick={() => { setSearchProviderOrder(value); syncSearchRuntime(); }}
              className={cn(
                "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                searchProviderOrder === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50"
              )}
              aria-pressed={searchProviderOrder === value}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground/80">
          Search chain: built-in engine pool (keyless) → SearXNG when configured → local crw when reachable → fastcrw cloud when keyed. crw and SearXNG are optional — research works fully without them.
        </p>
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Built-in Engine Pool</h3>
            <span className="text-[10px] text-muted-foreground/70">{builtinSearchEngines.length} enabled</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {BUILTIN_ENGINE_DEFS.map((def) => {
              const on = builtinSearchEngines.includes(def.id);
              return (
                <button
                  key={def.id}
                  onClick={() => toggleEngine(def.id)}
                  aria-pressed={on}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                    on
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border/50 text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <span className="text-xs font-medium">{def.label}</span>
                  <span className="truncate text-[10px] text-muted-foreground/70">{def.note}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            Engines are queried one at a time in this order with shared pacing, and the pool stops once the result set is full. Disable one if it keeps challenging this network.
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={handleBuiltinTest}
              disabled={builtinTesting || builtinSearchEngines.length === 0}
            >
              {builtinTesting && <Loader2 className="mr-1 size-3 animate-spin" />}
              Test Built-in Search
            </Button>
          </div>
          {builtinTestResult && (
            <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              builtinTestResult.ok
                ? "border-success/30 bg-success-muted text-success"
                : "border-destructive/30 bg-destructive-muted text-destructive"
            }`}>
              {builtinTestResult.ok ? <Wifi className="mt-0.5 size-3 shrink-0" /> : <WifiOff className="mt-0.5 size-3 shrink-0" />}
              <span className="break-words">{builtinTestResult.msg}</span>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handleSearxngTest} disabled={searxngTesting || !searxngUrl.trim()}>
            {searxngTesting && <Loader2 className="mr-1 size-3 animate-spin" />}
            Test SearXNG
          </Button>
        </div>
        {searxngTestResult && (
          <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
            searxngTestResult.ok
              ? "border-success/30 bg-success-muted text-success"
              : "border-destructive/30 bg-destructive-muted text-destructive"
          }`}>
            {searxngTestResult.ok ? <Wifi className="mt-0.5 size-3 shrink-0" /> : <WifiOff className="mt-0.5 size-3 shrink-0" />}
            <span>{searxngTestResult.msg}</span>
          </div>
        )}
      </div>
      <div className="space-y-2 pt-1">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Scraper &amp; Crawl Policy</h3>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border/50 p-1">
          <button
            onClick={() => { setRobotsRespect(true); syncSearchRuntime(); }}
            aria-pressed={robotsRespect}
            className={cn(
              "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              robotsRespect ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            Respect robots.txt
          </button>
          <button
            onClick={() => { setRobotsRespect(false); syncSearchRuntime(); }}
            aria-pressed={!robotsRespect}
            className={cn(
              "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              !robotsRespect ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            Ignore robots.txt
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground/80">
          Respected by default: Disallow rules are enforced and Crawl-delay raises the per-host gap. Ignoring is a deliberate override for research on sites you control.
        </p>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2">
          <div>
            <div className="text-xs font-medium">Allow LAN / private hosts</div>
            <div className="text-[10px] text-muted-foreground/70">
              Off blocks localhost and RFC1918 targets so model-supplied URLs can't reach your network.
            </div>
          </div>
          <button
            onClick={() => { setAllowPrivateHosts(!allowPrivateHosts); syncSearchRuntime(); }}
            aria-pressed={allowPrivateHosts}
            className={cn(
              "shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
              allowPrivateHosts
                ? "border-destructive/40 bg-destructive-muted text-destructive"
                : "border-border/60 text-muted-foreground hover:bg-muted/50",
            )}
          >
            {allowPrivateHosts ? "On" : "Off"}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <label htmlFor="scrape-gap" className="text-[11px] font-medium text-muted-foreground">Host gap (s)</label>
            <Input
              id="scrape-gap"
              type="number"
              min={0.5}
              max={10}
              step={0.5}
              value={scrapeMinIntervalMs / 1000}
              onChange={(e) => {
                const v = Math.min(10, Math.max(0.5, Number(e.target.value) || 1.5));
                setScrapeMinIntervalMs(Math.round(v * 1000));
                syncSearchRuntime();
              }}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="scrape-concurrency" className="text-[11px] font-medium text-muted-foreground">Per host</label>
            <Input
              id="scrape-concurrency"
              type="number"
              min={1}
              max={8}
              step={1}
              value={scrapeMaxConcurrent}
              onChange={(e) => {
                const v = Math.min(8, Math.max(1, Number(e.target.value) || 2));
                setScrapeMaxConcurrent(v);
                syncSearchRuntime();
              }}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="scrape-max-bytes" className="text-[11px] font-medium text-muted-foreground">Max page (MB)</label>
            <Input
              id="scrape-max-bytes"
              type="number"
              min={0.25}
              max={10}
              step={0.25}
              value={Math.round((maxPageBytes / 1_000_000) * 100) / 100}
              onChange={(e) => {
                const v = Math.min(10, Math.max(0.25, Number(e.target.value) || 2));
                setMaxPageBytes(Math.round(v * 1_000_000));
                syncSearchRuntime();
              }}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground/80">
          These limits are shared across all subagents: concurrent tool calls queue per host instead of bursting. Pages are cached for 10 minutes.
        </p>
      </div>
      <div className="space-y-2 pt-1">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pacing &amp; Timeouts</h3>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <label htmlFor="ddg-spacing" className="text-[11px] font-medium text-muted-foreground">DDG gap (s)</label>
            <Input
              id="ddg-spacing"
              type="number"
              min={0.5}
              max={10}
              step={0.5}
              value={ddgMinIntervalMs / 1000}
              onChange={(e) => {
                const v = Math.min(10, Math.max(0.5, Number(e.target.value) || 2));
                setDdgMinIntervalMs(Math.round(v * 1000));
                syncSearchRuntime();
              }}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="search-timeout" className="text-[11px] font-medium text-muted-foreground">Search (s)</label>
            <Input
              id="search-timeout"
              type="number"
              min={5}
              max={120}
              step={5}
              value={searchTimeoutMs / 1000}
              onChange={(e) => {
                const v = Math.min(120, Math.max(5, Number(e.target.value) || 30));
                setSearchTimeoutMs(Math.round(v * 1000));
                syncSearchRuntime();
              }}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="scrape-timeout" className="text-[11px] font-medium text-muted-foreground">Scrape (s)</label>
            <Input
              id="scrape-timeout"
              type="number"
              min={10}
              max={180}
              step={5}
              value={scrapeTimeoutMs / 1000}
              onChange={(e) => {
                const v = Math.min(180, Math.max(10, Number(e.target.value) || 60));
                setScrapeTimeoutMs(Math.round(v * 1000));
                syncSearchRuntime();
              }}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground/80">
          Raise the DDG gap if you see throttling; lower timeouts to fail fast on hung providers.
        </p>
      </div>
    </div>
  );

  if (inline) return form;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="CRW settings">
        <Settings2 className="size-3.5" />
      </Button>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Search &amp; Scraping</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-5 pt-3">{form}</div>
      </DialogContent>
    </Dialog>
  );
}
