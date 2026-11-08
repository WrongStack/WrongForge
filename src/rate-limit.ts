/**
 * Per-client sliding-window rate limiter for the costing surfaces
 * (task submit + proxy /v1/messages*).
 *
 * Only ALLOWED requests consume budget — a rejected request must not extend
 * its own window (that would turn a temporary limit into a self-perpetuating
 * one). Arrays are bounded by the limit; a client that goes quiet leaves a
 * small stale array that is pruned on its next hit. Scoped to named client
 * keys by the caller — the default/admin key is never limited.
 */

export interface HitResult {
  allowed: boolean;
  /** Seconds until the oldest counted request leaves the window (429s only). */
  retryAfterSec: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    /** Max requests per window per key. 0 = unlimited (everything allowed). */
    readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  hit(key: string, now = Date.now()): HitResult {
    if (this.limit <= 0) return { allowed: true, retryAfterSec: 0 };
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr); // store the pruned array so retryAfterSec is exact
      const oldest = arr[0]!;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { allowed: true, retryAfterSec: 0 };
  }
}
