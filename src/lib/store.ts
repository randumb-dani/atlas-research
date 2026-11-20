import { create } from "zustand";
import type { SSEEvent } from "./types";
import type { ResolvedToolset } from "./tool-types";
import type { BuiltinEngineId } from "./search-engines";
import type { HistoryEntry } from "./history";

const BUILTIN_ENGINE_IDS: BuiltinEngineId[] = ["ddg", "bing", "mojeek", "brave", "wikipedia"];
const DEFAULT_BUILTIN_ENGINES: BuiltinEngineId[] = [...BUILTIN_ENGINE_IDS];

function normalizeEngines(value: unknown): BuiltinEngineId[] {
  if (!Array.isArray(value)) return [...DEFAULT_BUILTIN_ENGINES];
  const seen = new Set<BuiltinEngineId>();
  for (const raw of value) {
    const id = String(raw).toLowerCase() as BuiltinEngineId;
    if (BUILTIN_ENGINE_IDS.includes(id)) seen.add(id);
  }
  return [...seen];
}

/** Which local inference backend Atlas talks to. Both speak
 * `/v1/chat/completions`; only LM Studio has a native model-management API. */
export type LlmProvider = "lmstudio" | "unsloth";

export type SessionPhase =
  | "idle"
  | "clarifying"
  | "planning"
  | "researching"
  | "gap_check"
  | "compiling"
  | "done";

export interface SourceRef {
  url: string;
  title?: string;
  favicon?: string;
  subagentKey: string;
  timestamp: number;
  status: "success" | "failed";
  error?: string;
}

export interface SubagentState {
  /** Internal, guaranteed-unique key: `${cycle}:${id}`. Use this for all lookups/updates. */
  key: string;
  /** Model-chosen display id (e.g. "agent_02") — NOT guaranteed unique across cycles, display only. */
  id: string;
  brief: string;
  status: "pending" | "planning" | "researching" | "reporting" | "done";
  events: SSEEvent[];
  cycle: number;
  sources: SourceRef[];
  /** The subagent's actual final report text, once available — the single
   * source of truth for "what did this subagent conclude." Do not
   * reconstruct this from message.delta events in the event log; earlier
   * turns can contain prose (reasoning-before-a-tool-call) that isn't the
   * final answer, and stitching every turn's deltas together produces a
   * misleading blob rather than the real report. */
  report?: string;
  /** True if this subagent hit its iteration cap and was forced to
   * synthesize from partial research rather than finishing normally. */
  hitIterationCap?: boolean;
  /** Peer-to-peer messages this subagent received from other subagents
   * during the run, drained from the mailbox and surfaced in the UI. */
  peerMessages?: string[];
  /** Epoch ms when this subagent started (status left "pending"). */
  startedAt?: number;
  /** Epoch ms when this subagent completed (status became "done"). */
  completedAt?: number;
}

export function subagentKey(cycle: number, id: string): string {
  return `${cycle}:${id}`;
}

export interface CycleRecord {
  cycle: number;
  plan: string;
  gapCheckNotes: string;
}

export interface SessionState {
  orchestratorModel: string | null;
  subagentModel: string | null;
  phase: SessionPhase;
  cycle: number;
  maxCycles: number;
  plan: string;
  gapCheckNotes: string;
  cycleHistory: CycleRecord[];
  subagents: SubagentState[];
  orchestratorResponseId: string | undefined;
  compiledReport: string;
  clarifyingMessages: string;
  clarifyingThoughts: string;
  error: string | null;
  /** True when this session was rehydrated from storage after a reload that
   * interrupted an in-flight run (planning/researching/gap_check/compiling).
   * Those phases can't resume their async loop after a reload, so we restore
   * the view but flag it so the UI can tell the user research was stopped. */
  interrupted: boolean;
  crwUrl: string;
  crwApiKey: string;
  /** Selected inference backend (LM Studio by default). */
  llmProvider: LlmProvider;
  /** Base URL for LM Studio (used when llmProvider === "lmstudio"). */
  lmStudioUrl: string;
  /** Base URL for Unsloth Studio (used when llmProvider === "unsloth"). */
  unslothUrl: string;
  /** Bearer token for Unsloth Studio (`sk-unsloth-…`); "" when unset. */
  unslothApiKey: string;
  toolset: ResolvedToolset | null;
  /** Search provider order: built-in engine pool first (default), DDG-direct
   * primary with crw failover, or self-hosted SearXNG/crw first. */
  searchProviderOrder: "builtin-first" | "ddg-first" | "crw-first" | "searxng-first";
  /** Self-hosted SearXNG base URL ("" = disabled, chain skips it). */
  searxngUrl: string;
  /** Min ms between DDG search starts (DDG throttles bursty IPs). */
  ddgMinIntervalMs: number;
  /** Per-search network timeout (applies to both providers). */
  searchTimeoutMs: number;
  /** Per-scrape network timeout. */
  scrapeTimeoutMs: number;
  /** Built-in multi-engine search pool (DDG/Bing/Mojeek/Brave/Wikipedia). */
  builtinSearchEngines: BuiltinEngineId[];
  /** Honour robots.txt Disallow + Crawl-delay in the built-in scraper. */
  robotsRespect: boolean;
  /** Min ms between fetches to the same host. */
  scrapeMinIntervalMs: number;
  /** Max concurrent fetches per host (shared across subagents). */
  scrapeMaxConcurrent: number;
  /** Max response bytes the scraper will read. */
  maxPageBytes: number;
  /** Allow loopback/LAN/.local targets (SSRF guard opt-out). */
  allowPrivateHosts: boolean;

  // --- Actions ---

  setOrchestratorModel: (m: string) => void;
  setSubagentModel: (m: string) => void;
  setPhase: (p: SessionPhase) => void;
  setCycle: (c: number) => void;
  setMaxCycles: (c: number) => void;
  setPlan: (p: string) => void;
  appendPlan: (p: string) => void;
  setGapCheckNotes: (n: string) => void;
  appendGapCheckNotes: (n: string) => void;
  archiveCycle: (cycle: number) => void;
  setOrchestratorResponseId: (id: string | undefined) => void;
  addSubagent: (s: SubagentState) => void;
  updateSubagent: (key: string, update: Partial<SubagentState>) => void;
  addSubagentEvent: (key: string, event: SSEEvent) => void;
  addSource: (source: SourceRef) => void;
  addSubagentPeerMessages: (key: string, messages: string[]) => void;
  setCompiledReport: (r: string) => void;
  appendCompiledReport: (r: string) => void;
  appendClarifyingContent: (content: string) => void;
  setClarifyingThoughts: (c: string) => void;
  appendClarifyingThoughts: (content: string) => void;
  setError: (e: string | null) => void;
  setInterrupted: (v: boolean) => void;
  setCrwUrl: (url: string) => void;
  setCrwApiKey: (key: string) => void;
  setLlmProvider: (p: LlmProvider) => void;
  setLmStudioUrl: (url: string) => void;
  setUnslothUrl: (url: string) => void;
  setUnslothApiKey: (key: string) => void;
  setToolset: (t: ResolvedToolset | null) => void;
  setSearchProviderOrder: (o: "builtin-first" | "ddg-first" | "crw-first" | "searxng-first") => void;
  setSearxngUrl: (url: string) => void;
  setDdgMinIntervalMs: (ms: number) => void;
  setSearchTimeoutMs: (ms: number) => void;
  setScrapeTimeoutMs: (ms: number) => void;
  setBuiltinSearchEngines: (engines: BuiltinEngineId[]) => void;
  setRobotsRespect: (v: boolean) => void;
  setScrapeMinIntervalMs: (ms: number) => void;
  setScrapeMaxConcurrent: (n: number) => void;
  setMaxPageBytes: (bytes: number) => void;
  setAllowPrivateHosts: (v: boolean) => void;
  reset: () => void;
  loadSession: (entry: HistoryEntry) => void;
}

/** Hard cap on persisted SSE events per subagent in the store. Events beyond
 * this limit are dropped from the front (oldest first), so the most recent
 * events — the ones the live view renders — are always preserved. The LIVE
 * view reads from the unbounded in-memory buffer in live-events.ts, so what
 * the user sees during a run is never trimmed; this cap only bounds the
 * persisted/store copy used for reloads. */
const MAX_SUBAGENT_EVENTS = 600;

function loadInitialState(): {
  crwUrl: string;
  crwApiKey: string;
  llmProvider: LlmProvider;
  lmStudioUrl: string;
  unslothUrl: string;
  unslothApiKey: string;
  orchestratorModel: string | null;
  subagentModel: string | null;
  searchProviderOrder: "builtin-first" | "ddg-first" | "crw-first" | "searxng-first";
  searxngUrl: string;
  ddgMinIntervalMs: number;
  searchTimeoutMs: number;
  scrapeTimeoutMs: number;
  builtinSearchEngines: BuiltinEngineId[];
  robotsRespect: boolean;
  scrapeMinIntervalMs: number;
  scrapeMaxConcurrent: number;
  maxPageBytes: number;
  allowPrivateHosts: boolean;
} {
  try {
    const saved = localStorage.getItem("deep-research-config");
    if (saved) {
      const parsed = JSON.parse(saved);
      const orderRaw = parsed.searchProviderOrder;
      return {
        crwUrl: parsed.crwUrl || "http://127.0.0.1:3100",
        crwApiKey: parsed.crwApiKey || "",
        llmProvider: parsed.llmProvider === "unsloth" ? "unsloth" : "lmstudio",
        lmStudioUrl: parsed.lmStudioUrl || "http://127.0.0.1:1234",
        unslothUrl: parsed.unslothUrl || "http://127.0.0.1:8888",
        unslothApiKey: typeof parsed.unslothApiKey === "string" ? parsed.unslothApiKey : "",
        orchestratorModel: parsed.orchestratorModel || null,
        subagentModel: parsed.subagentModel || null,
        searchProviderOrder:
          orderRaw === "ddg-first" || orderRaw === "crw-first" || orderRaw === "searxng-first" || orderRaw === "builtin-first"
            ? orderRaw
            : "builtin-first",
        searxngUrl: typeof parsed.searxngUrl === "string" ? parsed.searxngUrl : "",
        ddgMinIntervalMs: numOr(parsed.ddgMinIntervalMs, 2000),
        searchTimeoutMs: numOr(parsed.searchTimeoutMs, 30_000),
        scrapeTimeoutMs: numOr(parsed.scrapeTimeoutMs, 60_000),
        builtinSearchEngines: normalizeEngines(parsed.builtinSearchEngines),
        robotsRespect: parsed.robotsRespect !== false,
        scrapeMinIntervalMs: numOr(parsed.scrapeMinIntervalMs, 1500),
        scrapeMaxConcurrent: Math.min(8, Math.max(1, numOr(parsed.scrapeMaxConcurrent, 2))),
        maxPageBytes: numOr(parsed.maxPageBytes, 2_000_000),
        allowPrivateHosts: parsed.allowPrivateHosts === true,
      };
    }
  } catch {}
  return {
    crwUrl: "http://127.0.0.1:3100",
    crwApiKey: "",
    llmProvider: "lmstudio" as const,
    lmStudioUrl: "http://127.0.0.1:1234",
    unslothUrl: "http://127.0.0.1:8888",
    unslothApiKey: "",
    orchestratorModel: null,
    subagentModel: null,
    searchProviderOrder: "builtin-first" as const,
    searxngUrl: "",
    ddgMinIntervalMs: 2000,
    searchTimeoutMs: 30_000,
    scrapeTimeoutMs: 60_000,
    builtinSearchEngines: [...DEFAULT_BUILTIN_ENGINES],
    robotsRespect: true,
    scrapeMinIntervalMs: 1500,
    scrapeMaxConcurrent: 2,
    maxPageBytes: 2_000_000,
    allowPrivateHosts: false,
  };
}

function numOr(value: unknown, fallback: number): number {
  // 0 is a legitimate persisted value (e.g. scrapeMinIntervalMs: 0 = no
  // spacing), so only reject missing/non-finite/negative values.
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const {
  crwUrl: initUrl,
  crwApiKey: initKey,
  llmProvider: initLlmProvider,
  lmStudioUrl: initLmUrl,
  unslothUrl: initUnslothUrl,
  unslothApiKey: initUnslothKey,
  orchestratorModel: initOrchModel,
  subagentModel: initSubModel,
  searchProviderOrder: initOrder,
  searxngUrl: initSearxngUrl,
  ddgMinIntervalMs: initInterval,
  searchTimeoutMs: initSearchTimeout,
  scrapeTimeoutMs: initScrapeTimeout,
  builtinSearchEngines: initBuiltinEngines,
  robotsRespect: initRobotsRespect,
  scrapeMinIntervalMs: initScrapeInterval,
  scrapeMaxConcurrent: initScrapeConcurrent,
  maxPageBytes: initMaxPageBytes,
  allowPrivateHosts: initAllowPrivateHosts,
} = loadInitialState();

// --- Live session persistence (so a reload returns to the page you were on) ---
const SESSION_KEY = "deep-research-session";
const IN_FLIGHT_PHASES: SessionPhase[] = ["planning", "researching", "gap_check", "compiling"];

function loadSessionState(): Partial<SessionState> | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.phase !== "string") return null;
    return parsed as Partial<SessionState>;
  } catch {
    return null;
  }
}

function persistSession(state: SessionState) {
  try {
    // Drop the heavy per-subagent SSE event log to keep localStorage small;
    // keep reports, sources, statuses, and peer messages (the useful bits).
    const subagents = state.subagents.map(({ events: _events, ...rest }) => ({ ...rest, events: [] as SSEEvent[] }));
    const data = {
      phase: state.phase,
      cycle: state.cycle,
      maxCycles: state.maxCycles,
      plan: state.plan,
      gapCheckNotes: state.gapCheckNotes,
      cycleHistory: state.cycleHistory,
      subagents,
      orchestratorResponseId: state.orchestratorResponseId,
      compiledReport: state.compiledReport,
      clarifyingMessages: state.clarifyingMessages,
      clarifyingThoughts: state.clarifyingThoughts,
      error: state.error,
      interrupted: state.interrupted,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    // storage full / unavailable -- session restore just won't work, non-fatal
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(state: SessionState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistSession(state), 400);
}

const persistedSession = loadSessionState();
const hydratedInterrupted = persistedSession
  ? IN_FLIGHT_PHASES.includes(persistedSession.phase as SessionPhase)
  : false;

const baseInitialState = {
  orchestratorModel: initOrchModel,
  subagentModel: initSubModel,
  phase: "idle" as SessionPhase,
  cycle: 0,
  maxCycles: 3,
  plan: "",
  gapCheckNotes: "",
  cycleHistory: [] as CycleRecord[],
  subagents: [] as SubagentState[],
  orchestratorResponseId: undefined as string | undefined,
  compiledReport: "",
  clarifyingMessages: "",
  clarifyingThoughts: "",
  error: null as string | null,
  interrupted: false,
  crwUrl: initUrl,
  crwApiKey: initKey,
  llmProvider: initLlmProvider,
  lmStudioUrl: initLmUrl,
  unslothUrl: initUnslothUrl,
  unslothApiKey: initUnslothKey,
  toolset: null as ResolvedToolset | null,
  searchProviderOrder: initOrder,
  searxngUrl: initSearxngUrl,
  ddgMinIntervalMs: initInterval,
  searchTimeoutMs: initSearchTimeout,
  scrapeTimeoutMs: initScrapeTimeout,
  builtinSearchEngines: initBuiltinEngines,
  robotsRespect: initRobotsRespect,
  scrapeMinIntervalMs: initScrapeInterval,
  scrapeMaxConcurrent: initScrapeConcurrent,
  maxPageBytes: initMaxPageBytes,
  allowPrivateHosts: initAllowPrivateHosts,
};

// Rehydrate a previously persisted session so a reload drops you back on the
// page/phase you were on. toolset is intentionally NOT restored -- it's
// resolved fresh from crwUrl by an effect at startup. interrupted is forced to
// true for any in-flight phase since those can't resume after a reload.
const initialState = persistedSession
  ? {
      ...baseInitialState,
      ...persistedSession,
      interrupted: hydratedInterrupted,
      toolset: null as ResolvedToolset | null,
    }
  : baseInitialState;

/**
 * Persist the connection-level config. Reads the live store rather than
 * taking arguments so adding a setting can never be forgotten at one call
 * site (that's how a newly added provider URL silently stopped persisting
 * before). Call it AFTER the state update.
 */
function persistConfig() {
  try {
    const current = JSON.parse(localStorage.getItem("deep-research-config") || "{}");
    const s = useSessionStore.getState();
    localStorage.setItem("deep-research-config", JSON.stringify({
      ...current,
      crwUrl: s.crwUrl,
      crwApiKey: s.crwApiKey,
      llmProvider: s.llmProvider,
      lmStudioUrl: s.lmStudioUrl,
      unslothUrl: s.unslothUrl,
      unslothApiKey: s.unslothApiKey,
      orchestratorModel: s.orchestratorModel ?? null,
      subagentModel: s.subagentModel ?? null,
      // Search tuning lives with the connection config so it survives reloads.
      searchProviderOrder: s.searchProviderOrder,
      searxngUrl: s.searxngUrl,
      ddgMinIntervalMs: s.ddgMinIntervalMs,
      searchTimeoutMs: s.searchTimeoutMs,
      scrapeTimeoutMs: s.scrapeTimeoutMs,
      builtinSearchEngines: s.builtinSearchEngines,
      robotsRespect: s.robotsRespect,
      scrapeMinIntervalMs: s.scrapeMinIntervalMs,
      scrapeMaxConcurrent: s.scrapeMaxConcurrent,
      maxPageBytes: s.maxPageBytes,
      allowPrivateHosts: s.allowPrivateHosts,
    }));
  } catch {}
}

export const useSessionStore = create<SessionState>((set) => ({
  ...initialState,
  setOrchestratorModel: (m) => {
    set({ orchestratorModel: m });
    persistConfig();
  },
  setSubagentModel: (m) => {
    set({ subagentModel: m });
    persistConfig();
  },
  setPhase: (p) => set({ phase: p }),
  setCycle: (c) => set({ cycle: c }),
  setMaxCycles: (c) => set({ maxCycles: c }),
  setPlan: (p) => set({ plan: p }),
  appendPlan: (p) => set((state) => ({ plan: state.plan + p })),
  setGapCheckNotes: (n) => set({ gapCheckNotes: n }),
  appendGapCheckNotes: (n) => set((state) => ({ gapCheckNotes: state.gapCheckNotes + n })),
  archiveCycle: (cycle) =>
    set((state) => ({
      cycleHistory: [...state.cycleHistory, { cycle, plan: state.plan, gapCheckNotes: state.gapCheckNotes }],
      plan: "",
      gapCheckNotes: "",
    })),
  setOrchestratorResponseId: (id) => set({ orchestratorResponseId: id }),
  addSubagent: (s) => set((state) => ({ subagents: [...state.subagents, s] })),
  updateSubagent: (key, update) =>
    set((state) => ({
      subagents: state.subagents.map((s) =>
        s.key === key ? { ...s, ...update } : s
      ),
    })),
  addSubagentEvent: (key, event) =>
    set((state) => ({
      subagents: state.subagents.map((s) => {
        if (s.key !== key) return s;
        const next = [...s.events, event];
        // Trim oldest events when over the cap -- keeps memory bounded during
        // long research runs with many tool-call iterations. The UI only ever
        // renders the tail of this array anyway, so dropping from the front is
        // harmless for what users actually see.
        if (next.length > MAX_SUBAGENT_EVENTS) {
          next.splice(0, next.length - MAX_SUBAGENT_EVENTS);
        }
        return { ...s, events: next };
      }),
    })),
  addSource: (source: SourceRef) =>
    set((state) => ({
      subagents: state.subagents.map((s) =>
        s.key === source.subagentKey
          ? { ...s, sources: [...(s.sources ?? []), source] }
          : s
      ),
    })),
  addSubagentPeerMessages: (key: string, messages: string[]) =>
    set((state) => ({
      subagents: state.subagents.map((s) =>
        s.key === key
          ? { ...s, peerMessages: [...(s.peerMessages ?? []), ...messages] }
          : s
      ),
    })),
  setCompiledReport: (r) => set({ compiledReport: r }),
  appendCompiledReport: (r) =>
    set((state) => ({ compiledReport: state.compiledReport + r })),
  appendClarifyingContent: (content) =>
    set((state) => ({ clarifyingMessages: state.clarifyingMessages + content })),
  appendClarifyingThoughts: (content) =>
    set((state) => ({ clarifyingThoughts: state.clarifyingThoughts + content })),
  setClarifyingThoughts: (c) => set({ clarifyingThoughts: c }),
  setError: (e) => set({ error: e }),
  setInterrupted: (v) => set({ interrupted: v }),
  setCrwUrl: (url) => {
    set({ crwUrl: url });
    persistConfig();
  },
  setCrwApiKey: (key) => {
    set({ crwApiKey: key });
    persistConfig();
  },
  setLlmProvider: (p) => {
    set({ llmProvider: p });
    persistConfig();
  },
  setLmStudioUrl: (url) => {
    set({ lmStudioUrl: url });
    persistConfig();
  },
  setUnslothUrl: (url) => {
    set({ unslothUrl: url });
    persistConfig();
  },
  setUnslothApiKey: (key) => {
    set({ unslothApiKey: key });
    persistConfig();
  },
  setToolset: (t) => set({ toolset: t }),
  setSearchProviderOrder: (o) => {
    set({ searchProviderOrder: o });
    persistConfig();
  },
  setDdgMinIntervalMs: (ms) => {
    set({ ddgMinIntervalMs: ms });
    persistConfig();
  },
  setSearchTimeoutMs: (ms) => {
    set({ searchTimeoutMs: ms });
    persistConfig();
  },
  setScrapeTimeoutMs: (ms) => {
    set({ scrapeTimeoutMs: ms });
    persistConfig();
  },
  setBuiltinSearchEngines: (engines) => {
    set({ builtinSearchEngines: normalizeEngines(engines) });
    persistConfig();
  },
  setRobotsRespect: (v) => {
    set({ robotsRespect: v });
    persistConfig();
  },
  setScrapeMinIntervalMs: (ms) => {
    set({ scrapeMinIntervalMs: ms });
    persistConfig();
  },
  setScrapeMaxConcurrent: (n) => {
    // Clamp here too: loadInitialState clamps on reload, and an unclamped
    // runtime value would silently change meaning after a reload.
    set({ scrapeMaxConcurrent: Math.min(8, Math.max(1, Math.floor(n) || 1)) });
    persistConfig();
  },
  setMaxPageBytes: (bytes) => {
    set({ maxPageBytes: bytes });
    persistConfig();
  },
  setAllowPrivateHosts: (v) => {
    set({ allowPrivateHosts: v });
    persistConfig();
  },
  setSearxngUrl: (url) => {
    set({ searxngUrl: url });
    persistConfig();
  },
  // toolset is connection-level infrastructure (which MCP tools are
  // available from crw/mailbox), not per-session research state — it's
  // resolved once by an effect keyed on crwUrl and nothing else ever
  // re-resolves it. If reset() wiped it, every research run after the
  // first (and any run after Cancel) would silently execute with zero
  // tools until the user changed their crw URL to force re-resolution.
  // Preserving it here, once, is more durable than remembering to restore
  // it at every call site that invokes reset().
  reset: () => {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {}
    // Use baseInitialState (the clean idle snapshot), NOT the hydrated
    // `initialState`: after a reload `initialState` carries the restored
    // in-flight phase and subagents, so spreading it would RE-APPLY the
    // interrupted run and Cancel would appear to do nothing.
    set((state) => ({
      ...baseInitialState,
      orchestratorModel: state.orchestratorModel,
      subagentModel: state.subagentModel,
      toolset: state.toolset,
      // The inference backend is connection-level too: switching between
      // LM Studio and Unsloth must survive Cancel/New Research.
      llmProvider: state.llmProvider,
      lmStudioUrl: state.lmStudioUrl,
      unslothUrl: state.unslothUrl,
      unslothApiKey: state.unslothApiKey,
      // Search tuning is connection-level like toolset — a Cancel/New
      // Research must not silently revert the user's provider/timeouts.
      searchProviderOrder: state.searchProviderOrder,
      searxngUrl: state.searxngUrl,
      ddgMinIntervalMs: state.ddgMinIntervalMs,
      searchTimeoutMs: state.searchTimeoutMs,
      scrapeTimeoutMs: state.scrapeTimeoutMs,
      builtinSearchEngines: state.builtinSearchEngines,
      robotsRespect: state.robotsRespect,
      scrapeMinIntervalMs: state.scrapeMinIntervalMs,
      scrapeMaxConcurrent: state.scrapeMaxConcurrent,
      maxPageBytes: state.maxPageBytes,
      allowPrivateHosts: state.allowPrivateHosts,
    }));
  },
  loadSession: (entry) => set({
    phase: "done",
    cycle: entry.cycle,
    maxCycles: entry.maxCycles,
    plan: entry.plan,
    gapCheckNotes: entry.gapCheckNotes,
    cycleHistory: entry.cycleHistory,
    subagents: entry.subagents.map((s) => ({ ...s, events: [] })),
    compiledReport: entry.compiledReport,
    clarifyingMessages: entry.clarifyingMessages,
    clarifyingThoughts: entry.clarifyingThoughts,
    error: entry.error,
    // Restore is a clean view of a FINISHED run: clear the "research was
    // stopped" banner from any prior interrupted session, and drop the old
    // backend response id so a later orchestrator turn can't reference a
    // response from a different session via previous_response_id.
    interrupted: false,
    orchestratorResponseId: undefined,
  }),
}));

// Persist the live session on every change (debounced) so a reload returns
// the user to the page/phase they were on instead of dropping to idle.
useSessionStore.subscribe((state) => schedulePersist(state));