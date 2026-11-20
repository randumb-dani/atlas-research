import { useEffect, useRef, useState } from "react";
import type { SSEEvent } from "./types";

/**
 * Lightweight, render-decoupled buffer for live subagent event streaming.
 *
 * Problem this solves: the research UI previously pushed every streamed
 * `message.delta` / `tool_call.*` event straight into the Zustand store, and
 * the active-phase component subscribed to the ENTIRE `subagents` array. That
 * meant every token fired a full top-level React re-render of the split view;
 * under crw/search latency spikes those re-renders stall, so the live event
 * log APPEARS to stop updating even though the model (running in the
 * background `runToolLoop`) keeps producing events. The data was in the store,
 * but the view stopped painting new deltas.
 *
 * Fix: `runToolLoop` appends events here (a plain Map, no React involvement)
 * via `pushLiveEvent`. The detail panel reads the buffer through a
 * requestAnimationFrame-throttled local state (see `useLiveEvents`), so
 * streaming paints smoothly regardless of store churn. The store still
 * receives the same events for persistence/summary (see research-chat.tsx),
 * so nothing is lost on reload.
 */
const liveEvents = new Map<string, SSEEvent[]>();
const generations = new Map<string, number>();

export function pushLiveEvent(key: string, event: SSEEvent): void {
  let arr = liveEvents.get(key);
  if (!arr) {
    arr = [];
    liveEvents.set(key, arr);
  }
  arr.push(event);
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

export function getLiveEvents(key: string): SSEEvent[] {
  const arr = liveEvents.get(key);
  return arr ? [...arr] : [];
}

export function getGeneration(key: string): number {
  return generations.get(key) ?? 0;
}

/**
 * Flush (clear) a single subagent's live event buffer. Call this when a
 * subagent finishes its report — the in-memory buffer was only needed for the
 * live streaming view, and once the agent is done the store's capped copy
 * handles persistence and reload. Flushing early keeps memory bounded.
 */
export function flushLiveEvents(key: string): void {
  liveEvents.delete(key);
  generations.delete(key);
}

/** Clear every agent's buffer (called on new research run / reset). */
export function resetLiveEvents(): void {
  liveEvents.clear();
  // Generations must be cleared too: a stale generation makes useLiveEvents
  // believe an empty buffer is current and skip painting real events.
  generations.clear();
}

/**
 * Reads a subagent's live event buffer into React state, but only commits a
 * re-render when the buffer has actually grown (tracked via a generation
 * counter). This avoids copying the entire buffer on every animation frame
 * just to check if something changed — we do one cheap integer comparison per
 * frame and only copy+setState when the generation advanced.
 *
 * Falls back to the store's persisted events when the live buffer is empty
 * (e.g. after a reload where the in-memory buffer was lost but the store still
 * has its capped copy).
 */
export function useLiveEvents(key: string | null): SSEEvent[] {
  const [events, setEvents] = useState<SSEEvent[]>(() =>
    key ? getLiveEvents(key) : [],
  );
  const genRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const keyRef = useRef<string | null>(key);

  useEffect(() => {
    keyRef.current = key;
    if (key) {
      genRef.current = getGeneration(key);
      setEvents(getLiveEvents(key));
    } else {
      setEvents([]);
    }

    let mounted = true;
    const loop = () => {
      if (!mounted) return;
      const k = keyRef.current;
      if (k) {
        const curGen = getGeneration(k);
        if (curGen !== genRef.current) {
          genRef.current = curGen;
          setEvents(getLiveEvents(k));
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      mounted = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [key]);

  return events;
}
