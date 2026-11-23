/**
 * MowaBrowserHost: The Primary Browser Runtime Coordinator.
 *
 * Implements the atomic Read-Compute-Write cycle:
 *   1. Acquire session mutex via `SessionLock` (`navigator.locks`).
 *   2. Idempotency fast-path lookup with `intentHash` conflict checking.
 *   3. Read current `WorkflowSession` from `sessions` store.
 *   4. Execute pure transition in WASM kernel via `WasmKernelBridge` (auto-reloading on handle eviction).
 *   5. Atomic commit across `sessions`, `idempotency`, `audit_log`, `outbox`, `steps`
 *      (the step record keeps the event, facts and context, so the decision can be replayed).
 *   6. Release lock.
 *   7. Asynchronously trigger `OutboxDispatcher` outside the lock.
 */

import { WasmKernelBridge } from "./kernel.js";
import { MemorySessionLock, type SessionLock } from "./locks.js";
import { OutboxDispatcher } from "./outbox.js";
import { MemoryStorage, type MowaStorage } from "./storage.js";
import {
  FlowHandleNotFoundError,
  IdempotencyConflictError,
  type CanonicalEvent,
  type Commit,
  type DecisionContext,
  type DecisionFacts,
  type FlowDefinition,
  type OutboxRecord,
  type OutboxStatus,
  type VerificationBundle,
} from "./types.js";
import {
  validateCanonicalEvent,
  validateDecisionContext,
  validateDecisionFacts,
  validateFlowDefinition,
} from "./validation.js";

export interface MowaBrowserHostOptions {
  storage?: MowaStorage;
  lock?: SessionLock;
  outboxDispatcher?: OutboxDispatcher;
}

export class MowaBrowserHost {
  private readonly storage: MowaStorage;
  private readonly lock: SessionLock;
  private readonly outbox: OutboxDispatcher;
  private readonly flowHandles = new Map<string, string>(); // flowHash -> flowHandle

  constructor(
    private readonly kernel: WasmKernelBridge,
    options: MowaBrowserHostOptions = {}
  ) {
    this.storage = options.storage ?? new MemoryStorage();
    this.lock = options.lock ?? new MemorySessionLock();
    this.outbox = options.outboxDispatcher ?? new OutboxDispatcher(this.storage);
  }

  getStorage(): MowaStorage {
    return this.storage;
  }

  getOutbox(): OutboxDispatcher {
    return this.outbox;
  }

  async getOutboxByStatus(status: OutboxStatus, limit?: number): Promise<OutboxRecord[]> {
    return await this.storage.getOutboxByStatus(status, limit);
  }

  /**
   * Install and validate a flow definition.
   * Caches in WASM memory and writes to the `flows` store ONCE.
   */
  async installFlow(
    flowRaw: unknown
  ): Promise<{ flowHash: string; flowHandle: string }> {
    const flow = validateFlowDefinition(flowRaw);
    const { flowHandle, flowHash } = this.kernel.loadFlow(flow);

    await this.storage.saveFlow(flowHash, flow);
    this.flowHandles.set(flowHash, flowHandle);

    return { flowHash, flowHandle };
  }

  /**
   * Resolve an active flow handle, loading it from storage if not yet cached in WASM.
   */
  private async resolveFlow(flowHash: string): Promise<string | FlowDefinition> {
    const cached = this.flowHandles.get(flowHash);
    if (cached) return cached;

    const stored = await this.storage.getFlow(flowHash);
    if (!stored) {
      throw new Error(`Flow with hash '${flowHash}' not found in storage.`);
    }

    const { flowHandle } = this.kernel.loadFlow(stored);
    this.flowHandles.set(flowHash, flowHandle);
    return flowHandle;
  }

  /**
   * Operator confirmation API for human-in-the-loop review.
   */
  async confirmEffect(outboxId: string): Promise<void> {
    await this.outbox.confirmEffect(outboxId);
  }

  /**
   * Operator rejection API for human-in-the-loop review.
   */
  async rejectEffect(outboxId: string, reason: string): Promise<void> {
    await this.outbox.rejectEffect(outboxId, reason);
  }

  /**
   * Operator recovery API to requeue a failed dead-letter task back to pending.
   */
  async requeueEffect(outboxId: string): Promise<void> {
    await this.outbox.requeueEffect(outboxId);
  }

  /**
   * Returns earliest timestamp when a pending outbox effect is due.
   */
  async getNextDueAt(): Promise<number | null> {
    return await this.outbox.getNextDueAt();
  }

  /**
   * Start a new workflow session.
   */
  async startSession(params: {
    sessionId: string;
    event: unknown;
    flowHash: string;
    ctx: unknown;
  }): Promise<Commit> {
    const event = validateCanonicalEvent(params.event);
    const ctx = validateDecisionContext(params.ctx);

    return await this.lock.acquire(params.sessionId, async () => {
      // 1. Compute dedup key & intent hash, check idempotency store
      const { dedupKey, intentHash } = this.kernel.dedupKey("START", params.sessionId, event);
      const existing = await this.storage.getIdempotency(dedupKey);
      if (existing) {
        // Enforce intent hash match; accept legacy records without intentHash
        if (existing.intentHash && existing.intentHash !== intentHash) {
          throw new IdempotencyConflictError(dedupKey, existing.intentHash, intentHash);
        }
        return existing.commit;
      }

      // 2. Resolve flow handle (reloading from IDB if evicted)
      let flow = await this.resolveFlow(params.flowHash);

      // 3. Compute pure start transition in WASM
      let commit: Commit;
      try {
        commit = this.kernel.start(params.sessionId, event, flow, ctx);
      } catch (err) {
        if (err instanceof FlowHandleNotFoundError) {
          this.flowHandles.delete(params.flowHash);
          flow = await this.resolveFlow(params.flowHash);
          commit = this.kernel.start(params.sessionId, event, flow, ctx);
        } else {
          throw err;
        }
      }

      // 4. Atomic commit with step inputs (INSERT expects null version)
      await this.storage.atomicCommit(params.sessionId, null, commit, {
        intentHash,
        inputs: { call: "start", event, ctx },
      });

      return commit;
    }).finally(() => {
      // 5. Asynchronously trigger outbox outside the lock
      void this.outbox.dispatchPending();
    });
  }

  /**
   * Advance an existing workflow session.
   */
  async advanceSession(params: {
    sessionId: string;
    event: unknown;
    facts?: unknown;
    ctx: unknown;
  }): Promise<Commit> {
    const event = validateCanonicalEvent(params.event);
    const ctx = validateDecisionContext(params.ctx);
    const facts = validateDecisionFacts(params.facts);

    return await this.lock.acquire(params.sessionId, async () => {
      // 1. Compute dedup key & intent hash, check idempotency store
      const { dedupKey, intentHash } = this.kernel.dedupKey("ADVANCE", params.sessionId, event);
      const existing = await this.storage.getIdempotency(dedupKey);
      if (existing) {
        // Enforce intent hash match; accept legacy records without intentHash
        if (existing.intentHash && existing.intentHash !== intentHash) {
          throw new IdempotencyConflictError(dedupKey, existing.intentHash, intentHash);
        }
        return existing.commit;
      }

      // 2. Read session snapshot
      const session = await this.storage.getSession(params.sessionId);
      if (!session) {
        throw new Error(`Session '${params.sessionId}' not found.`);
      }

      // 3. Resolve pinned flow handle (reloading from IDB if evicted)
      let flow = await this.resolveFlow(session.flowHash);

      // 4. Compute pure advance transition in WASM
      let commit: Commit;
      try {
        commit = this.kernel.advance(session, event, flow, facts, ctx);
      } catch (err) {
        if (err instanceof FlowHandleNotFoundError) {
          this.flowHandles.delete(session.flowHash);
          flow = await this.resolveFlow(session.flowHash);
          commit = this.kernel.advance(session, event, flow, facts, ctx);
        } else {
          throw err;
        }
      }

      // 5. Atomic commit with step inputs and CAS check
      await this.storage.atomicCommit(params.sessionId, session.version, commit, {
        intentHash,
        inputs: { call: "advance", event, facts, ctx },
      });

      return commit;
    }).finally(() => {
      // 6. Asynchronously trigger outbox outside the lock
      void this.outbox.dispatchPending();
    });
  }

  /**
   * Export everything needed to verify the given sessions without access to this host
   * (docs/host-contract.md, section 6.1): every step's inputs and commit, and every flow
   * they used. `contextData` is copied into the bundle as given, for the reference data
   * named in `contextRefs`.
   *
   * Throws if a session has no complete step history (for example, one committed by a
   * host version before 0.5.0, which did not keep step inputs).
   */
  async exportVerificationBundle(
    sessionIds: string[],
    contextData: Record<string, unknown> = {}
  ): Promise<VerificationBundle> {
    const flows: Record<string, FlowDefinition> = {};
    const sessions: VerificationBundle["sessions"] = [];

    for (const sessionId of sessionIds) {
      const session = await this.storage.getSession(sessionId);
      if (!session) {
        throw new Error(`Session '${sessionId}' not found.`);
      }
      const steps = await this.storage.getSteps(sessionId);
      const complete =
        steps.length === session.version + 1 && steps.every((s, i) => s.version === i);
      if (!complete) {
        throw new Error(
          `Session '${sessionId}' has an incomplete step history (${steps.length} steps for version ${session.version}); it cannot be exported for verification.`
        );
      }

      for (const step of steps) {
        const flowHash = step.commit.newSession.flowHash;
        if (!(flowHash in flows)) {
          const flow = await this.storage.getFlow(flowHash);
          if (!flow) {
            throw new Error(`Flow '${flowHash}' used by session '${sessionId}' is not in storage.`);
          }
          flows[flowHash] = flow;
        }
      }

      sessions.push({
        sessionId,
        steps: steps.map(({ call, event, facts, ctx, commit }) =>
          call === "start" ? { call, event, ctx, commit } : { call, event, facts, ctx, commit }
        ),
      });
    }

    return {
      format: "mowa.verification-bundle/1",
      kernelVersion: this.kernel.getVersion(),
      flows,
      sessions,
      contextData,
    };
  }
}
