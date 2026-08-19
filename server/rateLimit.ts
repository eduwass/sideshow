// Fixed-window rate limiter, in memory.
//
// The public service runs as a single Durable Object instance per workspace, so
// process memory is authoritative — the same reason the event bus is. Keep it
// that way: a distributed limiter would need coordination this deployment does
// not have.
//
// Fixed windows can admit up to 2x the limit across a window boundary. That is
// fine for what this guards (password guessing, feedback flooding): the point is
// to make an attack slow, not to meter precisely.

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Consume one unit for `key`. Returns false when the caller is over budget. */
  take(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size > 4096) this.prune(now);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  /** Seconds until `key`'s window resets, for a Retry-After header. */
  retryAfter(key: string, now: number = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }

  // Bounded memory: expired buckets are dropped once the map gets large, rather
  // than on a timer the Durable Object would have to keep alive.
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
