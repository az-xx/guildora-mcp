import { AsyncLocalStorage } from 'node:async_hooks';

export interface RateLimitWait {
  route: string;
  ms: number;
  global: boolean;
}

interface CallStore {
  waits: RateLimitWait[];
}

/** Per-tool-call context, so rate-limit waits can be reported in that call's result. */
const callContext = new AsyncLocalStorage<CallStore>();

/** Waits longer than this are rejected instead of queued, so a tool never hangs silently. */
export const MAX_QUEUED_WAIT_MS = 10_000;

export function runWithRateLimitTracking<T>(fn: () => Promise<T>): Promise<{
  value: T;
  waits: RateLimitWait[];
}> {
  const store: CallStore = { waits: [] };
  return callContext.run(store, async () => {
    const value = await fn();
    return { value, waits: store.waits };
  });
}

export function recordRateLimit(info: {
  route: string;
  retryAfter: number;
  global: boolean;
}): void {
  callContext
    .getStore()
    ?.waits.push({ route: info.route, ms: info.retryAfter, global: info.global });
}

export function describeWaits(waits: RateLimitWait[]): string | undefined {
  if (waits.length === 0) return undefined;
  const total = waits.reduce((sum, w) => sum + w.ms, 0);
  return `Note: Discord rate-limited ${waits.length} request(s) during this call; waited ${(total / 1000).toFixed(1)}s in total.`;
}
