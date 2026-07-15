import type { SubagentState, CycleRecord } from "./store";

export interface HistoryEntry {
  id: string;
  query: string;
  timestamp: number;
  depth: "shallow" | "standard" | "deep";
  orchModel: string;
  subModel: string;
  cycle: number;
  maxCycles: number;
  plan: string;
  gapCheckNotes: string;
  cycleHistory: CycleRecord[];
  subagents: Omit<SubagentState, "events">[];
  compiledReport: string;
  clarifyingMessages: string;
  clarifyingThoughts: string;
  error: string | null;
}

const STORAGE_KEY = "deep-research-history";
const MAX_ENTRIES = 20;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

export function addEntry(entry: HistoryEntry): void {
  const entries = loadHistory();
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  saveHistory(entries);
}

export function deleteEntry(id: string): void {
  const entries = loadHistory().filter((e) => e.id !== id);
  saveHistory(entries);
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
