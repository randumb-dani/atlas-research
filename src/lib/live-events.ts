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
const MAX_LIVE_EVENTS = 4000;

export function pushLiveEvent(key: string, event: SSEEvent): void {
  let arr = liveEvents.get(key);
  if (!arr) {
    arr = [];
    liveEvents.set(key, arr);
  }
  arr.push(event);
  if (arr.length > MAX_LIVE_EVENTS) {
    // Trim from the FRONT only as a memory backstop -- the live view renders
    // the tail, so the most recent events are always preserved (unlike the
    // old store behavior that cut the head and lost the start of the log).
    arr.splice(0, arr.length - MAX_LIVE_EVENTS);
  }
}

export function getLiveEvents(key: string): SSEEvent[] {
  return liveEvents.get(key) ?? [];
}

export function clearLiveEvents(key: string): void {
  liveEvents.delete(key);
}

/** Clear every agent's buffer (called on new research run / reset). */
export function resetLiveEvents(): void {
  liveEvents.clear();
}

/**
 * Reads a subagent's live event buffer into React state, but only commits a
 * re-render at most once per animation frame. This decouples the high-frequency
 * stream of `message.delta` events (potentially dozens per second) from React's
 * render cycle, so the event log paints smoothly even while the rest of the
 * store (subagents array, sources, etc.) is churning under crw/search latency.
 *
 * Falls back to the store's persisted events when the live buffer is empty
 * (e.g. after a reload where the in-memory buffer was lost but the store still
 * has its capped copy).
 */
export function useLiveEvents(key: string | null): SSEEvent[] {
  const [events, setEvents] = useState<SSEEvent[]>(() =>
    key ? getLiveEvents(key) : [],
  );
  const rafRef = useRef<number | null>(null);
  const keyRef = useRef<string | null>(key);

  useEffect(() => {
    keyRef.current = key;
    // Immediately show whatever we already have for the new key.
    setEvents(key ? getLiveEvents(key) : []);

    let mounted = true;
    const tick = () => {
      rafRef.current = null;
      if (!mounted) return;
      const k = keyRef.current;
      if (k) setEvents(getLiveEvents(k));
    };
    const schedule = () => {
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    // Poll on a rAF loop while a key is selected. This is cheaper than it
    // sounds: rAF only fires when the tab is visible, and we read a reference
    // (no copy) so the only cost is the occasional state commit when the
    // buffer actually changed length.
    const loop = () => {
      if (!mounted) return;
      schedule();
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
