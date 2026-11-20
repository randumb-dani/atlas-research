/**
 * Timeout + abort plumbing shared by every network call in the app
 * (MCP/crw, LM Studio streams, DDG search/fetch).
 *
 * Before this module, `rpcCall` (mcp-client.ts) and both streaming clients
 * had NO timeout at all: a hung SearXNG backend or a stalled LM Studio
 * response would hang its caller forever with nothing in the event log.
 * Every new network call should take an `AbortSignal` and a `timeoutMs`
 * via `linkSignals` below.
 */

import { httpFetch } from "./http";

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** True for aborts AND timeouts — i.e. "stop everything" conditions. */
export function isCancelLike(err: unknown): boolean {
  return isAbortError(err) || err instanceof TimeoutError;
}

export interface LinkedSignal {
  signal: AbortSignal;
  /** Call to release the internal timer/listeners early. */
  cancel: () => void;
}

/**
 * Combines any number of parent signals with an optional timeout into a
 * single signal. If the timeout fires first the linked controller aborts
 * with a `TimeoutError` as its reason, so `await fetch(url, { signal })`
 * rejects with something distinguishable from a user Cancel.
 */
export function linkSignals(
  parents: (AbortSignal | undefined | null)[],
  timeoutMs?: number,
): LinkedSignal {
  const controller = new AbortController();

  // Already aborted? Reflect it immediately.
  for (const parent of parents) {
    if (parent?.aborted) {
      controller.abort(parent.reason);
      return { signal: controller.signal, cancel: () => {} };
    }
  }

  const onParentAbort = () => {
    const reason = parents.find((p) => p?.aborted)?.reason;
    controller.abort(reason);
  };
  for (const parent of parents) {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs !== undefined && timeoutMs > 0 && timeoutMs !== Infinity) {
    timer = setTimeout(() => {
      controller.abort(new TimeoutError(`Timed out after ${timeoutMs}ms`, timeoutMs));
    }, timeoutMs);
    // Don't keep the process alive for a timer nobody will clear (harmless in
    // browsers, matters under some Tauri/node shims).
    const t = timer as unknown as { unref?: () => void };
    t.unref?.();
  }

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    for (const parent of parents) {
      parent?.removeEventListener("abort", onParentAbort);
    }
  };
  return { signal: controller.signal, cancel };
}

/** Thrown when an LLM stream produces no output for too long. */
export class StallTimeoutError extends Error {
  readonly kind: "time-to-first-token" | "inter-token";
  constructor(kind: "time-to-first-token" | "inter-token", afterMs: number) {
    super(
      kind === "time-to-first-token"
        ? `Model produced no output for ${Math.round(afterMs / 1000)}s (is it still loading?).`
        : `Model stopped producing output for ${Math.round(afterMs / 1000)}s (stream stalled).`,
    );
    this.name = "StallTimeoutError";
    this.kind = kind;
  }
}

export interface StallTimeouts {
  /** Max wait for the first byte of a stream. Default 180s (cold model loads are slow). */
  timeToFirstTokenMs?: number;
  /** Max gap between received chunks once streaming. Default 120s. */
  interTokenMs?: number;
}

export const DEFAULT_STALL_TIMEOUTS: Required<StallTimeouts> = {
  timeToFirstTokenMs: 180_000,
  interTokenMs: 120_000,
};

/**
 * Watchdog for SSE streams. `progress()` must be called on every received
 * chunk; if the gap exceeds the budget, `onStall` fires once.
 */
export class StallWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;
  private readonly onStall: (kind: "time-to-first-token" | "inter-token") => void;
  private readonly timeouts: Required<StallTimeouts>;

  constructor(
    onStall: (kind: "time-to-first-token" | "inter-token") => void,
    timeouts: Required<StallTimeouts> = DEFAULT_STALL_TIMEOUTS,
  ) {
    this.onStall = onStall;
    this.timeouts = timeouts;
    this.arm("time-to-first-token", this.timeouts.timeToFirstTokenMs);
  }

  private arm(kind: "time-to-first-token" | "inter-token", ms: number) {
    this.clear();
    this.timer = setTimeout(() => {
      this.fired = true;
      this.onStall(kind);
    }, ms);
    const t = this.timer as unknown as { unref?: () => void };
    t.unref?.();
  }

  /** Call whenever any bytes arrive on the stream. */
  progress() {
    if (!this.fired) this.arm("inter-token", this.timeouts.interTokenMs);
  }

  done() {
    this.clear();
  }

  private clear() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Resolves after `ms`, rejecting early if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason instanceof Error ? signal!.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `sleep` with +/-20% jitter, for backoff between retries. */
export function sleepJittered(ms: number, signal?: AbortSignal): Promise<void> {
  const jittered = ms * (0.8 + Math.random() * 0.4);
  return sleep(jittered, signal);
}

/**
 * Runs `task` with an overall deadline. The task receives a dedicated
 * signal that aborts on timeout (so in-flight fetches unwind instead of
 * dangling) and mirrors any outer abort. Rejects with TimeoutError on
 * deadline, or the outer abort reason on cancel.
 */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  outerSignal?: AbortSignal,
): Promise<T> {
  if (outerSignal?.aborted) {
    throw outerSignal.reason instanceof Error ? outerSignal.reason : new Error("Aborted");
  }
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await Promise.race([
      task(controller.signal),
      (async (): Promise<T> => {
        await sleep(ms, outerSignal);
        const err = new TimeoutError(`${label} timed out after ${ms}ms`, ms);
        controller.abort(err);
        throw err;
      })(),
    ]);
  } finally {
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * `fetch` that always enforces a timeout. Returns the raw Response so
 * callers (including SSE stream readers) keep working unchanged.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init;
  const linked = linkSignals([signal ?? undefined], timeoutMs);
  try {
    return await httpFetch(input, { ...rest, signal: linked.signal });
  } catch (err) {
    // Tauri's plugin-http may surface a timed-out abort as a generic Error
    // rather than an AbortError — normalize via our own signal state.
    if (linked.signal.aborted && linked.signal.reason instanceof TimeoutError) {
      throw linked.signal.reason;
    }
    throw err;
  } finally {
    linked.cancel();
  }
}
