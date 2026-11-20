/**
 * Keyed rate limiter shared by every outbound request the app makes on the
 * model's behalf.
 *
 * The research loop dispatches tool calls CONCURRENTLY (tool-loop.ts uses
 * Promise.all), so a single turn can fire a dozen searches/fetches at once.
 * Remote engines and sites punish that burst — DDG captchas, Mojeek 429s,
 * Bing starts serving challenge pages, and small sites see a mini-DDoS.
 *
 * One limiter instance governs one "lane" (an engine, or page fetches by
 * host). Each key inside the lane gets:
 *   - minimum spacing between request starts (with caller-supplied extra
 *     delay for robots.txt Crawl-delay),
 *   - a concurrency cap,
 *   - an optional sliding-window cap (requests per minute),
 *   - adaptive failure penalty + a fail-fast cooldown after sustained
 *     failure, so a blocked engine stops burning the turn's budget.
 *
 * Everything is module-level state: every subagent shares the same lanes,
 * which is the whole point — per-call pacing is useless when calls are
 * parallel.
 */

import { sleep } from "./fetch-timeout";

export interface RateLimitConfig {
  /** Minimum ms between the START of two requests for the same key. */
  minIntervalMs: number;
  /** Max in-flight requests for one key. */
  maxConcurrent: number;
  /** Sliding-window cap (paired with windowMs). */
  maxPerWindow?: number;
  windowMs?: number;
  /** Extra delay added per consecutive failure beyond the first. */
  failurePenaltyMs?: number;
  /** Ceiling for the adaptive failure penalty. */
  maxPenaltyMs?: number;
  /** Consecutive failures before the lane fails fast briefly. */
  cooldownAfter?: number;
  /** Base fail-fast duration (scaled by consecutive failures, capped). */
  cooldownMs?: number;
}

const DEFAULT_CONFIG: Required<RateLimitConfig> = {
  minIntervalMs: 0,
  maxConcurrent: 1,
  maxPerWindow: 0,
  windowMs: 60_000,
  failurePenaltyMs: 750,
  maxPenaltyMs: 8_000,
  cooldownAfter: 5,
  cooldownMs: 20_000,
};

/** Hard ceiling on a fail-fast cooldown, independent of penalty config. */
const COOLDOWN_MAX_MS = 5 * 60_000;

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  extraDelayMs: number;
}

interface KeyState {
  lastStart: number;
  active: number;
  queue: Waiter[];
  /** Start timestamps inside windowMs, oldest first. */
  starts: number[];
  consecutiveErrors: number;
  cooldownUntil: number;
  draining: boolean;
  requests: number;
  failures: number;
  throttledWaits: number;
}

export interface RateLimitKeyStats {
  key: string;
  active: number;
  queued: number;
  consecutiveErrors: number;
  cooldownRemainingMs: number;
  requests: number;
  failures: number;
  throttledWaits: number;
}

export interface RateLimitStats {
  lane: string;
  keys: RateLimitKeyStats[];
}

function newKeyState(): KeyState {
  return {
    lastStart: 0,
    active: 0,
    queue: [],
    starts: [],
    consecutiveErrors: 0,
    cooldownUntil: 0,
    draining: false,
    requests: 0,
    failures: 0,
    throttledWaits: 0,
  };
}

export class KeyedRateLimiter {
  private readonly lane: string;
  private config: Required<RateLimitConfig>;
  private current: RateLimitConfig;
  private readonly keys = new Map<string, KeyState>();

  constructor(lane: string, config: RateLimitConfig) {
    this.lane = lane;
    this.current = { ...config };
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Replace the effective policy (wired to Settings at runtime). */
  configure(patch: Partial<RateLimitConfig>): void {
    this.current = { ...this.current, ...patch };
    this.config = { ...DEFAULT_CONFIG, ...this.current };
  }

  getConfig(): RateLimitConfig {
    return { ...this.current };
  }

  /**
   * Reserve a slot for `key`. Resolves with an idempotent release function.
   * `extraDelayMs` (e.g. robots.txt Crawl-delay) is applied on top of the
   * configured spacing for this key only.
   */
  acquire(key: string, signal?: AbortSignal, extraDelayMs = 0): Promise<() => void> {
    const state = this.stateFor(key);
    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
        return;
      }
      state.queue.push({ resolve, reject, signal, extraDelayMs });
      void this.drain(key, state);
    });
  }

  /** Call after a request completes successfully — eases error pressure. */
  reportSuccess(key: string): void {
    const state = this.keys.get(key);
    if (!state) return;
    state.consecutiveErrors = Math.max(0, state.consecutiveErrors - 1);
  }

  /** Call after a request fails (network error or block-class response). */
  reportFailure(key: string): void {
    const state = this.stateFor(key);
    state.failures++;
    state.consecutiveErrors++;
    if (state.consecutiveErrors >= this.config.cooldownAfter) {
      // Cooldown grows with consecutive failures but is capped by its OWN
      // ceiling (5 min), not by maxPenaltyMs — that config value bounds the
      // adaptive *penalty*, and conflating the two let a small penalty cap
      // silently truncate long block cooldowns.
      const cool = Math.min(
        Math.max(this.config.cooldownMs, 1_000) * state.consecutiveErrors,
        COOLDOWN_MAX_MS,
      );
      state.cooldownUntil = Date.now() + cool;
    }
  }

  /** Remaining fail-fast time for a key, 0 when healthy. */
  cooldownRemainingMs(key: string): number {
    const state = this.keys.get(key);
    return state ? Math.max(0, state.cooldownUntil - Date.now()) : 0;
  }

  isCoolingDown(key: string): boolean {
    return this.cooldownRemainingMs(key) > 0;
  }

  stats(): RateLimitStats {
    const now = Date.now();
    return {
      lane: this.lane,
      keys: [...this.keys.entries()].map(([key, s]) => ({
        key,
        active: s.active,
        queued: s.queue.length,
        consecutiveErrors: s.consecutiveErrors,
        cooldownRemainingMs: Math.max(0, s.cooldownUntil - now),
        requests: s.requests,
        failures: s.failures,
        throttledWaits: s.throttledWaits,
      })),
    };
  }

  /** Clear counters/queues (new research session). Active requests finish. */
  reset(): void {
    for (const [key, state] of this.keys) {
      for (const waiter of state.queue) {
        waiter.reject(new Error("Rate limiter reset"));
      }
      // Keep counters/state for keys with an in-flight request so its
      // release() doesn't underflow `active`.
      if (state.active === 0) {
        this.keys.delete(key);
      } else {
        state.queue = [];
        state.starts = [];
        state.consecutiveErrors = 0;
        state.cooldownUntil = 0;
        state.lastStart = 0;
      }
    }
  }

  private stateFor(key: string): KeyState {
    let state = this.keys.get(key);
    if (!state) {
      state = newKeyState();
      this.keys.set(key, state);
    }
    return state;
  }

  /** Adaptive extra delay from recent failures (ms). */
  private penaltyMs(state: KeyState): number {
    const remaining = state.cooldownUntil - Date.now();
    if (remaining > 0) return remaining;
    if (state.consecutiveErrors >= 2) {
      return Math.min(
        Math.max(0, this.config.maxPenaltyMs),
        (state.consecutiveErrors - 1) * Math.max(0, this.config.failurePenaltyMs),
      );
    }
    return 0;
  }

  private pruneWindow(state: KeyState, now: number): void {
    if (!this.config.maxPerWindow || this.config.maxPerWindow <= 0) {
      state.starts.length = 0;
      return;
    }
    const cutoff = now - this.config.windowMs;
    while (state.starts.length > 0 && state.starts[0] <= cutoff) {
      state.starts.shift();
    }
  }

  private async drain(key: string, state: KeyState): Promise<void> {
    if (state.draining) return;
    state.draining = true;
    try {
      while (state.queue.length > 0) {
        const waiter = state.queue[0];
        if (waiter.signal?.aborted) {
          state.queue.shift();
          waiter.reject(waiter.signal.reason instanceof Error ? waiter.signal.reason : new Error("Aborted"));
          continue;
        }
        if (state.active >= Math.max(1, this.config.maxConcurrent)) {
          // A release() will call drain() again. Don't spin.
          break;
        }

        const now = Date.now();
        this.pruneWindow(state, now);

        const intervalDelay = Math.max(0, this.config.minIntervalMs) + Math.max(0, waiter.extraDelayMs);
        const sinceStart = now - state.lastStart;
        const waits = [intervalDelay - sinceStart, this.penaltyMs(state)];

        if (this.config.maxPerWindow && this.config.maxPerWindow > 0) {
          if (state.starts.length >= this.config.maxPerWindow) {
            waits.push(state.starts[0] + this.config.windowMs - now);
          }
        }
        const wait = Math.max(0, ...waits);
        if (wait > 0) {
          state.throttledWaits++;
          try {
            await sleep(wait, waiter.signal);
          } catch (err) {
            const idx = state.queue.indexOf(waiter);
            if (idx >= 0) state.queue.splice(idx, 1);
            waiter.reject(err);
            continue;
          }
          continue; // Re-evaluate: another waiter may have started.
        }

        state.queue.shift();
        state.lastStart = Date.now();
        state.active++;
        state.requests++;
        if (this.config.maxPerWindow && this.config.maxPerWindow > 0) {
          state.starts.push(state.lastStart);
        }

        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          state.active = Math.max(0, state.active - 1);
          void this.drain(key, state);
        });
      }
    } finally {
      state.draining = false;
    }
  }
}

const limiters = new Map<string, KeyedRateLimiter>();

/** Get (or lazily create) a named limiter lane. */
export function getLimiter(lane: string, config?: RateLimitConfig): KeyedRateLimiter {
  let limiter = limiters.get(lane);
  if (!limiter) {
    limiter = new KeyedRateLimiter(lane, config ?? DEFAULT_CONFIG);
    limiters.set(lane, limiter);
  } else if (config) {
    limiter.configure(config);
  }
  return limiter;
}

export function getLimiterStats(): RateLimitStats[] {
  return [...limiters.values()].map((l) => l.stats());
}
