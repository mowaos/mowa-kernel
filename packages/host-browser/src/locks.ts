/**
 * Concurrency Mutex Subsystem for MO·WA OS Browser Host.
 *
 * Wraps the Web Locks API (`navigator.locks`) to serialize the complete
 * read-compute-write cycle per session (`session:<id>`), eliminating CAS
 * retries completely within a browser profile.
 */

export interface SessionLock {
  acquire<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Browser-native session lock using Web Locks API (`navigator.locks`).
 */
export class WebLocksSessionLock implements SessionLock {
  async acquire<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    if (typeof navigator === "undefined" || !navigator.locks) {
      throw new Error(
        "Web Locks API (navigator.locks) is not available in the current environment"
      );
    }

    const lockName = `session:${sessionId}`;
    return navigator.locks.request(lockName, async () => {
      return await fn();
    });
  }
}

/**
 * Deterministic in-memory FIFO queue lock for testing/Node environments.
 */
export class MemorySessionLock implements SessionLock {
  private readonly queues = new Map<string, Promise<unknown>>();

  async acquire<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();

    let resolveNext: () => void;
    const next = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });

    this.queues.set(sessionId, next);

    try {
      await previous;
      return await fn();
    } finally {
      resolveNext!();
      if (this.queues.get(sessionId) === next) {
        this.queues.delete(sessionId);
      }
    }
  }
}
