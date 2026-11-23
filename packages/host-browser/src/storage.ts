/**
 * Storage Subsystem for MO·WA OS Browser Host.
 *
 * Implements the 6-store IndexedDB layout:
 *   1. `sessions`    - WorkflowSession snapshot (keyed by sessionId)
 *   2. `flows`       - FlowDefinition JSON (keyed by flowHash, written once on install)
 *   3. `idempotency` - Idempotency records (keyed by dedupKey, verified by intentHash)
 *   4. `audit_log`   - TransitionAudit records (keyed by transitionId, chained via prevResultHash)
 *   5. `outbox`      - SideEffect outbox records (keyed by outboxId, compound index: [status, nextAttemptAt])
 *   6. `steps`       - Step inputs + commit (keyed by transitionId, index: [sessionId, version]),
 *                      kept so every decision can be replayed (docs/host-contract.md, section 6)
 *
 * Provides:
 *   - `IndexedDbStorage`: Production-grade browser implementation.
 *   - `MemoryStorage`: Deterministic in-memory implementation for testing/Node.
 */

import type {
  Commit,
  CommitRecord,
  FlowDefinition,
  IdempotencyRecord,
  OutboxRecord,
  OutboxStatus,
  StepRecord,
  TransitionAudit,
  WorkflowSession,
} from "./types.js";

export interface MowaStorage {
  getFlow(flowHash: string): Promise<FlowDefinition | null>;
  saveFlow(flowHash: string, flow: FlowDefinition): Promise<void>;

  getSession(sessionId: string): Promise<WorkflowSession | null>;
  getIdempotency(dedupKey: string): Promise<IdempotencyRecord | null>;
  getAudit(transitionId: string): Promise<TransitionAudit | null>;
  getOutbox(outboxId: string): Promise<OutboxRecord | null>;

  getPendingOutbox(limit?: number, now?: number): Promise<OutboxRecord[]>;
  getOutboxByStatus(status: OutboxStatus, limit?: number): Promise<OutboxRecord[]>;
  getNextDueAt(): Promise<number | null>;
  updateOutboxStatus(
    outboxId: string,
    status: OutboxStatus,
    data?: {
      attempts?: number;
      nextAttemptAt?: number;
      lastAttemptAt?: number;
      unhandledSince?: number;
      lastError?: string;
    }
  ): Promise<void>;

  /** Every committed step of a session, in version order (0, 1, 2, …). */
  getSteps(sessionId: string): Promise<StepRecord[]>;

  /**
   * Writes the session, audit record, duplicate record, outbox records and step record
   * in one atomic transaction, only if the stored session version equals
   * `expectedVersion` (`null` = the session must not exist yet).
   */
  atomicCommit(
    sessionId: string,
    expectedVersion: number | null,
    commit: Commit,
    record: CommitRecord
  ): Promise<void>;
}

function stepRecord(sessionId: string, commit: Commit, record: CommitRecord): StepRecord {
  return {
    ...record.inputs,
    transitionId: commit.audit.transitionId,
    sessionId,
    version: commit.newSession.version,
    commit,
  };
}

export class CasConflictError extends Error {
  constructor(sessionId: string, expected: number | null, actual: number | null) {
    super(
      `CAS conflict on session '${sessionId}': expected version ${expected}, actual version ${actual}`
    );
    this.name = "CasConflictError";
  }
}

/**
 * In-memory storage implementation for tests, simulation, and Node environments.
 */
export class MemoryStorage implements MowaStorage {
  private readonly sessions = new Map<string, WorkflowSession>();
  private readonly flows = new Map<string, FlowDefinition>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly auditLog = new Map<string, TransitionAudit>();
  private readonly outbox = new Map<string, OutboxRecord>();
  private readonly steps = new Map<string, StepRecord>();

  async getSteps(sessionId: string): Promise<StepRecord[]> {
    return [...this.steps.values()]
      .filter((s) => s.sessionId === sessionId)
      .sort((a, b) => a.version - b.version)
      .map((s) => structuredClone(s));
  }

  async getFlow(flowHash: string): Promise<FlowDefinition | null> {
    return this.flows.get(flowHash) ?? null;
  }

  async saveFlow(flowHash: string, flow: FlowDefinition): Promise<void> {
    this.flows.set(flowHash, structuredClone(flow));
  }

  async getSession(sessionId: string): Promise<WorkflowSession | null> {
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s) : null;
  }

  async getIdempotency(dedupKey: string): Promise<IdempotencyRecord | null> {
    const r = this.idempotency.get(dedupKey);
    return r ? structuredClone(r) : null;
  }

  async getAudit(transitionId: string): Promise<TransitionAudit | null> {
    const a = this.auditLog.get(transitionId);
    return a ? structuredClone(a) : null;
  }

  async getOutbox(outboxId: string): Promise<OutboxRecord | null> {
    const o = this.outbox.get(outboxId);
    return o ? structuredClone(o) : null;
  }

  async getPendingOutbox(limit = 50, now = Date.now()): Promise<OutboxRecord[]> {
    const due: OutboxRecord[] = [];
    for (const record of this.outbox.values()) {
      if (record.status === "PENDING" && record.nextAttemptAt <= now) {
        due.push(structuredClone(record));
      }
    }
    // Strict FIFO ordering: nextAttemptAt ASC, ties broken by outboxId
    due.sort((a, b) => {
      if (a.nextAttemptAt !== b.nextAttemptAt) return a.nextAttemptAt - b.nextAttemptAt;
      return a.outboxId.localeCompare(b.outboxId);
    });
    return due.slice(0, limit);
  }

  async getOutboxByStatus(status: OutboxStatus, limit = 50): Promise<OutboxRecord[]> {
    const results: OutboxRecord[] = [];
    for (const record of this.outbox.values()) {
      if (record.status === status) {
        results.push(structuredClone(record));
      }
    }
    results.sort((a, b) => a.createdAt - b.createdAt || a.outboxId.localeCompare(b.outboxId));
    return results.slice(0, limit);
  }

  async getNextDueAt(): Promise<number | null> {
    let earliest: number | null = null;
    for (const record of this.outbox.values()) {
      if (record.status === "PENDING") {
        if (earliest === null || record.nextAttemptAt < earliest) {
          earliest = record.nextAttemptAt;
        }
      }
    }
    return earliest;
  }

  async updateOutboxStatus(
    outboxId: string,
    status: OutboxStatus,
    data?: {
      attempts?: number;
      nextAttemptAt?: number;
      lastAttemptAt?: number;
      unhandledSince?: number;
      lastError?: string;
    }
  ): Promise<void> {
    const record = this.outbox.get(outboxId);
    if (!record) return;

    record.status = status;
    if (data) {
      if (data.attempts !== undefined) {
        record.attempts = data.attempts;
      }
      if (data.nextAttemptAt !== undefined) {
        record.nextAttemptAt = data.nextAttemptAt;
      }
      if (data.lastAttemptAt !== undefined) {
        record.lastAttemptAt = data.lastAttemptAt;
      }
      if ("unhandledSince" in data) {
        record.unhandledSince = data.unhandledSince;
      }
      if ("lastError" in data) {
        record.lastError = data.lastError;
      }
    }
  }

  async atomicCommit(
    sessionId: string,
    expectedVersion: number | null,
    commit: Commit,
    record: CommitRecord
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    const actualVersion = existing ? existing.version : null;

    if (actualVersion !== expectedVersion) {
      throw new CasConflictError(sessionId, expectedVersion, actualVersion);
    }

    const now = Date.now();
    this.sessions.set(sessionId, structuredClone(commit.newSession));
    this.idempotency.set(commit.dedupKey, {
      dedupKey: commit.dedupKey,
      sessionId,
      intentHash: record.intentHash,
      commit: structuredClone(commit),
      createdAt: now,
    });
    this.auditLog.set(commit.audit.transitionId, structuredClone(commit.audit));
    this.steps.set(commit.audit.transitionId, structuredClone(stepRecord(sessionId, commit, record)));

    const transitionId = commit.audit.transitionId;
    for (const effect of commit.outbox) {
      this.outbox.set(effect.id, {
        outboxId: effect.id,
        sessionId,
        transitionId,
        effect: structuredClone(effect),
        status: "PENDING",
        attempts: 0,
        createdAt: now,
        nextAttemptAt: now,
      });
    }
  }
}

/**
 * Production IndexedDB storage engine for Chrome MV3 extension.
 */
export class IndexedDbStorage implements MowaStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName = "mowa_kernel_db",
    private readonly version = 3
  ) {}

  private getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("indexedDB is not available in the current environment"));
        return;
      }

      const req = indexedDB.open(this.dbName, this.version);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("flows")) {
          db.createObjectStore("flows", { keyPath: "flowHash" });
        }
        if (!db.objectStoreNames.contains("idempotency")) {
          db.createObjectStore("idempotency", { keyPath: "dedupKey" });
        }
        if (!db.objectStoreNames.contains("audit_log")) {
          db.createObjectStore("audit_log", { keyPath: "transitionId" });
        }
        // DB v3: step inputs for replay. Sessions committed before v3 have no steps.
        if (!db.objectStoreNames.contains("steps")) {
          const steps = db.createObjectStore("steps", { keyPath: "transitionId" });
          steps.createIndex("sessionId_version", ["sessionId", "version"], { unique: true });
        }
        let outboxStore: IDBObjectStore;
        if (!db.objectStoreNames.contains("outbox")) {
          outboxStore = db.createObjectStore("outbox", { keyPath: "outboxId" });
          outboxStore.createIndex("status_nextAttemptAt", ["status", "nextAttemptAt"], {
            unique: false,
          });
        } else {
          outboxStore = req.transaction!.objectStore("outbox");
          if (!outboxStore.indexNames.contains("status_nextAttemptAt")) {
            outboxStore.createIndex("status_nextAttemptAt", ["status", "nextAttemptAt"], {
              unique: false,
            });
          }
          // Note on DB v2 migration:
          // Existing outbox records from v1 may not have nextAttemptAt populated.
          // Cursor migration fills nextAttemptAt = record.createdAt if missing.
          // NOTE: Effects that were previously sent to FAILED_DLQ due to attempt-counting bugs
          // can be recovered by the operator via host.requeueEffect(outboxId).
          const cursorReq = outboxStore.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              const val = cursor.value;
              if (typeof val.nextAttemptAt !== "number") {
                val.nextAttemptAt = val.createdAt || Date.now();
                cursor.update(val);
              }
              cursor.continue();
            }
          };
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    return this.dbPromise;
  }

  async getFlow(flowHash: string): Promise<FlowDefinition | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("flows", "readonly");
      const store = tx.objectStore("flows");
      const req = store.get(flowHash);
      req.onsuccess = () => resolve(req.result?.definition ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async saveFlow(flowHash: string, flow: FlowDefinition): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("flows", "readwrite");
      const store = tx.objectStore("flows");
      const req = store.put({ flowHash, definition: flow });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getSteps(sessionId: string): Promise<StepRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("steps", "readonly");
      const index = tx.objectStore("steps").index("sessionId_version");
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
      const req = index.getAll(range);
      req.onsuccess = () => resolve((req.result as StepRecord[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async getSession(sessionId: string): Promise<WorkflowSession | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const store = tx.objectStore("sessions");
      const req = store.get(sessionId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async getIdempotency(dedupKey: string): Promise<IdempotencyRecord | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("idempotency", "readonly");
      const store = tx.objectStore("idempotency");
      const req = store.get(dedupKey);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async getAudit(transitionId: string): Promise<TransitionAudit | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("audit_log", "readonly");
      const store = tx.objectStore("audit_log");
      const req = store.get(transitionId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async getOutbox(outboxId: string): Promise<OutboxRecord | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readonly");
      const store = tx.objectStore("outbox");
      const req = store.get(outboxId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async getPendingOutbox(limit = 50, now = Date.now()): Promise<OutboxRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readonly");
      const store = tx.objectStore("outbox");
      const index = store.index("status_nextAttemptAt");
      // Single query for status="PENDING" and nextAttemptAt <= now
      const range = IDBKeyRange.bound(["PENDING", -Infinity], ["PENDING", now]);
      const results: OutboxRecord[] = [];
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async getOutboxByStatus(status: OutboxStatus, limit = 50): Promise<OutboxRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readonly");
      const store = tx.objectStore("outbox");
      const index = store.index("status_nextAttemptAt");
      const range = IDBKeyRange.bound([status, -Infinity], [status, Infinity]);
      const results: OutboxRecord[] = [];
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          results.sort((a, b) => a.createdAt - b.createdAt || a.outboxId.localeCompare(b.outboxId));
          resolve(results.slice(0, limit));
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async getNextDueAt(): Promise<number | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readonly");
      const store = tx.objectStore("outbox");
      const index = store.index("status_nextAttemptAt");
      const range = IDBKeyRange.bound(["PENDING", -Infinity], ["PENDING", Infinity]);
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          resolve(cursor.value.nextAttemptAt ?? null);
        } else {
          resolve(null);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async updateOutboxStatus(
    outboxId: string,
    status: OutboxStatus,
    data?: {
      attempts?: number;
      nextAttemptAt?: number;
      lastAttemptAt?: number;
      unhandledSince?: number;
      lastError?: string;
    }
  ): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readwrite");
      const store = tx.objectStore("outbox");
      const getReq = store.get(outboxId);
      getReq.onsuccess = () => {
        const record = getReq.result as OutboxRecord | undefined;
        if (!record) {
          resolve();
          return;
        }
        record.status = status;
        if (data) {
          if (data.attempts !== undefined) {
            record.attempts = data.attempts;
          }
          if (data.nextAttemptAt !== undefined) {
            record.nextAttemptAt = data.nextAttemptAt;
          }
          if (data.lastAttemptAt !== undefined) {
            record.lastAttemptAt = data.lastAttemptAt;
          }
          if ("unhandledSince" in data) {
            record.unhandledSince = data.unhandledSince;
          }
          if ("lastError" in data) {
            record.lastError = data.lastError;
          }
        }
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async atomicCommit(
    sessionId: string,
    expectedVersion: number | null,
    commit: Commit,
    record: CommitRecord
  ): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        ["sessions", "idempotency", "audit_log", "outbox", "steps"],
        "readwrite"
      );

      const sessionStore = tx.objectStore("sessions");
      const idempotencyStore = tx.objectStore("idempotency");
      const auditStore = tx.objectStore("audit_log");
      const outboxStore = tx.objectStore("outbox");
      const stepsStore = tx.objectStore("steps");

      const sessionReq = sessionStore.get(sessionId);

      sessionReq.onsuccess = () => {
        const existing = sessionReq.result as WorkflowSession | undefined;
        const actualVersion = existing ? existing.version : null;

        if (actualVersion !== expectedVersion) {
          tx.abort();
          reject(new CasConflictError(sessionId, expectedVersion, actualVersion));
          return;
        }

        const now = Date.now();
        // Put new session
        sessionStore.put(commit.newSession);

        // Put idempotency record
        idempotencyStore.put({
          dedupKey: commit.dedupKey,
          sessionId,
          intentHash: record.intentHash,
          commit,
          createdAt: now,
        });

        // Put audit log
        auditStore.put(commit.audit);

        // Put step inputs, so the decision can be replayed
        stepsStore.put(stepRecord(sessionId, commit, record));

        // Put outbox items
        const transitionId = commit.audit.transitionId;
        for (const effect of commit.outbox) {
          outboxStore.put({
            outboxId: effect.id,
            sessionId,
            transitionId,
            effect,
            status: "PENDING",
            attempts: 0,
            createdAt: now,
            nextAttemptAt: now,
          });
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error("IndexedDB transaction aborted"));
    });
  }
}
