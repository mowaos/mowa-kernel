/**
 * Outbox Dispatcher Subsystem for MO·WA OS Browser Host.
 *
 * Runs asynchronously outside the session lock to dispatch side effects.
 * Supports:
 *   - At-least-once delivery with deterministic effect.id deduplication.
 *   - True exponential backoff with jitter and Dead-Letter Queue (`FAILED_DLQ`).
 *   - "Pre-fill & Confirm" UI gating pattern with `AWAIT_CONFIRMATION` status segregation.
 *   - Grace period handling for unhandled effect kinds (prevents queue deadlock).
 *   - Operator recovery APIs: `requeueEffect`, `rejectEffect`, and `getNextDueAt`.
 */

import type { MowaStorage } from "./storage.js";
import type { OutboxRecord } from "./types.js";

export type EffectExecutionResult =
  | "SUCCESS"
  | "AWAIT_CONFIRMATION" // Action prompt awaiting operator approval (attempts NOT incremented)
  | "RETRY";

export type EffectHandler = (record: OutboxRecord) => Promise<EffectExecutionResult>;

export interface OutboxDispatcherOptions {
  maxAttempts?: number;
  batchSize?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  unhandledGraceIntervalMs?: number;
  maxUnhandledGraceMs?: number;
}

export class OutboxDispatcher {
  private readonly handlers = new Map<string, EffectHandler>();
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly unhandledGraceIntervalMs: number;
  private readonly maxUnhandledGraceMs: number;
  private isRunning = false;

  constructor(
    private readonly storage: MowaStorage,
    options: OutboxDispatcherOptions = {}
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.batchSize = options.batchSize ?? 20;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.unhandledGraceIntervalMs = options.unhandledGraceIntervalMs ?? 5000;
    this.maxUnhandledGraceMs = options.maxUnhandledGraceMs ?? 60000;
  }

  registerHandler(kind: string, handler: EffectHandler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * Calculates exponential backoff with ±10% jitter:
   * delay = min(maxBackoff, base * 2^(attempts-1)) * (0.9 to 1.1)
   */
  private calculateBackoff(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    const base = this.baseBackoffMs * Math.pow(2, exponent);
    const capped = Math.min(this.maxBackoffMs, base);
    const jitter = 0.9 + Math.random() * 0.2; // 0.9 to 1.1
    return Math.round(capped * jitter);
  }

  /**
   * Returns earliest timestamp when a pending outbox record is due, or null if none pending.
   * Host or extension can inspect this to schedule alarms (e.g. via chrome.alarms).
   */
  async getNextDueAt(): Promise<number | null> {
    return await this.storage.getNextDueAt();
  }

  /**
   * Called when a human operator reviews and confirms an action.
   * Verifies the effect is in `AWAIT_CONFIRMATION` before marking `DISPATCHED`.
   */
  async confirmEffect(outboxId: string): Promise<void> {
    const record = await this.storage.getOutbox(outboxId);
    if (!record) {
      throw new Error(`Outbox effect '${outboxId}' not found.`);
    }
    if (record.status !== "AWAIT_CONFIRMATION") {
      throw new Error(
        `Cannot confirm effect '${outboxId}': status is '${record.status}', expected 'AWAIT_CONFIRMATION'.`
      );
    }

    await this.storage.updateOutboxStatus(outboxId, "DISPATCHED", {
      lastAttemptAt: Date.now(),
    });
  }

  /**
   * Called when an operator explicitly rejects an action awaiting confirmation.
   */
  async rejectEffect(outboxId: string, reason: string): Promise<void> {
    const record = await this.storage.getOutbox(outboxId);
    if (!record) {
      throw new Error(`Outbox effect '${outboxId}' not found.`);
    }
    if (record.status !== "AWAIT_CONFIRMATION") {
      throw new Error(
        `Cannot reject effect '${outboxId}': status is '${record.status}', expected 'AWAIT_CONFIRMATION'.`
      );
    }

    await this.storage.updateOutboxStatus(outboxId, "REJECTED", {
      lastAttemptAt: Date.now(),
      lastError: reason,
    });
  }

  /**
   * Operator recovery API: requeues an effect from `FAILED_DLQ` back to `PENDING`.
   */
  async requeueEffect(outboxId: string): Promise<void> {
    const record = await this.storage.getOutbox(outboxId);
    if (!record) {
      throw new Error(`Outbox effect '${outboxId}' not found.`);
    }
    if (record.status !== "FAILED_DLQ") {
      throw new Error(
        `Cannot requeue effect '${outboxId}': status is '${record.status}', expected 'FAILED_DLQ'.`
      );
    }

    const now = Date.now();
    await this.storage.updateOutboxStatus(outboxId, "PENDING", {
      attempts: 0,
      nextAttemptAt: now,
      lastError: undefined,
      unhandledSince: undefined,
    });
  }

  /**
   * Drain pending outbox records asynchronously outside the session lock.
   */
  async dispatchPending(): Promise<{ processed: number; failed: number; pending: number }> {
    if (this.isRunning) {
      return { processed: 0, failed: 0, pending: 0 };
    }
    this.isRunning = true;

    let processed = 0;
    let failed = 0;
    let pending = 0;

    try {
      const now = Date.now();
      const records = await this.storage.getPendingOutbox(this.batchSize, now);

      for (const record of records) {
        const handler = this.handlers.get(record.effect.kind);
        if (!handler) {
          // Effect kind has no handler registered.
          // In MV3 service workers, handlers might register after initial wake-up.
          // Push nextAttemptAt forward so it leaves the due window without blocking other records.
          const unhandledSince = record.unhandledSince ?? now;
          if (now - unhandledSince >= this.maxUnhandledGraceMs) {
            await this.storage.updateOutboxStatus(record.outboxId, "FAILED_DLQ", {
              lastAttemptAt: now,
              lastError: `UNHANDLED_EFFECT_KIND: No handler registered for '${record.effect.kind}' within grace period`,
            });
            failed++;
          } else {
            await this.storage.updateOutboxStatus(record.outboxId, "PENDING", {
              nextAttemptAt: now + this.unhandledGraceIntervalMs,
              unhandledSince,
            });
            pending++;
          }
          continue;
        }

        try {
          // Attempt dispatch
          const result = await handler(record);

          if (result === "SUCCESS") {
            // Success: mark DISPATCHED without incrementing retry attempts
            await this.storage.updateOutboxStatus(record.outboxId, "DISPATCHED", {
              lastAttemptAt: Date.now(),
            });
            processed++;
          } else if (result === "AWAIT_CONFIRMATION") {
            // Awaiting operator approval: move to AWAIT_CONFIRMATION, do NOT increment attempts!
            await this.storage.updateOutboxStatus(record.outboxId, "AWAIT_CONFIRMATION", {
              lastAttemptAt: Date.now(),
            });
            pending++;
          } else {
            // Handler explicitly requested RETRY
            const nextAttempts = record.attempts + 1;
            if (nextAttempts >= this.maxAttempts) {
              await this.storage.updateOutboxStatus(record.outboxId, "FAILED_DLQ", {
                attempts: nextAttempts,
                lastAttemptAt: Date.now(),
                lastError: `Exceeded max retry attempts (${this.maxAttempts})`,
              });
              failed++;
            } else {
              const delay = this.calculateBackoff(nextAttempts);
              await this.storage.updateOutboxStatus(record.outboxId, "PENDING", {
                attempts: nextAttempts,
                nextAttemptAt: Date.now() + delay,
                lastAttemptAt: Date.now(),
                lastError: "Handler requested retry",
              });
              pending++;
            }
          }
        } catch (err) {
          // Handler threw exception during execution
          const errMsg = err instanceof Error ? err.message : String(err);
          const nextAttempts = record.attempts + 1;
          const isDlq = nextAttempts >= this.maxAttempts;

          if (isDlq) {
            await this.storage.updateOutboxStatus(record.outboxId, "FAILED_DLQ", {
              attempts: nextAttempts,
              lastAttemptAt: Date.now(),
              lastError: errMsg,
            });
            failed++;
          } else {
            const delay = this.calculateBackoff(nextAttempts);
            await this.storage.updateOutboxStatus(record.outboxId, "PENDING", {
              attempts: nextAttempts,
              nextAttemptAt: Date.now() + delay,
              lastAttemptAt: Date.now(),
              lastError: errMsg,
            });
            pending++;
          }
        }
      }
    } finally {
      this.isRunning = false;
    }

    return { processed, failed, pending };
  }
}
