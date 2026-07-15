import { create } from "zustand";
import type { SSEEvent } from "./types";
import type { ResolvedToolset } from "./tool-types";
import type { HistoryEntry } from "./history";

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
  lmStudioUrl: string;
  toolset: ResolvedToolset | null;

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
  setLmStudioUrl: (url: string) => void;
  setToolset: (t: ResolvedToolset | null) => void;
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

function loadInitialState() {
  try {
    const saved = localStorage.getItem("deep-research-config");
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        crwUrl: parsed.crwUrl || "http://127.0.0.1:3100",
        crwApiKey: parsed.crwApiKey || "",
        lmStudioUrl: parsed.lmStudioUrl || "http://127.0.0.1:1234",
        orchestratorModel: parsed.orchestratorModel || null,
        subagentModel: parsed.subagentModel || null,
      };
    }
  } catch {}
  return { crwUrl: "http://127.0.0.1:3100", crwApiKey: "", lmStudioUrl: "http://127.0.0.1:1234", orchestratorModel: null, subagentModel: null };
}

const { crwUrl: initUrl, crwApiKey: initKey, lmStudioUrl: initLmUrl, orchestratorModel: initOrchModel, subagentModel: initSubModel } = loadInitialState();

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
  lmStudioUrl: initLmUrl,
  toolset: null as ResolvedToolset | null,
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

function saveConfig(url: string, key: string, lmUrl?: string, orchModel?: string | null, subModel?: string | null) {
  try {
    const current = JSON.parse(localStorage.getItem("deep-research-config") || "{}");
    localStorage.setItem("deep-research-config", JSON.stringify({
      ...current,
      crwUrl: url,
      crwApiKey: key,
      lmStudioUrl: lmUrl ?? current.lmStudioUrl ?? "http://localhost:1234",
      orchestratorModel: orchModel ?? current.orchestratorModel ?? null,
      subagentModel: subModel ?? current.subagentModel ?? null,
    }));
  } catch {}
}

export const useSessionStore = create<SessionState>((set) => ({
  ...initialState,
  setOrchestratorModel: (m) => {
    const s = useSessionStore.getState();
    saveConfig(s.crwUrl, s.crwApiKey, s.lmStudioUrl, m, undefined);
    set({ orchestratorModel: m });
  },
  setSubagentModel: (m) => {
    const s = useSessionStore.getState();
    saveConfig(s.crwUrl, s.crwApiKey, s.lmStudioUrl, undefined, m);
    set({ subagentModel: m });
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
    const s = useSessionStore.getState();
    saveConfig(url, s.crwApiKey, s.lmStudioUrl);
    set({ crwUrl: url });
  },
  setCrwApiKey: (key) => {
    const s = useSessionStore.getState();
    saveConfig(s.crwUrl, key, s.lmStudioUrl);
    set({ crwApiKey: key });
  },
  setLmStudioUrl: (url) => {
    const s = useSessionStore.getState();
    saveConfig(s.crwUrl, s.crwApiKey, url);
    set({ lmStudioUrl: url });
  },
  setToolset: (t) => set({ toolset: t }),
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
      lmStudioUrl: state.lmStudioUrl,
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
  }),
}));

// Persist the live session on every change (debounced) so a reload returns
// the user to the page/phase they were on instead of dropping to idle.
useSessionStore.subscribe((state) => schedulePersist(state));