/**
 * Concurrency control utilities for parallel execution
 *
 * Provides semaphore-based concurrency limiting to control
 * the number of simultaneous async operations.
 */

/**
 * A concurrency limiter using semaphore pattern
 *
 * Limits the number of concurrent async operations to a specified maximum.
 * Tasks beyond the limit are queued and executed as slots become available.
 *
 * @example
 * ```typescript
 * const limiter = new ConcurrencyLimiter(3);
 *
 * // These will run with max 3 concurrent
 * const results = await Promise.all([
 *   limiter.run(() => fetchData(1)),
 *   limiter.run(() => fetchData(2)),
 *   limiter.run(() => fetchData(3)),
 *   limiter.run(() => fetchData(4)), // Waits for a slot
 * ]);
 * ```
 */
export class ConcurrencyLimiter {
  private currentConcurrent = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<() => void> = [];

  /**
   * Create a new concurrency limiter
   *
   * @param maxConcurrent - Maximum number of concurrent operations (must be >= 1)
   * @throws Error if maxConcurrent is less than 1
   */
  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error('maxConcurrent must be at least 1');
    }
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Run an async operation with concurrency limiting
   *
   * If the current number of concurrent operations is at the limit,
   * the operation will be queued until a slot becomes available.
   *
   * @param fn - Async function to execute
   * @returns Promise resolving to the function's return value
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();

    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Acquire a slot, waiting if necessary
   */
  private async acquire(): Promise<void> {
    if (this.currentConcurrent < this.maxConcurrent) {
      this.currentConcurrent++;
      return;
    }

    // Wait for a slot to become available
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release a slot, unblocking a queued task if any
   */
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Pass the slot to the next waiting task
      next();
    } else {
      this.currentConcurrent--;
    }
  }

  /**
   * Get the current number of concurrent operations
   */
  get activeTasks(): number {
    return this.currentConcurrent;
  }

  /**
   * Get the number of tasks waiting in queue
   */
  get queuedTasks(): number {
    return this.queue.length;
  }
}

/**
 * Helper function to run async operations with concurrency limit
 *
 * Convenience wrapper for common use case of running multiple operations
 * with a concurrency limit.
 *
 * @param tasks - Array of async functions to execute
 * @param maxConcurrent - Maximum concurrent operations (default: 3)
 * @returns Promise resolving to array of results (preserves order)
 *
 * @example
 * ```typescript
 * const urls = ['url1', 'url2', 'url3', 'url4'];
 * const results = await withConcurrencyLimit(
 *   urls.map(url => () => fetch(url)),
 *   2 // Max 2 concurrent fetches
 * );
 * ```
 */
export async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent = 3
): Promise<T[]> {
  const limiter = new ConcurrencyLimiter(maxConcurrent);
  return Promise.all(tasks.map(task => limiter.run(task)));
}

/**
 * Run async operations with concurrency limit, settling all promises
 *
 * Like `withConcurrencyLimit` but uses `Promise.allSettled` semantics,
 * returning results for all tasks even if some fail.
 *
 * @param tasks - Array of async functions to execute
 * @param maxConcurrent - Maximum concurrent operations (default: 3)
 * @returns Promise resolving to array of settled results
 */
export async function withConcurrencyLimitSettled<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent = 3
): Promise<PromiseSettledResult<T>[]> {
  const limiter = new ConcurrencyLimiter(maxConcurrent);
  return Promise.allSettled(tasks.map(task => limiter.run(task)));
}
