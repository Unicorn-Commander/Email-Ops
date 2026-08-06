import { mapWithConcurrency, withTimeout, TimeoutError } from './concurrency';

describe('mapWithConcurrency', () => {
  it('returns settled results in ORIGINAL order across N=10 items', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 4, async (n) => {
      // Reverse the natural completion order (later items finish first) to prove
      // ordering is by index, not by completion.
      await new Promise((r) => setTimeout(r, (10 - n) * 2));
      return n * 10;
    });
    expect(results).toHaveLength(10);
    results.forEach((r, i) => {
      expect(r.status).toBe('fulfilled');
      if (r.status === 'fulfilled') expect(r.value).toBe(i * 10);
    });
  });

  it('never exceeds the concurrency limit (peak in-flight <= limit) over N=10', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it DID run concurrently, not serially
  });

  it('isolates failures: a rejecting task is one rejected slot, the rest fulfil', async () => {
    const items = [0, 1, 2, 3, 4];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  });

  it('clamps the limit and handles the empty list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
    // limit > length still works (clamped to length); limit 0 → 1.
    const r = await mapWithConcurrency([1, 2], 0, async (n) => n);
    expect(r.map((x) => (x.status === 'fulfilled' ? x.value : null))).toEqual([1, 2]);
  });
});

describe('withTimeout', () => {
  it('resolves when the work beats the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('rejects with TimeoutError when the work is too slow', async () => {
    const slow = new Promise((r) => setTimeout(() => r('late'), 100));
    await expect(withTimeout(slow, 20, 'mailbox read')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('a non-positive timeout disables the timer (returns the work unchanged)', async () => {
    await expect(withTimeout(Promise.resolve(7), 0)).resolves.toBe(7);
  });

  it('propagates the original rejection (not a timeout)', async () => {
    await expect(withTimeout(Promise.reject(new Error('real')), 50)).rejects.toThrow('real');
  });
});
