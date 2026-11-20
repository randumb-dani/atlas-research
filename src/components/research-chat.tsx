"use client"

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SSETimeline } from "@/components/sse-timeline";
import { LoadingStandard, ResearchingSwirl } from "@/components/loading-indicators";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
} from "@/components/ui/collapsible";
import { Streamdown } from "streamdown";
import { streamChat, listModels } from "@/lib/api";
import { useSessionStore, subagentKey } from "@/lib/store";
import { LLM_PROVIDERS, normalizeLlmProvider } from "@/lib/llm-provider";
import { useTheme } from "@/lib/theme-provider";
import { resolveToolset, runToolLoop } from "@/lib/tool-loop";
import { webSearchToolSource, resetCrwSessionFlag } from "@/lib/web-search-source";
import { clearDdgCache, resetDdgThrottle } from "@/lib/ddg-search";
import { clearSearxngCache, resetSearxngThrottle } from "@/lib/searxng";
import { resetBuiltinSearch } from "@/lib/search-engines";
import { resetScrapeState } from "@/lib/scraper";
import { syncSearchRuntime } from "@/lib/apply-search-settings";
import type { ResolvedToolset } from "@/lib/tool-types";
import { loadHistory, addEntry, deleteEntry, clearHistory } from "@/lib/history";
import type { HistoryEntry } from "@/lib/history";
import { HistoryPanel } from "@/components/history-panel";
import { mailboxToolSource, registerAgent as mailboxRegister, deregisterAgent as mailboxDeregister, resetMailbox, resetCycleAgents, collectUndelivered, drainInbox } from "@/lib/mailbox-local";
import { pushLiveEvent, resetLiveEvents, useLiveEvents, flushLiveEvents } from "@/lib/live-events";
import { playSound, preloadSounds } from "@/lib/sounds";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  ArrowRight,
  Send,
  CheckCircle2,
  Brain,
  Search,
  ListChecks,
  FileSearch,
  RotateCcw,
  XCircle,
  FileText,
  ChevronRight,
  Globe,
  AlertTriangle,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Settings,
  Download,
  Copy,
  Check,
  ScanSearch,
  Sparkles,
  Activity,
} from "lucide-react";
import { SourcesSheet } from "@/components/sources-sheet";
import { SubagentStatus } from "@/components/subagent-status";
import { SubagentSourceList } from "@/components/subagent-source-list";
import { SubagentReport } from "@/components/subagent-report";

import { cn, filterProceed, formatSubagentId, formatDuration } from "@/lib/utils";

function withDate(prompt: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  return `Current date (real): ${dateStr}.\n\n${prompt}`;
}

/** Find the outermost balanced `[...]` or `{...}` (respecting strings and
 * escape sequences) starting from the first `open` in `text`. This is robust
 * to braces that appear inside string values (e.g. a question containing "}")
 * and to large payloads, unlike a naive lastIndexOf(close). */
function extractBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonEnvelope<T>(text: string, preferArray = false): T | null {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const brackets = preferArray
    ? ([["[", "]"], ["{", "}"]] as const)
    : ([["{", "}"], ["[", "]"]] as const);
  for (const [open, close] of brackets) {
    const candidate = extractBalanced(cleaned, open, close);
    if (candidate) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // fall through to next bracket type
      }
    }
  }
  return null;
}

interface ClarifyDecision {
  needs_clarification: boolean;
  questions: string | string[] | null;
}

/** Normalize the model's `questions` field (string or string[] or null) into a
 * single trimmed string, or "" if absent/empty. Handles models that return a
 * list of question strings instead of one markdown block. */
function normalizeQuestions(questions: string | string[] | null | undefined): string {
  if (!questions) return "";
  if (Array.isArray(questions)) {
    const items = questions.map((q) => q.trim()).filter(Boolean);
    return items.map((q, i) => `${i + 1}. ${q}`).join("\n");
  }
  return questions.trim();
}

interface GapCheckDecision {
  answerable: boolean;
  gaps: string[];
  action: "compile" | "replan";
  reason: string;
}

interface PlanItem {
  subagent_id: string;
  brief: string;
  focus_questions?: string[];
}

interface PeerInfo {
  id: string;
  key: string;
  brief: string;
  questions: string[];
}

/** System prompt for one research subagent. Module-level so both the cycle
 * runner and single-agent retry build byte-identical prompts. */
function buildSubagentPrompt(displayId: string, key: string, brief: string, peers: PeerInfo[]): string {
  const peerBlock = peers.length === 0 ? "" :
    "PEER SUBAGENTS IN THIS CYCLE:\n" +
    peers.map((p) =>
      `- ${p.id} (key: ${p.key}) — ${p.brief}${p.questions.length ? `\n  Focus questions: ${p.questions.join("; ")}` : ""}`
    ).join("\n") + "\n\n";
  return withDate(`You are research subagent "${displayId}" (internal key: ${key}). Task: ${brief}

Available tools (call them — do not describe them, do not announce them):
- web_search -- the ONLY research tool. Two modes: pass query (3-10 distinctive terms) to search the web (returns short Title/URL/Snippet blocks — use FIRST to find source URLs), or pass url (an exact URL from a prior search — never invent one) to fetch that page as Markdown text. If both are present, url wins. Ask for at most 5 results per search, and issue ONE search at a time -- rapid parallel searches get the provider to throttle you. Search results are snippets, not evidence: fetch a promising URL with a second call before drawing conclusions. Prefer fetching over more searching once you have a good URL.

Your FIRST response must be a web_search call, not text. Do not write introductions, preambles, or statements of intent ("Let me research…", "I'll start by…") — just call web_search immediately.
- send_to_subagent(to_subagent_key: string, message: string) -- Send a message to one specific peer by their internal key.
- broadcast_to_peers(my_subagent_key: string, message: string) -- Send a message to ALL other peers at once. Use this whenever a finding is relevant to more than one peer, or when you're unsure which single agent should receive it -- it's easier and more reliable than guessing a key.
- check_inbox(my_subagent_key: string) -- Check for messages from other subagents. Non-destructive: calling it doesn't consume anything, so unread messages will also still appear automatically at the start of your next turn -- you don't need to call it defensively "just in case," and seeing the same message twice (once from a check_inbox call, once auto-delivered) is expected, not a sign something is wrong.

${peerBlock}COORDINATION -- all peers are researching IN PARALLEL, so the best time to share is DURING your research, not at the end:
- Share findings THE MOMENT you find them: as soon as a scrape reveals something that answers a peer's focus question, contradicts their expected angle, or is a high-value source they'd want, send it. Don't wait until you write your report -- by then your peers are also busy writing their own reports and won't act on it.
- Use broadcast_to_peers for anything relevant to the group or when you're unsure who needs it, or for help with tools if yours are failing. It reaches every other peer at once.
- Use check_inbox periodically BETWEEN scrapes (not just at the end) to pick up findings peers have already sent you -- they're researching at the same time you are, so new messages arrive mid-research.
- Alert on tool failures: if your scrapes keep hitting login/captcha walls or returning thin content, broadcast to peers so they know a gap exists.
- Messaging is NEVER wasted: notes to still-active peers are delivered directly (they'll see them on their next turn), and notes to peers who have already finished are recorded and read by the orchestrator during final synthesis. Even a one-line pointer to a source or a contradiction is worth sending.
- Do not spam -- consolidate related findings into a single message rather than many small ones.

RESEARCH DISCIPLINE -- do not skip this:
1. A search snippet is not a finding -- it's an address where a finding might live. Never write your report from search results alone; scrape before drawing any conclusion. Issue ONE search at a time (parallel searches get throttled), with a limit of 3-5 results each.
2. Source floor: scrape at least 4-6 real sources before writing your report, unless your assigned angle is genuinely narrow enough that fewer distinct sources exist -- if so, say that explicitly in your report rather than silently stopping short.
3. A scrape returning HTTP 200 is not automatically a real success. Membership/login walls, pure navigation pages, and thin listicles with little substantive content don't count toward your source floor even though the tool call "succeeded" -- recognize a thin scrape and get a real replacement source instead of counting it.
4. If your assigned angle touches a contested, social, political, or normative question, deliberately include at least one source that critiques, disputes, or takes a differing view -- not just sources that agree with each other. Five sources that all lean the same direction is not diverse coverage.
5. When sources disagree on a specific fact (price, spec, date, claim), name which source said what rather than picking one as consensus.
6. Attribute claims to their source in your report ("X's review found..."; "critics on Y argue...") rather than stating contested claims in your own voice as settled fact.
7. Stop searching once you've hit your source floor and covered your assigned angle -- do not keep searching for marginally better sources once you have enough, but do not stop short of the floor to save time either.
8. Check your inbox for peer findings periodically throughout your research (not only at the end) and incorporate them as you go; also do a final check before writing your report. If a peer sent useful data, attribute it in your report ("Agent X found that...").

SOURCE LOG -- maintain this as you go:
Keep a running numbered list of every source you actually scraped: [S1] url -- one-line description of what it contained. Every factual claim in your report must be traceable to one of these numbers. If you cannot assign a number to a claim, you cannot include the claim.

OUTPUT FORMAT -- your final report must include, in order:
1. Source log: the numbered [S1], [S2]... list described above.
2. Findings: your actual research content, with every claim tagged inline to its source number, e.g. "The device draws 12W under load [S3]." Where sources conflict, show both: "[S2] reports X while [S4] reports Y."
3. Confidence flags: a short list of any claims that rest on only one source, are dated/possibly stale, or come from a source of uncertain reliability (e.g. forum post, unverified blog). Don't bury this in prose -- list it so the orchestrator can see it at a glance.
4. Gaps: anything your focus questions asked for that you could not find after a genuine search effort. Name the specific unanswered question. A stated gap is a correct, useful output -- not a failure.

HARD CONSTRAINTS:
- If you cannot find information to answer a specific question, write "Not found: [question]" in the Gaps section. Do not fill the gap with a plausible-sounding guess.
- Never invent a URL, source name, statistic, date, or quote. If you're reconstructing something from memory rather than reading it in a scrape this session, don't present it as a finding -- flag it as unverified or leave it out.
- Every number, quote, or specific factual claim needs a source tag. If it doesn't have one, either find the source or cut the claim.`);
}

const phaseSteps = [
  { key: "clarifying", label: "Clarify", icon: Brain },
  { key: "planning", label: "Plan", icon: ListChecks },
  { key: "researching", label: "Research", icon: Search },
  { key: "gap_check", label: "Review", icon: ScanSearch },
  { key: "compiling", label: "Compile", icon: Sparkles },
  { key: "done", label: "Done", icon: CheckCircle2 },
] as const;

function PhaseIndicator({ currentPhase, className }: { currentPhase: string; className?: string }) {
  const currentIdx = phaseSteps.findIndex((s) => s.key === currentPhase);
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto py-1", className)}>
      {phaseSteps.map((step, i) => {
        const Icon = step.icon;
        const isActive = i === currentIdx;
        const isPast = i < currentIdx;
        return (
          <div key={step.key} className="flex items-center whitespace-nowrap">
            {i > 0 && (
              <div className={cn("mx-1 h-px w-4 shrink-0", isPast ? "bg-primary/50" : "bg-border")} />
            )}
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all duration-300 shrink-0",
                isActive
                  ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                  : isPast
                  ? "text-primary bg-primary/5"
                  : "text-muted-foreground bg-muted"
              )}
            >
              <Icon className={cn("size-3", isActive && "animate-pulse-soft")} />
              <span>{step.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ResearchChat({ sourcesOpen: externalSourcesOpen, onSourcesOpenChange, onSettingsClick }: {
  sourcesOpen?: boolean;
  onSourcesOpenChange?: (open: boolean) => void;
  onSettingsClick?: () => void;
}) {
  const [input, setInput] = useState("");
  const [toolsetError, setToolsetError] = useState<string | null>(null);
  const [clarifyingAnswer, setClarifyingAnswer] = useState("");
  const [researchDepth, setResearchDepth] = useState<"shallow" | "standard" | "deep">("standard");
  const depthCycles = { shallow: 2, standard: 3, deep: 5 } as const;
  const thoughtScrollRef = useRef<HTMLDivElement>(null);
  const queryInputRef = useRef<HTMLTextAreaElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [internalSourcesOpen, setInternalSourcesOpen] = useState(false);
  const sourcesOpen = externalSourcesOpen ?? internalSourcesOpen;
  const setSourcesOpen = onSourcesOpenChange ?? setInternalSourcesOpen;

  const cancelRef = useRef<AbortController | null>(null);
  const restoringRef = useRef(false);
  // Guards against double-click / Enter double-fire during handleStart's
  // async pre-flight (toolset + model check), before phase leaves "idle".
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  // Snapshot of the query + depth at Start time. The history effect below
  // fires on phase change (long after Start), when `input`/`researchDepth`
  // state may already be stale — the ref keeps the saved entry accurate.
  const startedQueryRef = useRef("");
  const startedDepthRef = useRef<"shallow" | "standard" | "deep">("standard");

  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setHistoryEntries(loadHistory());
  }, []);

  useEffect(() => {
    preloadSounds();
  }, []);

  const { resolvedTheme } = useTheme();
  const crwUrl = useSessionStore((s) => s.crwUrl);
  const crwApiKey = useSessionStore((s) => s.crwApiKey);

  useEffect(() => {
    let cancelled = false;
    setToolsetError(null);
    // Apply persisted search tuning (provider order, DDG pacing, timeouts)
    // before resolving — module runtimes start at compiled defaults.
    syncSearchRuntime();
    resetCrwSessionFlag();
    resolveToolset([webSearchToolSource(crwUrl, crwApiKey), mailboxToolSource()])
      .then((resolved) => {
        if (cancelled) return;
        useSessionStore.getState().setToolset(resolved);
        if (resolved.tools.length === 0) {
          setToolsetError("No tools were found -- check that crw is running and reachable at the configured URL.");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        useSessionStore.getState().setToolset(null);
        setToolsetError(err instanceof Error ? err.message : "Failed to load tools.");
      });
    return () => { cancelled = true; };
  }, [crwUrl, crwApiKey]);

  const handleThoughtScroll = useCallback(() => {
    const el = thoughtScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setUserScrolledUp(!atBottom);
  }, []);

  const phase = useSessionStore((s) => s.phase);

  // Keep the idle query textarea sized to its content (including the
  // placeholder when empty) so it never shows an internal scrollbar at rest.
  useEffect(() => {
    const el = queryInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input, phase]);
  const cycle = useSessionStore((s) => s.cycle);
  const maxCycles = useSessionStore((s) => s.maxCycles);
  const plan = useSessionStore((s) => s.plan);
  const gapCheckNotes = useSessionStore((s) => s.gapCheckNotes);
  const subagents = useSessionStore((s) => s.subagents);
  const compiledReport = useSessionStore((s) => s.compiledReport);
  const error = useSessionStore((s) => s.error);
  const interrupted = useSessionStore((s) => s.interrupted);
  // True only on the first mount when the initial phase is already "done",
  // which can only happen because we rehydrated a finished session from
  // storage -- in that case the report is already in history, so skip the
  // "add history entry" effect that fires on phase change.
  const hydratedDoneRef = useRef(phase === "done");
  const clarifyingMessages = useSessionStore((s) => s.clarifyingMessages);
  const clarifyingThoughts = useSessionStore((s) => s.clarifyingThoughts);
  useEffect(() => {
    if (!userScrolledUp) {
      thoughtScrollRef.current?.scrollTo({ top: thoughtScrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [clarifyingThoughts, userScrolledUp]);

  useEffect(() => {
    if (phase !== "done") return;
    if (restoringRef.current) { restoringRef.current = false; return; }
    if (hydratedDoneRef.current) { hydratedDoneRef.current = false; return; }
    const s = useSessionStore.getState();
    addEntry({
      id: crypto.randomUUID(),
      query: startedQueryRef.current,
      timestamp: Date.now(),
      depth: startedDepthRef.current,
      orchModel: s.orchestratorModel ?? "",
      subModel: s.subagentModel ?? "",
      cycle: s.cycle,
      maxCycles: s.maxCycles,
      plan: s.plan,
      gapCheckNotes: s.gapCheckNotes,
      cycleHistory: s.cycleHistory,
      subagents: s.subagents.map(({ events: _, ...rest }) => rest),
      compiledReport: s.compiledReport,
      clarifyingMessages: s.clarifyingMessages,
      clarifyingThoughts: s.clarifyingThoughts,
      error: s.error,
    });
    setHistoryEntries(loadHistory());
  }, [phase]);
  const hasOrchModel = useSessionStore((s) => s.orchestratorModel);
  const hasSubModel = useSessionStore((s) => s.subagentModel);
  const canStart = hasOrchModel && hasSubModel && input.trim() && phase === "idle" && !starting;
  const store = useSessionStore;

const runClarifying = useCallback(async (userInput: string) => {
    const s = store.getState();
    s.setPhase("clarifying");
    playSound("clarifying");
    s.setError(null);
    s.setClarifyingThoughts("");
    const prompt = withDate(`[ROLE] You are a deep research agent. Decide if the query below needs clarification before you can research it well.
[QUERY] "${userInput}"

Respond with ONLY a single JSON object, no other text, no markdown fences:
{
  "needs_clarification": boolean,
  "questions": string[] | null
}
If needs_clarification is true, each element of "questions" must be ONE self-contained plain-text question (no markdown, no embedded newlines, no numbering prefix -- the array index provides the ordering). Keep the array empty/null if no clarification is needed.`);
    streamChat(
      { model: s.orchestratorModel!, input: prompt, stream: true, temperature: 0 },
      (event) => {
        if (event.type === "reasoning.delta") store.getState().appendClarifyingThoughts(event.content);
        if (event.type === "message.delta") store.getState().appendClarifyingContent(event.content);
        if (event.type === "chat.end") store.getState().setOrchestratorResponseId(event.result.response_id);
      },
      (err) => { store.getState().setError(err.message); store.getState().setPhase("idle"); },
      () => {
        const s2 = store.getState();
        const decision = parseJsonEnvelope<ClarifyDecision>(s2.clarifyingMessages);
        if (!decision) {
          store.getState().setError(
            "The orchestrator didn't return a valid decision. Try again, or pick a model that follows JSON-only instructions more reliably."
          );
          store.getState().setPhase("idle");
          return;
        }
        const questions = normalizeQuestions(decision.questions);
        if (decision.needs_clarification && questions) {
          useSessionStore.setState({ clarifyingMessages: questions });
        } else {
          startPlanning(s2.orchestratorModel!, userInput);
        }
      },
      cancelRef.current?.signal,
    );
  }, [store]);

const handleStart = useCallback(async () => {
    // Phase stays "idle" through the awaits below, so without this guard a
    // second click / Enter would launch a second overlapping research run.
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
    const s = store.getState();
    const orchModel = s.orchestratorModel;
    const subModel = s.subagentModel;
    if (!orchModel || !subModel || !input.trim()) return;
    s.reset();
    resetMailbox();
    resetLiveEvents();
    clearDdgCache();
    resetDdgThrottle();
    clearSearxngCache();
    resetSearxngThrottle();
    resetBuiltinSearch();
    resetScrapeState();
    startedQueryRef.current = input;
    startedDepthRef.current = researchDepth;
    cancelRef.current = new AbortController();
    store.getState().setOrchestratorModel(orchModel);
    store.getState().setSubagentModel(subModel);
    store.getState().setMaxCycles(depthCycles[researchDepth]);

    // Resolve the toolset FRESH every session, rather than relying on the
    // mount-time useEffect that may have resolved before crw was ready or
    // may never re-run after a Cancel+Start cycle. This ensures the
    // web_search tool is always present in the dispatch map when subagents
    // start. (DDG search needs no handshake, so this succeeds even when crw
    // is down — crw is only used as automatic failover.)
    syncSearchRuntime();
    resetCrwSessionFlag();
    try {
      const s2 = store.getState();
      const resolved = await resolveToolset([
        webSearchToolSource(s2.crwUrl, s2.crwApiKey || undefined),
        mailboxToolSource(),
      ]);
      store.getState().setToolset(resolved);

      // Check that the unified web_search tool (not just mailbox tools) is
      // actually present. resolveToolset can silently skip a source that
      // threw — without web_search, subagents would get "Unknown tool" for
      // every search/scrape.
      const hasWebSearch = [...resolved.dispatch.entries()].some(
        ([, src]) => src.label === "web",
      );
      if (!hasWebSearch) {
        // Retry once with an extra delay — a transient import/init failure.
        await new Promise((r) => setTimeout(r, 2000));
        const retried = await resolveToolset([
          webSearchToolSource(s2.crwUrl, s2.crwApiKey || undefined),
          mailboxToolSource(),
        ]);
        store.getState().setToolset(retried);
        const hasWebRetry = [...retried.dispatch.entries()].some(
          ([, src]) => src.label === "web",
        );
        if (!hasWebRetry) {
          store.getState().setError(
            "Failed to initialize research tools. Reload the app and try again — if it persists, check your crw connection in Settings.",
          );
          return;
        }
      }
    } catch (err) {
      store.getState().setError(
        err instanceof Error ? err.message : "Failed to load research tools.",
      );
      return;
    }

    // Quick sanity-check that the selected models actually exist in the
    // configured backend before entering the clarifying stream.
    try {
      const models = await listModels();
      const modelIds = models.map((m) => m.key);
      const missing: string[] = [];
      if (orchModel && !modelIds.includes(orchModel)) missing.push(orchModel);
      if (subModel && !modelIds.includes(subModel)) missing.push(subModel);
      if (missing.length > 0) {
        const providerLabel = LLM_PROVIDERS[normalizeLlmProvider(store.getState().llmProvider)].label;
        const errMsg = `The following model(s) are no longer available in ${providerLabel}:\n${missing.join(", ")}\n\nOpen Settings, refresh the model list, and select a valid model.`;
        store.getState().setError(errMsg);
        return;
      }
    } catch {
      // listModels can fail if the backend is unreachable — let the clarifying
      // stream surface the real error instead.
    }

    runClarifying(input);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [input, store, runClarifying, researchDepth]);

  const handleCancel = useCallback(() => {
    cancelRef.current?.abort();
    cancelRef.current = null;
    resetMailbox();
    resetLiveEvents();
    const preservedToolset = useSessionStore.getState().toolset;
    useSessionStore.getState().reset();
    if (preservedToolset) useSessionStore.getState().setToolset(preservedToolset);
    setInput("");
    setSelectedAgentKey(null);
    setMobileView("list");
  }, []);

  const handleRestoreSession = useCallback((entry: HistoryEntry) => {
    restoringRef.current = true;
    resetLiveEvents();
    useSessionStore.getState().loadSession(entry);
    setInput(entry.query);
    // Keep the "started" refs pointed at the restored run: a recompile or a
    // history save after restore would otherwise label the result with the
    // *previous* session's query/depth.
    startedQueryRef.current = entry.query;
    startedDepthRef.current = entry.depth;
    setSelectedAgentKey(null);
  }, []);

  const handleDeleteEntry = useCallback((id: string) => {
    deleteEntry(id);
    setHistoryEntries(loadHistory());
  }, []);

  const handleClearAll = useCallback(() => {
    clearHistory();
    setHistoryEntries([]);
  }, []);

  /** Full export text: compiled report plus a generated Sources appendix so
   * the downloaded/copied file stands alone (the UI's Sources sheet doesn't
   * travel with a bare report). */
  const buildReportExport = useCallback((): string => {
    const s = store.getState();
    const report = s.compiledReport;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const agent of s.subagents) {
      for (const src of agent.sources ?? []) {
        if (src.status !== "success" || seen.has(src.url)) continue;
        seen.add(src.url);
        const label = src.title || src.url;
        lines.push(`- [${label}](${src.url}) (via ${formatSubagentId(agent.id)})`);
      }
    }
    if (lines.length === 0) return report;
    return `${report}\n\n---\n\n## Sources\n\n${lines.join("\n")}\n`;
  }, [store]);

  const handleCopyReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildReportExport());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      store.getState().setError("Copy failed — your browser blocked clipboard access.");
    }
  }, [buildReportExport, store]);

  const handleDownloadReport = useCallback(() => {
    const blob = new Blob([buildReportExport()], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `research-report-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildReportExport]);

  const handleClarifyAnswer = useCallback(async () => {
    if (!clarifyingAnswer.trim()) return;
    const s = store.getState();
    const answer = clarifyingAnswer;
    // Self-contained: the OpenAI-compatible provider ignores previous_response_id,
    // so this prompt must carry the original query and the questions already asked.
    const prompt = withDate(`[ROLE] You are a deep research agent.
[ORIGINAL QUERY] "${input}"
[YOUR CLARIFYING QUESTIONS AND THE CONVERSATION SO FAR]
${s.clarifyingMessages || "(none yet)"}
[LATEST USER RESPONSE] "${answer}"

Decide if you now have enough to research the original query, or need to ask more.
Respond with ONLY a single JSON object, no other text, no markdown fences:
{
  "needs_clarification": boolean,
  "questions": string[] | null
}
Ask again ONLY if a specific missing detail would materially change the research plan. If needs_clarification is true, each element of "questions" must be ONE self-contained plain-text question (no markdown, no embedded newlines, no numbering prefix -- the array index provides the ordering). Keep the array empty/null if no clarification is needed.`);
    setClarifyingAnswer("");
    store.getState().setClarifyingThoughts("");
    useSessionStore.setState((state) => ({
      clarifyingMessages: `${state.clarifyingMessages}\n\n**You:** ${answer}\n`,
    }));

    let rawReply = "";
    streamChat(
      { model: s.orchestratorModel!, input: prompt, stream: true, temperature: 0, previous_response_id: s.orchestratorResponseId },
      (event) => {
        if (event.type === "reasoning.delta") store.getState().appendClarifyingThoughts(event.content);
        if (event.type === "message.delta") rawReply += event.content;
        if (event.type === "chat.end") store.getState().setOrchestratorResponseId(event.result.response_id);
      },
      (err) => { store.getState().setError(err.message); },
      () => {
        const decision = parseJsonEnvelope<ClarifyDecision>(rawReply);
        if (!decision) {
          store.getState().setError(
            "The orchestrator didn't return a valid decision. Try again, or pick a model that follows JSON-only instructions more reliably."
          );
          return;
        }
        const questions = normalizeQuestions(decision.questions);
        if (decision.needs_clarification && questions) {
          useSessionStore.setState((state) => ({
            clarifyingMessages: `${state.clarifyingMessages}\n\n**Agent:** ${questions}`,
          }));
        } else {
          startPlanning(s.orchestratorModel!, input);
        }
      },
      cancelRef.current?.signal,
    );
  }, [clarifyingAnswer, input, store]);

const startPlanning = useCallback(async (model: string, query: string, priorReports?: string[]) => {
    const s = store.getState();
    s.setPhase("planning");
    playSound("planning");
    s.setPlan("");
    const gapContext = s.gapCheckNotes
      ? `\n\nGaps identified from the previous cycle that this new plan should address:\n${s.gapCheckNotes}`
      : "";
    const planPrompt = withDate(`Given this research query: "${query}"${gapContext}
Create a structured research plan by breaking the topic into ${priorReports?.length ? "2-3" : "2-4"} PARALLEL, genuinely distinct research angles -- never just one, even if the topic looks narrow at first glance. A single angle produces shallow, one-sided research; the whole point of parallel subagents is coverage a single pass would miss.

Good ways to split a topic into distinct angles (pick whichever fit this query):
- Different sub-questions or facets of the same topic (e.g. specs/performance vs. price/value vs. long-term reliability)
- Different perspectives on a contested topic (e.g. proponent/insider sources vs. critical/skeptical sources) -- required whenever the topic has a social, political, or normative dimension
- Different time periods, regions, or use-case segments
- Mainstream/consensus sources vs. specialist/niche sources on the same question

Each subagent's brief must be narrow enough that its research doesn't overlap or duplicate another subagent's -- if two briefs would send subagents to search near-identical queries, merge or re-split them.

Return ONLY a valid JSON array, no other text, no markdown fences. Each element:
{ "subagent_id": string, "brief": string, "focus_questions": string[] }

Use snake_case for subagent_id (e.g. "performance_analysis" not "performance-analysis").

Every brief must be derivable from the words in the actual query above -- if you notice yourself adding a sub-topic the query doesn't support, cut it rather than padding the plan to hit the target count. Fewer well-grounded angles beat a forced extra one.`);
    streamChat(
      { model, input: planPrompt, stream: true, temperature: 0 },
      (event) => {
        if (event.type === "message.delta") store.getState().appendPlan(event.content);
        if (event.type === "chat.end") store.getState().setOrchestratorResponseId(event.result.response_id);
      },
      (err) => { store.getState().setError(err.message); store.getState().setPhase("idle"); },
      () => {
        const nextCycle = store.getState().cycle + 1;
        runResearchCycle(model, query, nextCycle, priorReports ?? []);
      },
      cancelRef.current?.signal,
    );
  }, [store]);

  const runOneSubagent = useCallback(async (
    subModel: string,
    toolset: ResolvedToolset,
    agent: { id: string; key: string; brief: string },
    peers: PeerInfo[],
  ): Promise<string> => {
    const { id, key, brief } = agent;
    const sp = buildSubagentPrompt(id, key, brief, peers);
    try {
      let hitCap = false;
      const text = await runToolLoop({
        model: subModel,
        systemPrompt: sp,
        userInput: "Research and report findings.",
        toolset,
        temperature: 0,
        maxIterations: 16,
        subagentKey: key,
        signal: cancelRef.current?.signal,
        onEvent: (event) => {
          if (event.type === "error" && event.error.type === "iteration_cap") hitCap = true;
          pushLiveEvent(key, event);
          store.getState().addSubagentEvent(key, event);
        },
      });
      // Final drain: catch any peer messages that arrived after the tool
      // loop's own late drain but before deregister.
      const finalLate = drainInbox(key);
      if (finalLate.length > 0) {
        store.getState().addSubagentPeerMessages(key, finalLate);
      }
      store.getState().updateSubagent(key, { status: "done", report: text, hitIterationCap: hitCap, completedAt: Date.now() });
      mailboxDeregister(key);
      flushLiveEvents(key);
      return text;
    } catch (err) {
      // Also drain on error path.
      const errLate = drainInbox(key);
      if (errLate.length > 0) {
        store.getState().addSubagentPeerMessages(key, errLate);
      }
      store.getState().addSubagentEvent(key, {
        type: "error" as const,
        error: { type: "unknown", message: err instanceof Error ? err.message : String(err) },
      });
      store.getState().updateSubagent(key, { status: "done", report: "", completedAt: Date.now() });
      mailboxDeregister(key);
      flushLiveEvents(key);
      return "";
    }
  }, [store]);

  const runResearchCycle = useCallback(async (model: string, query: string, cycleNum: number, priorReports: string[]) => {
    const s = store.getState();
    let currentToolset = useSessionStore.getState().toolset;
    
    let attempts = 0;
    const maxAttempts = 20;
    while ((!currentToolset || currentToolset.tools.length === 0) && attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500));
      currentToolset = useSessionStore.getState().toolset;
      attempts++;
    }
    
    if (!currentToolset || currentToolset.tools.length === 0) {
      store.getState().setError(
        "No research tools are available -- check your crw connection in settings."
      );
      return;
    }

    const toolset = currentToolset;

s.setPhase("researching");
    playSound("researching");
    s.setCycle(cycleNum);
    const planText = s.plan;
    const planParsed = parseJsonEnvelope<PlanItem[] | PlanItem>(planText, true);
    let parsedPlan: PlanItem[] = Array.isArray(planParsed)
      ? planParsed
      : planParsed
        ? [planParsed]
        : [{ subagent_id: `agent-c${cycleNum}-1`, brief: `Research: ${query}` }];

    const minSubagents = cycleNum === 1 ? 2 : 1;
    if (parsedPlan.length < minSubagents && parsedPlan.length === 1) {
      const only = parsedPlan[0];
      parsedPlan = [
        { ...only, subagent_id: `${only.subagent_id}-a`, brief: `${only.brief} -- focus on mainstream/consensus sources and the most commonly cited findings.` },
        { ...only, subagent_id: `${only.subagent_id}-b`, brief: `${only.brief} -- focus on specialist, niche, or dissenting sources that mainstream coverage might miss, including any critical or skeptical perspectives.` },
      ];
    }

    const allAgents = parsedPlan.map((p) => ({
      id: p.subagent_id,
      key: subagentKey(cycleNum, p.subagent_id),
      brief: p.brief,
      questions: p.focus_questions ?? [],
    }));

    // Scope broadcast_to_peers to this cycle's roster before registering any
    // of its agents: prior-cycle agents already finished and were folded
    // into priorReports, so they should no longer be broadcast targets (see
    // resetCycleAgents doc comment in mailbox-local.ts). Messages already
    // queued in their inboxes are untouched -- this only affects who counts
    // as a recipient going forward.
    resetCycleAgents();
    for (const item of parsedPlan) {
      const key = subagentKey(cycleNum, item.subagent_id);
      store.getState().addSubagent({ key, id: item.subagent_id, brief: item.brief, status: "researching", events: [], cycle: cycleNum, sources: [], startedAt: Date.now() });
      mailboxRegister(key);
    }

    const results = await Promise.all(parsedPlan.map(async (item, i) => {
      const key = subagentKey(cycleNum, item.subagent_id);
      // Stagger subagent starts so N agents don't fire their first searches
      // in the same instant — cycle-start bursts are what get providers to
      // throttle. Later searches are paced by the tool loop itself.
      if (i > 0 && cancelRef.current && !cancelRef.current.signal.aborted) {
        await new Promise((r) => setTimeout(r, Math.min(i, 3) * 2000));
      }
      if (cancelRef.current?.signal.aborted) return "";
      const peers = allAgents.filter((a) => a.key !== key);
      return runOneSubagent(
        s.subagentModel!,
        toolset,
        { id: item.subagent_id, key, brief: item.brief },
        peers,
      );
    }));
    // A Cancel during the cycle must stick: without this guard the code
    // below would resurrect the run into gap-check after the user cancelled.
    if (cancelRef.current?.signal.aborted) return;
    runGapCheck(model, query, cycleNum, [...priorReports, ...results], parsedPlan);
  }, [store]);

const runGapCheck = useCallback(async (model: string, query: string, cycleNum: number, allReportsSoFar: string[], subagentPlan: PlanItem[]) => {
    const s = store.getState();
    s.setPhase("gap_check");
    playSound("gap_check");
    s.setGapCheckNotes("");
    const maxCycles = s.maxCycles;
    const reportText = allReportsSoFar
      .map((r, i) => `--- ${subagentPlan[i]?.subagent_id || "agent-" + (i + 1)} ---\n${r}`)
      .join("\n\n");
    const gapPrompt = withDate(`Original query: "${query}"
This is cycle ${cycleNum} of a maximum of ${maxCycles}.
Research reports gathered so far (all cycles combined):
${reportText}

Base this assessment only on the content of the reports above -- their source logs, stated gaps, and confidence flags -- not on outside knowledge of the topic or assumptions about what "should" be missing.

Respond with ONLY a single JSON object, no other text, no markdown fences:
{
  "answerable": boolean,
  "gaps": string[],
  "action": "compile" | "replan",
  "reason": string
}

A "gap" belongs in this list only if it's one of: (a) something a report's own Gaps section flagged as not found, (b) a focus question no report addressed at all, or (c) a claim carrying a confidence flag that materially affects the answer. Do not list a gap just because deeper coverage is hypothetically possible -- if reports already answer the query at reasonable confidence, that's sufficient.

If cycle ${cycleNum} is already the maximum (${maxCycles}), you MUST set "action" to "compile" regardless of gaps.
Otherwise, set "action" to "replan" only if the gaps are specific and reasonably resolvable with more research.`);
    let rawReply = "";
    streamChat(
      { model, input: gapPrompt, stream: true, temperature: 0, previous_response_id: s.orchestratorResponseId },
      (event) => {
        if (event.type === "message.delta") { rawReply += event.content; store.getState().appendGapCheckNotes(event.content); }
        if (event.type === "chat.end") store.getState().setOrchestratorResponseId(event.result.response_id);
      },
      (err) => { store.getState().setError(err.message); store.getState().setPhase("idle"); },
      () => {
        const decision = parseJsonEnvelope<GapCheckDecision>(rawReply);
        if (!decision) {
          store.getState().setError(
            "Gap-check didn't return a valid decision -- compiling with what we have rather than looping forever."
          );
          compileResults(model, query, allReportsSoFar, subagentPlan);
          return;
        }
        store.getState().setGapCheckNotes(
          decision.gaps.length ? decision.gaps.map((g) => `- ${g}`).join("\n") : "No significant gaps found."
        );
        store.getState().archiveCycle(cycleNum);
        if (decision.action === "replan" && cycleNum < maxCycles) {
          startPlanning(model, query, allReportsSoFar);
        } else {
          compileResults(model, query, allReportsSoFar, subagentPlan);
        }
      },
      cancelRef.current?.signal,
    );
  }, [store, startPlanning]);

const compileResults = useCallback(async (model: string, query: string, reports: string[], subagentPlan?: PlanItem[]) => {
    const s = store.getState();
    s.setPhase("compiling");
    playSound("compiling");
    setSelectedAgentKey(null);
    const undelivered = collectUndelivered();
    const compilePrompt = withDate(`Original query: "${query}"
Research findings:
${reports.map((r, i) => `--- ${subagentPlan?.[i]?.subagent_id || "Agent " + (i + 1)} ---\n${r}`).join("\n\n")}

${undelivered.length > 0 ? `\nPeer messages that never reached their destination subagent (include any relevant findings but note they were not incorporated by the intended recipient):\n${undelivered.join("\n---\n")}` : ""}

Each report above includes a numbered source log, inline source tags on claims, confidence flags, and a gaps list. Preserve that traceability through synthesis:

1. Executive summary
2. Key findings (by theme) -- carry forward source attribution; when merging claims from multiple agents that cite different sources, keep both citations visible rather than presenting it as a single unattributed fact
3. Evidence and details -- where an underlying report flagged low confidence or a single-source claim, carry that flag into this section rather than presenting it with unwarranted certainty
4. Open questions -- consolidate the Gaps sections from all reports into one list; don't drop them silently just because the rest of the query was answered
5. Conclusions -- draw conclusions only from what's stated in the findings above

HARD CONSTRAINTS:
- Do not introduce any claim, statistic, source, or quote that isn't traceable to a source tag in the reports above.
- Do not resolve a source conflict by silently picking one side -- if two agents' sources disagree, say so in the final report.
- If the combined findings don't fully answer the original query, say that plainly in the conclusions rather than smoothing over the gap with confident-sounding language.`);
    streamChat(
      { model, input: compilePrompt, stream: true, temperature: 0, previous_response_id: s.orchestratorResponseId },
      (event) => {
        if (event.type === "message.delta") store.getState().setCompiledReport(store.getState().compiledReport + event.content);
      },
      (err) => { store.getState().setError(err.message); store.getState().setPhase("done"); playSound("done"); },
      () => { store.getState().setPhase("done"); playSound("done"); },
      cancelRef.current?.signal,
    );
  }, [store, setSelectedAgentKey]);

  // Guards concurrent retries of the same agent (double-clicks, list+detail).
  const retryingRef = useRef<Set<string>>(new Set());

  const handleRetrySubagent = useCallback(async (agentKey: string) => {
    const s = store.getState();
    const agent = s.subagents.find((a) => a.key === agentKey);
    if (!agent || agent.status !== "done") return;
    if (retryingRef.current.has(agentKey)) return;
    const subModel = s.subagentModel;
    const toolset = s.toolset;
    if (!subModel || !toolset || toolset.tools.length === 0) {
      s.setError("Can't retry: no subagent model or research tools available.");
      return;
    }
    retryingRef.current.add(agentKey);
    try {
      // A fresh AbortController when the previous run already ended (its
      // signal may be aborted); reuse the live one mid-run so Cancel still
      // cancels the retry.
      if (!cancelRef.current || cancelRef.current.signal.aborted) {
        cancelRef.current = new AbortController();
      }
      mailboxRegister(agentKey);
      s.updateSubagent(agentKey, {
        status: "researching",
        report: undefined,
        hitIterationCap: undefined,
        startedAt: Date.now(),
        completedAt: undefined,
      });
      const peers: PeerInfo[] = s.subagents
        .filter((a) => a.cycle === agent.cycle && a.key !== agentKey)
        .map((a) => ({ id: a.id, key: a.key, brief: a.brief, questions: [] }));
      const wasDonePhase = s.phase === "done";
      if (wasDonePhase) {
        // Re-entering research from a finished run: show the active view.
        s.setPhase("researching");
        s.setCompiledReport("");
      }
      const text = await runOneSubagent(
        subModel,
        toolset,
        { id: agent.id, key: agentKey, brief: agent.brief },
        peers,
      );
      // If the retried agent salvaged a report after the run had already
      // compiled, recompile so the final report isn't stale. (Empty retry →
      // leave the old compiled report alone.)
      if (wasDonePhase && text && !cancelRef.current?.signal.aborted) {
        const after = useSessionStore.getState();
        const orchModel = after.orchestratorModel;
        if (orchModel) {
          const reports = after.subagents.map((a) => a.report ?? "");
          compileResults(orchModel, startedQueryRef.current || "research", reports);
        } else {
          after.setPhase("done");
        }
      }
    } finally {
      retryingRef.current.delete(agentKey);
    }
  }, [store, runOneSubagent, compileResults]);

  const totalSources = subagents.reduce((n, a) => n + (a.sources?.length || 0), 0);
  const isMobile = useIsMobile();

  // ============================================================
  // IDLE STATE
  // ============================================================
  if (phase === "idle") {
    return (
      <div className="relative flex flex-1 p-4 md:p-8 animate-fade-in">
        {/* History panel - overlay (does not push main content) */}
        <div
          className={`absolute inset-y-0 left-9 z-20 transition-all duration-300 ease-out ${historyOpen ? 'w-72 opacity-100' : 'w-0 opacity-0 pointer-events-none'}`}
        >
          <div className="h-full w-72 p-4 md:p-8 min-h-0">
            <HistoryPanel entries={historyEntries} onRestore={handleRestoreSession} onDelete={handleDeleteEntry} onClearAll={handleClearAll} />
          </div>
        </div>

        {/* History toggle button (same position when open or closed) */}
        <button
          onClick={() => setHistoryOpen(!historyOpen)}
          className={`absolute top-[26px] left-2 z-30 flex items-center justify-center size-7 rounded-lg border border-border/60 bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 hover:scale-110 active:scale-95 ${historyOpen ? 'opacity-100' : 'opacity-100'}`}
          aria-label={historyOpen ? "Hide history" : "Show history"}
        >
          {historyOpen ? <PanelLeft className="size-3.5" /> : <PanelRight className="size-3.5" />}
        </button>

        {/* Main content - centered */}
        <div className="flex-1 flex flex-col items-center overflow-y-auto min-w-0">
          <div className="w-full max-w-lg space-y-6 my-auto py-6">
            {/* Hero - logo next to greeting */}
            <div className="text-center animate-slide-up">
              <h1 className="inline-flex items-center gap-3 text-[28px] font-heading font-semibold text-foreground leading-tight">
                <img
                  src={resolvedTheme === "dark" ? "/logos/atlas-logo-blue.png" : "/logos/atlas-logo-orange.png"}
                  alt="Atlas"
                  className="size-10"
                />
                What would you like to research?
              </h1>
            </div>

            {/* Input composer — single cohesive card: textarea on top, depth
                selector and send in a footer row. */}
            <div className="animate-slide-up" style={{ animationDelay: "80ms" }}>
              <div className="rounded-2xl border border-border/60 bg-card shadow-elev-1 transition-all focus-within:border-primary/40 focus-within:shadow-elev-2">
                <Textarea
                  ref={queryInputRef}
                  placeholder="What are you curious about?"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  className="min-h-[52px] max-h-[40vh] resize-none border-0 bg-transparent px-4 pt-3.5 pb-2 shadow-none focus-visible:ring-0 text-sm leading-relaxed"
                  aria-label="Research query"
                  rows={1}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (canStart) handleStart();
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                />
                <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-2">
                  <div className="flex items-center rounded-lg border border-border/40 bg-muted/30 p-0.5" role="radiogroup" aria-label="Research depth">
                    {([
                      { key: "shallow", label: "Shallow", hint: "Quick pass — 2 cycles" },
                      { key: "standard", label: "Standard", hint: "Balanced — 3 cycles" },
                      { key: "deep", label: "Deep", hint: "Thorough — 5 cycles" },
                    ] as const).map((d) => {
                      const active = researchDepth === d.key;
                      return (
                        <button
                          key={d.key}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          title={d.hint}
                          onClick={() => setResearchDepth(d.key)}
                          className={cn(
                            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all",
                            active
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              d.key === "shallow" ? "bg-depth-shallow" : d.key === "standard" ? "bg-depth-standard" : "bg-depth-deep",
                              !active && "opacity-40",
                            )}
                          />
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={handleStart}
                    disabled={!canStart}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-lg shrink-0 transition-all",
                      canStart
                        ? "bg-primary text-primary-foreground hover:opacity-90 active:scale-95"
                        : "bg-muted text-muted-foreground/40 cursor-not-allowed"
                    )}
                    aria-label={starting ? "Starting research" : "Start research"}
                    title={starting ? "Starting research…" : "Start research"}
                  >
                    {starting ? <LoadingStandard size={12} /> : <ArrowRight className="size-4" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Example queries — populate the input on click so the empty
                state teaches what a good query looks like. */}
            {!input.trim() && (
              <div className="flex flex-wrap items-center justify-center gap-2 animate-slide-up" style={{ animationDelay: "100ms" }}>
                {[
                  "How do modern fusion reactors actually work?",
                  "What's holding solid-state batteries back?",
                  "Compare local-first sync engines for apps",
                ].map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setInput(ex)}
                    className="rounded-full border border-border/50 bg-card/60 px-3 py-1.5 text-xs text-muted-foreground transition-all hover:border-primary/40 hover:text-foreground hover:bg-muted/40 active:scale-95"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            )}

            {/* Prerequisites chips */}
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 animate-slide-up" style={{ animationDelay: "120ms" }}>
              {[
                { id: "orchestrator", done: !!hasOrchModel, label: "Orchestrator" },
                { id: "subagent", done: !!hasSubModel, label: "Subagent" },
                { id: "query", done: input.trim().length > 0, label: "Query" },
              ].map((step) => {
                // Unmet model prerequisites open Settings on click — the chip
                // tells you what's missing AND leads you to the fix.
                const openable = !step.done && step.id !== "query" && !!onSettingsClick;
                return (
                  <button
                    key={step.id}
                    type="button"
                    disabled={!openable}
                    onClick={openable ? onSettingsClick : undefined}
                    title={openable ? "Open Settings to select this model" : undefined}
                    className={cn(
                      "flex items-center gap-1.5 text-xs transition-colors",
                      step.done ? "text-foreground/70" : "text-muted-foreground/60",
                      openable && "cursor-pointer text-warning/80 underline-offset-2 hover:underline hover:text-warning"
                    )}
                  >
                    <CheckCircle2 className={cn(
                      "size-3",
                      step.done ? "text-success" : "text-warning/70"
                    )} />
                    {step.label}
                  </button>
                );
              })}
            </div>

            {/* Warnings */}
            {(!hasOrchModel || !hasSubModel) && (
              <button
                type="button"
                onClick={onSettingsClick}
                className="mx-auto flex items-center gap-1.5 text-xs text-warning/80 underline-offset-2 transition-colors hover:text-warning hover:underline animate-slide-up"
                style={{ animationDelay: "140ms" }}
              >
                <Brain className="size-3" />
                Select models in Settings to begin
              </button>
            )}
            {hasOrchModel && hasSubModel && toolsetError && (
              <div className="flex items-center gap-1.5 justify-center text-xs text-warning/80 animate-slide-up" style={{ animationDelay: "140ms" }}>
                <AlertTriangle className="size-3" />
                {toolsetError}
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive animate-slide-up" style={{ animationDelay: "140ms" }}>
                <div className="flex items-start gap-2">
                  <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                  <span className="whitespace-pre-wrap">{error}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // CLARIFYING STATE
  // ============================================================
  if (phase === "clarifying") {
    return (
      <div className="flex flex-1 flex-col overflow-hidden animate-fade-in">
        {/* Header */}
        <header className="flex items-center gap-4 border-b border-border/50 px-4 py-3 bg-card/50 backdrop-blur sticky top-0 z-10">
          <PhaseIndicator currentPhase={phase} />
          <div className="ml-auto flex items-center gap-2">
            {onSettingsClick && (
              <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={onSettingsClick} aria-label="Settings">
                <Settings className="size-4" />
              </Button>
            )}
            {error && <span className="text-sm text-destructive font-medium">{error}</span>}
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground" onClick={handleCancel}>
              <XCircle className="size-3" /> Cancel
            </Button>
          </div>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Thinking Panel */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            <div className="rounded-xl border border-border/20 p-4 md:p-5 space-y-4">
              <div className="flex items-center justify-between gap-4">
                <h2 className="font-heading text-base font-semibold text-foreground">Clarifying Questions</h2>
                {!clarifyingMessages && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <LoadingStandard />
                    Thinking…
                  </div>
                )}
              </div>

              {clarifyingThoughts && (
                <Collapsible defaultOpen className="rounded-lg border border-border/20 overflow-hidden">
                  <CollapsibleTrigger className="flex items-center gap-1.5 w-full text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors border-0 shadow-none focus-visible:ring-0 px-3 py-1.5 bg-muted/15">
                    Agent reasoning
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div
                      ref={thoughtScrollRef}
                      onScroll={handleThoughtScroll}
                      className="max-h-[50vh] overflow-y-auto overflow-x-hidden text-sm italic text-muted-foreground/80 break-words px-3 pb-2"
                    >
                      <Streamdown mode="streaming">{filterProceed(clarifyingThoughts)}</Streamdown>
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              )}
              
              {clarifyingMessages ? (
                <div className="text-sm leading-relaxed">
                  <Streamdown mode="streaming">{clarifyingMessages}</Streamdown>
                </div>
              ) : (!clarifyingThoughts && (
                <div className="flex h-48 items-center justify-center">
                  <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                    <LoadingStandard size={14} />
                    Waiting for clarifying questions…
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Answer Input */}
          <div className="border-t border-border/50 p-4">
            <div className="flex items-center gap-2 max-w-3xl mx-auto rounded-2xl border border-border/60 bg-card shadow-elev-1 px-4 py-2 focus-within:border-primary/40 focus-within:shadow-elev-2 transition-all">
              <Textarea
                placeholder="Answer the clarifying questions…"
                value={clarifyingAnswer}
                onChange={(e) => setClarifyingAnswer(e.target.value)}
                className="min-h-[24px] max-h-[40vh] resize-none border-0 bg-transparent px-3 py-0 shadow-none focus-visible:ring-0 text-sm leading-relaxed flex-1"
                aria-label="Your answer to clarifying questions"
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleClarifyAnswer();
                  }
                }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = el.scrollHeight + "px";
                }}
              />
              <button
                onClick={handleClarifyAnswer}
                disabled={!clarifyingAnswer.trim()}
                className={cn(
                  "flex size-9 items-center justify-center rounded-xl shrink-0 transition-all",
                  clarifyingAnswer.trim()
                    ? "bg-primary text-primary-foreground hover:opacity-90 active:scale-95"
                    : "bg-muted text-muted-foreground/40 cursor-not-allowed"
                )}
                aria-label="Send answer"
              >
                <Send className="size-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // DONE STATE
  // ============================================================
  if (phase === "done") {
    return (
      <div className="flex flex-1 flex-col overflow-hidden animate-fade-in">
      <header className="flex items-center justify-between border-b border-border/50 px-4 py-3 bg-card/50 backdrop-blur sticky top-0 z-10">
          <PhaseIndicator currentPhase={phase} />
          <div className="flex items-center gap-2">
            {subagents.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-xs text-muted-foreground"
                onClick={() => setSourcesOpen(true)}
                aria-label={`View sources (${totalSources})`}
              >
                <Globe className="size-3" />
                <span className="hidden sm:inline">Sources</span>
                <span className="inline sm:hidden">({totalSources})</span>
              </Button>
            )}
            {onSettingsClick && (
              <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={onSettingsClick} aria-label="Settings">
                <Settings className="size-4" />
              </Button>
            )}
            {compiledReport && (
              <>
                <Button variant="outline" size="sm" onClick={handleCopyReport}>
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadReport}
                >
                  <Download className="size-3" />
                  <span className="hidden sm:inline">Save Report</span>
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" onClick={() => { useSessionStore.getState().reset(); setInput(""); }}>
              <RotateCcw className="size-3" />
              <span className="hidden sm:inline">New Research</span>
            </Button>
          </div>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden p-4 md:p-6">
          <div className="mb-6 flex items-center gap-3">
            <CheckCircle2 className="size-6 text-success" />
            <div className="flex-1 min-w-0">
              <h2 className="font-heading text-xl font-semibold">Research Complete</h2>
              <p className="text-sm text-muted-foreground">
                Ran {cycle} cycle{cycle !== 1 ? "s" : ""} with {subagents.length} subagent{subagents.length !== 1 ? "s" : ""} • {totalSources} source{totalSources !== 1 ? "s" : ""}
              </p>
            </div>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="rounded-xl border border-border/20 p-4 md:p-5">
              {compiledReport ? (
                <Streamdown mode="streaming" className="prose prose-sm max-w-none text-sm leading-relaxed">{compiledReport}</Streamdown>
              ) : (
                <p className="text-muted-foreground">No report generated.</p>
              )}
            </div>
          </ScrollArea>
        </div>

        <SourcesSheet open={sourcesOpen} onOpenChange={setSourcesOpen} />
      </div>
    );
  }

  // ============================================================
  // ACTIVE RESEARCH STATES (planning, researching, gap_check, compiling)
  // ============================================================
  const selectedAgent = subagents.find((a) => a.key === selectedAgentKey);
  const activePhases = ["planning", "researching", "gap_check", "compiling"] as const;
  const isActivePhase = activePhases.includes(phase as any);

  return (
    <div className="flex flex-1 flex-col overflow-hidden animate-fade-in">
      {interrupted && (
        <div className="shrink-0 flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>
            Research was interrupted by a reload. Your progress is shown below, but the run can't resume on its own -- use{" "}
            <strong>Cancel</strong> (top-right) to start a new session.
          </span>
        </div>
      )}
      {/* Header */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/50 px-4 py-3 bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-3 flex-1 overflow-x-auto">
          <PhaseIndicator currentPhase={phase} />
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-xs text-muted-foreground shrink-0"
            onClick={() => setSourcesOpen(true)}
            aria-label={`View sources (${totalSources})`}
          >
            <Globe className="size-3" />
            <span className="hidden sm:inline">Sources</span>
            <span className="font-medium text-foreground tabular-nums">{totalSources}</span>
          </Button>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            Cycle <span className="font-medium text-foreground">{cycle}</span>/<span className="text-muted-foreground">{maxCycles}</span>
          </span>
          {error && <span className="text-sm text-destructive font-medium hidden sm:inline">{error}</span>}

          {onSettingsClick && (
            <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={onSettingsClick} aria-label="Settings">
              <Settings className="size-4" />
            </Button>
          )}
          
          {isMobile && isActivePhase && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={() => setMobileView(mobileView === "list" ? "detail" : "list")}
              aria-label={mobileView === "list" ? "Show detail" : "Show list"}
            >
              {mobileView === "list" ? <PanelRight className="size-4" /> : <PanelLeft className="size-4" />}
            </Button>
          )}

          <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground" onClick={handleCancel}>
            <XCircle className="size-3" />
            <span className="hidden sm:inline">Cancel</span>
          </Button>
        </div>
      </header>

      {/* Mobile: List View */}
      {(isMobile && mobileView === "list") && (
        <div className="flex-1 overflow-hidden">
          <MemoizedResearchListView
            phase={phase}
            cycle={cycle}
            maxCycles={maxCycles}
            plan={plan}
            gapCheckNotes={gapCheckNotes}
            subagents={subagents}
            compiledReport={compiledReport}
            selectedAgentKey={selectedAgentKey}
            setSelectedAgentKey={setSelectedAgentKey}
            mobileView={mobileView}
            setMobileView={setMobileView}
            onRetrySubagent={handleRetrySubagent}
          />
        </div>
      )}

      {/* Desktop / Mobile Detail: Split View */}
      {(isMobile && mobileView === "detail") && (
        <div className="flex-1 overflow-hidden">
          <MemoizedResearchDetailView
            phase={phase}
            cycle={cycle}
            maxCycles={maxCycles}
            plan={plan}
            gapCheckNotes={gapCheckNotes}
            subagents={subagents}
            compiledReport={compiledReport}
            selectedAgent={selectedAgent}
            selectedAgentKey={selectedAgentKey}
            setSelectedAgentKey={setSelectedAgentKey}
            mobileView={mobileView}
            setMobileView={setMobileView}
            onRetrySubagent={handleRetrySubagent}
          />
        </div>
      )}

      {!isMobile && (
        <div className="flex flex-1 overflow-hidden">
          {/* Left Panel - List */}
          <div className="flex w-full lg:w-1/2 min-w-0 flex-col gap-3 overflow-hidden p-4 lg:pr-2 transition-all duration-300">
            <MemoizedResearchListView
              phase={phase}
              cycle={cycle}
              maxCycles={maxCycles}
              plan={plan}
              gapCheckNotes={gapCheckNotes}
              subagents={subagents}
              compiledReport={compiledReport}
              selectedAgentKey={selectedAgentKey}
              setSelectedAgentKey={setSelectedAgentKey}
              mobileView={mobileView}
              setMobileView={setMobileView}
              onRetrySubagent={handleRetrySubagent}
            />
          </div>

          {/* Right Panel - Detail */}
          <div className={cn(
            "flex lg:w-1/2 min-w-0 flex-col overflow-hidden p-4 lg:pl-2 transition-all duration-300"
          )}>
            <MemoizedResearchDetailView
              phase={phase}
              cycle={cycle}
              maxCycles={maxCycles}
              plan={plan}
              gapCheckNotes={gapCheckNotes}
              subagents={subagents}
              compiledReport={compiledReport}
              selectedAgent={selectedAgent}
              selectedAgentKey={selectedAgentKey}
              setSelectedAgentKey={setSelectedAgentKey}
              mobileView={mobileView}
              setMobileView={setMobileView}
              onRetrySubagent={handleRetrySubagent}
            />
          </div>
        </div>
      )}

      {/* Sources Sheet */}
      <SourcesSheet open={sourcesOpen} onOpenChange={setSourcesOpen} />
    </div>
  );
}

// ============================================================
// LIST VIEW COMPONENT
// ============================================================
interface ResearchListViewProps {
  phase: string;
  cycle: number;
  maxCycles: number;
  plan: string;
  gapCheckNotes: string;
  subagents: any[];
  compiledReport: string;
  selectedAgentKey: string | null;
  setSelectedAgentKey: (key: string | null) => void;
  mobileView: "list" | "detail";
  setMobileView: (view: "list" | "detail") => void;
  onRetrySubagent: (key: string) => void;
}

function PlanView({ text }: { text: string }) {
  // Use the robust envelope extractor (same one runResearchCycle uses) rather
  // than raw JSON.parse, because the model often wraps the JSON in preamble
  // prose ("Here is my plan:\n[...]") that pure JSON.parse can't handle.
  const items = useMemo(() => {
    const parsed = parseJsonEnvelope<{ subagent_id: string; brief: string; focus_questions?: string[] }[]>(text, true);
    return Array.isArray(parsed) ? parsed : null;
  }, [text]);

  if (!items) {
    return <Streamdown mode="streaming" className="break-words text-sm leading-relaxed">{text}</Streamdown>;
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.subagent_id} className="rounded-lg border border-border/15 bg-muted/20 p-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 size-1.5 rounded-full bg-primary/60" />
            <div className="min-w-0">
              <div className="text-xs font-medium leading-tight">{formatSubagentId(item.subagent_id)}</div>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5 line-clamp-2">{item.brief}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResearchListView({
  phase,
  cycle: _cycle,
  maxCycles: _maxCycles,
  plan,
  gapCheckNotes,
  subagents,
  compiledReport: _compiledReport,
  selectedAgentKey,
  setSelectedAgentKey,
  mobileView,
  setMobileView,
  onRetrySubagent,
}: ResearchListViewProps) {
  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* Plan section */}
      <div className="rounded-xl border border-border/20 p-3.5 max-h-[40%] flex flex-col">
        <div className="flex items-center gap-2 pb-2 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider shrink-0">
          <ListChecks className="size-3.5" />
          Research Plan
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {plan ? <PlanView text={plan} /> : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoadingStandard size={14} />
              Generating plan…
            </div>
          )}
        </div>
      </div>

      {/* Gap check section */}
      {gapCheckNotes && (phase === "gap_check" || phase === "compiling" || phase === "researching") && (
        <div className="rounded-xl border border-border/20 p-3.5 flex-shrink-0">
          <div className="flex items-center gap-2 pb-2 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
            <FileSearch className="size-3.5" />
            Gap Check
          </div>
          <Streamdown mode="streaming" className="text-sm leading-relaxed">{gapCheckNotes}</Streamdown>
        </div>
      )}

      {/* Subagents section */}
      <div className="rounded-xl border border-border/20 p-3.5 flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 pb-2 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
          <Search className="size-3.5" />
          Subagents
          <Badge variant="outline" className="ml-auto text-xs">{subagents.length}</Badge>
        </div>
        <div className="flex-1 min-h-0 space-y-2 overflow-y-auto">
          {subagents.length === 0 ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoadingStandard size={14} />
              Spawning agents…
            </div>
          ) : (
                subagents.map((agent, idx) => (
                  <MemoizedSubagentListItem
                    key={agent.key}
                    agentKey={agent.key}
                    isSelected={selectedAgentKey === agent.key}
                    onSelect={() => {
                      setSelectedAgentKey(selectedAgentKey === agent.key ? null : agent.key);
                      if (mobileView === "list") setMobileView("detail");
                    }}
                    onRetry={onRetrySubagent}
                    style={{ animationDelay: `${idx * 60}ms` }}
                  />
                ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Re-render only when phase changes or selected agent key changes. The subagent
 * list prop is a new array every store update, but that shouldn't trigger a
 * re-render of the container -- individual items handle their own updates. */
function areListViewEqual(prev: ResearchListViewProps, next: ResearchListViewProps): boolean {
  if (prev.phase !== next.phase) return false;
  if (prev.selectedAgentKey !== next.selectedAgentKey) return false;
  // Only re-check plan/gapCheckNotes when they actually change content-wise.
  if (prev.plan !== next.plan) return false;
  if (prev.gapCheckNotes !== next.gapCheckNotes) return false;
  return true;
}

const MemoizedResearchListView = React.memo(ResearchListView, areListViewEqual);

// ============================================================
// SUBAGENT LIST ITEM — memoized, subscribes to its own subagent slice
// ============================================================

interface SubagentListItemProps {
  agentKey: string;
  isSelected: boolean;
  onSelect: () => void;
  onRetry: (key: string) => void;
  style?: React.CSSProperties;
}

function SubagentListItem({ agentKey, isSelected, onSelect, onRetry, style }: SubagentListItemProps) {
  const agent = useSessionStore((s) => s.subagents.find((a) => a.key === agentKey));

  if (!agent) return null;

  return (
    <div
      style={style}
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border transition-all duration-200 cursor-pointer animate-fade-in",
        isSelected
          ? "border-primary/50 bg-primary/[0.02]"
          : "border-border/60 hover:border-primary/30"
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }}}
    >
      <div className={cn("flex items-center gap-3 px-4 py-3 border-b border-border/40", isSelected ? "bg-primary/5" : "hover:bg-muted/50")}>
        <SubagentStatus agent={agent} />
        <div className="shrink-0">
          {agent.status === "pending" ? (
            <span className="block size-5 rounded-full bg-muted-foreground/20" aria-hidden />
          ) : (
            <ResearchingSwirl size={20} done={agent.status === "done"} />
          )}
        </div>
        <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", isSelected && "rotate-90")} />
      </div>

      <div className={cn("overflow-hidden transition-all duration-300", isSelected ? "max-h-96 opacity-100" : "max-h-0 opacity-0")}>
        <div className="p-4 space-y-3 border-t border-border/40">
          <p className="text-sm text-muted-foreground leading-relaxed">{agent.brief}</p>

          {agent.sources && agent.sources.length > 0 && (
            <SubagentSourceList sources={agent.sources} max={5} />
          )}

          {agent.status === "done" && agent.report && (
            <SubagentReport report={agent.report} hitIterationCap={agent.hitIterationCap} scrollable />
          )}

          {agent.status === "done" && (
            <div className="border-t border-border/30 pt-3 flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); onRetry(agent.key); }}
                className="flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                aria-label={`Retry ${agent.id}`}
              >
                <RotateCcw className="size-3" />
                {agent.report ? "Retry agent" : "Retry (no report)"}
              </button>
              {agent.status === "done" && !agent.report && (
                <span className="flex items-center gap-1.5 text-[11px] text-destructive/80">
                  <AlertTriangle className="size-3" />
                  Finished without a report
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const MemoizedSubagentListItem = React.memo(SubagentListItem);

// ============================================================
// DETAIL VIEW COMPONENT
// ============================================================
interface ResearchDetailViewProps {
  phase: string;
  cycle: number;
  maxCycles: number;
  plan: string;
  gapCheckNotes: string;
  subagents: any[];
  compiledReport: string;
  selectedAgent: any | null;
  selectedAgentKey: string | null;
  setSelectedAgentKey: (key: string | null) => void;
  mobileView: "list" | "detail";
  setMobileView: (view: "list" | "detail") => void;
  onRetrySubagent: (key: string) => void;
}

function ResearchDetailView({
  phase,
  cycle: _cycle,
  maxCycles: _maxCycles,
  plan: _plan,
  gapCheckNotes: _gapCheckNotes,
  subagents: _subagents,
  compiledReport,
  selectedAgent,
  selectedAgentKey: _selectedAgentKey,
  setSelectedAgentKey: _setSelectedAgentKey,
  mobileView: _mobileView,
  setMobileView: _setMobileView,
  onRetrySubagent,
}: ResearchDetailViewProps) {
  const isCompiling = phase === "compiling";
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const eventLogRef = useRef<HTMLDivElement>(null);
  const [eventUserScrolledUp, setEventUserScrolledUp] = useState(false);

  // Live, render-decoupled event stream for the selected subagent. This reads
  // from the in-memory buffer (live-events.ts) on a rAF loop so streaming stays
  // smooth even while the store is churning under crw/search latency. Falls
  // back to the store's persisted events when the buffer is empty (e.g. after
  // a reload).
  const liveEvents = useLiveEvents(selectedAgent?.key ?? null);
  const effectiveEvents =
    liveEvents.length > 0 ? liveEvents : (selectedAgent?.events ?? []);

  useEffect(() => {
    detailScrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selectedAgent?.events, selectedAgent?.report, compiledReport]);

  // Auto-follow the subagent event log as new events stream in, unless the
  // user has scrolled up to read something (then pause until they return to
  // the bottom). Reset the "paused" flag whenever a different agent is opened.
  useEffect(() => {
    setEventUserScrolledUp(false);
  }, [selectedAgent?.key]);

  useEffect(() => {
    if (eventUserScrolledUp) return;
    const el = eventLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [effectiveEvents, selectedAgent?.report, eventUserScrolledUp]);

  const handleEventLogScroll = useCallback(() => {
    const el = eventLogRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setEventUserScrolledUp(!atBottom);
  }, []);

  // Compile / report view — takes precedence over agent detail
  if (isCompiling || compiledReport) {
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 rounded-xl border border-border/20 p-3.5 flex flex-col">
          <div className="flex items-center gap-2 pb-3 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
            <FileSearch className={cn("size-3.5", isCompiling && "animate-pulse")} />
            Compiled Report
            {isCompiling && (
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground normal-case tracking-normal">
                <LoadingStandard size={10} />
                Compiling…
              </span>
            )}
          </div>
          {compiledReport ? (
            <ScrollArea className="flex-1 min-h-0">
              <div className="pr-4 prose prose-sm max-w-none text-sm leading-relaxed">
                <Streamdown mode="streaming">{compiledReport}</Streamdown>
                <div ref={detailScrollRef} />
              </div>
            </ScrollArea>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-4">
                <div className="mx-auto h-8 w-48 animate-shimmer rounded bg-gradient-to-r from-primary/5 via-primary/20 to-primary/5 bg-[length:200%_100%]" />
                <div className="mx-auto h-4 w-36 animate-shimmer rounded bg-gradient-to-r from-muted/30 via-muted/50 to-muted/30 bg-[length:200%_100%]" />
                <div className="mx-auto h-4 w-40 animate-shimmer rounded bg-gradient-to-r from-muted/30 via-muted/50 to-muted/30 bg-[length:200%_100%]" />
                <p className="text-sm text-muted-foreground">Synthesizing findings…</p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Waiting state — no agent selected, not compiling
  if (!selectedAgent) {
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 rounded-xl border border-border/20 p-3.5 flex flex-col">
          <div className="flex items-center gap-2 pb-3 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
            <Activity className="size-3.5 animate-pulse-soft" />
            In progress
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            {phase === "researching" ? (
              <ResearchingSwirl />
            ) : (
              <LoadingStandard size={16} />
            )}
            <p className="text-center max-w-[18rem]">
              {phase === "researching" ? "Subagents are researching…"
               : phase === "gap_check" ? "Reviewing findings for gaps…"
               : phase === "planning" ? "Generating research plan…"
               : "Preparing…"}
            </p>
            {(phase === "researching" || phase === "gap_check") && (
              <p className="text-center text-xs text-muted-foreground/60">
                Select a subagent on the left to watch its research live.
              </p>
            )}
          </div>
          </div>
        </div>
      </div>
    );
  }

  // Selected agent detail view
  const elapsedMs =
    selectedAgent?.startedAt != null
      ? (selectedAgent.completedAt ?? Date.now()) - selectedAgent.startedAt
      : undefined;
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 pb-3 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
        <FileText className="size-3.5" />
        <span className="truncate normal-case tracking-normal">{selectedAgent ? formatSubagentId(selectedAgent.id) : ""}</span>
        {selectedAgent && (
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground normal-case tracking-normal">
            {elapsedMs != null && <span title="Time spent researching">{formatDuration(elapsedMs)}</span>}
            <span>Cycle {selectedAgent.cycle}</span>
            {selectedAgent.status === "done" && (
              <button
                onClick={() => onRetrySubagent(selectedAgent.key)}
                className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium hover:bg-muted/50 hover:text-foreground transition-colors"
                aria-label={`Retry ${selectedAgent.id}`}
              >
                <RotateCcw className="size-3" />
                Retry
              </button>
            )}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 rounded-xl border border-border/20 p-3.5">
        <ScrollArea className="h-full">
          <div className="pr-4 space-y-4">
          {/* Sources */}
          {selectedAgent?.sources && selectedAgent.sources.length > 0 && (
            <SubagentSourceList sources={selectedAgent.sources} />
          )}

          {/* Peer messages */}
          {selectedAgent?.peerMessages && selectedAgent.peerMessages.length > 0 && (
            <div className="rounded-lg border border-border/50 bg-primary/[0.03] p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
                <MessageSquare className="size-3" />
                Peer Messages ({selectedAgent.peerMessages.length})
              </div>
              <div className="space-y-2">
                {selectedAgent.peerMessages.map((msg: string, i: number) => (
                  <div key={i} className="border-l-2 border-primary/30 pl-2 text-[11px] text-foreground/80 leading-relaxed">
                    {msg}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Event Timeline */}
          <div className="border-t border-border/20 pt-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground/70 mb-2">
              <Search className="size-3" />
              Event Log
            </div>
            <div ref={eventLogRef} onScroll={handleEventLogScroll} className="max-h-[500px] overflow-y-auto">
              <SSETimeline events={effectiveEvents} />
            </div>
          </div>

          {/* Final Report */}
          {selectedAgent?.status === "done" && selectedAgent?.report && (
            <SubagentReport report={selectedAgent.report} hitIterationCap={selectedAgent.hitIterationCap} />
          )}

          {selectedAgent?.status === "done" && !selectedAgent?.report && (
            <div className="border-t border-border/20 pt-3">
              <div className="flex items-center gap-2 text-xs font-medium text-destructive/80">
                <AlertTriangle className="size-3" />
                Subagent finished without a report — check the event log above for errors.
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
      </div>
    </div>
  );
}

/** Only re-render when: selected agent changes, compiled report updates, or
 * phase transitions (e.g. entering "compiling"). Ignore other prop changes
 * like subagent list updates that don't affect what this panel displays. */
function areEqual(prev: ResearchDetailViewProps, next: ResearchDetailViewProps): boolean {
  if (prev.selectedAgent?.key !== next.selectedAgent?.key) return false;
  if (prev.compiledReport !== next.compiledReport) return false;
  if (prev.phase !== next.phase) return false;
  return true;
}

const MemoizedResearchDetailView = React.memo(ResearchDetailView, areEqual);