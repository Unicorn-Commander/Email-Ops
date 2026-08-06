/**
 * Small async primitives for bounded fan-out.
 *
 * The webmail unified-inbox / counts endpoints fan out across every workspace
 * mailbox. With ~10 mailboxes (several of them slow external providers) an
 * unbounded `Promise.allSettled(map)` fires 10+ engine calls at once and — worse
 * — waits for the SLOWEST one before it can return anything. These two helpers
 * bound both dimensions:
 *
 *   - mapWithConcurrency: run at most `limit` tasks at a time, preserving
 *     result order + never throwing (settled results, like Promise.allSettled).
 *   - withTimeout: reject a per-task promise after `ms` so one wedged provider
 *     can't stall the whole aggregate — it just becomes a rejected slot the
 *     caller degrades over.
 *
 * No dependencies; unit-tested in concurrency.spec.ts.
 */

/** Raised by withTimeout when the wrapped work doesn't settle in time. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject `work` with a TimeoutError after `ms` (a non-positive `ms` disables the
 * timeout and returns `work` unchanged). The timer is always cleared so a
 * resolved/rejected promise never leaves a dangling handle.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  if (!(ms > 0)) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Map `items` through `fn` with at most `limit` in flight at once, returning a
 * settled result PER ITEM in the ORIGINAL order (so `results[i]` lines up with
 * `items[i]`). Never throws — a rejecting `fn` yields a `{ status: 'rejected' }`
 * slot, exactly like `Promise.allSettled`. `limit` is clamped to `[1, items.length]`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const n = items.length;
  const results = new Array<PromiseSettledResult<R>>(n);
  if (n === 0) return results;
  const cap = Math.max(1, Math.min(Math.trunc(limit) || 1, n));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= n) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
