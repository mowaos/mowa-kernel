// SQLite storage for the MO·WA host, on Node's built-in node:sqlite (no dependencies).
// Implements the same MowaStorage contract as the browser host's IndexedDB storage:
// every commit (session, duplicate record, audit record, step, outbox records) is written
// in one transaction, and only if the stored session version is the expected one. Several
// processes may share one database file: the agent's server and a person's review commands.
import type { DatabaseSync, SqlValue } from "node:sqlite";

import {
  CasConflictError,
  type Commit,
  type CommitRecord,
  type FlowDefinition,
  type IdempotencyRecord,
  type MowaStorage,
  type OutboxRecord,
  type OutboxStatus,
  type StepRecord,
  type TransitionAudit,
  type WorkflowSession,
} from "@mowaos/host-browser";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flows (flow_hash TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (dedup_key TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (transition_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS steps (
  transition_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS steps_by_session ON steps (session_id, version);
CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_by_status ON outbox (status, next_attempt_at, outbox_id);
CREATE TABLE IF NOT EXISTS step_meta (transition_id TEXT PRIMARY KEY, json TEXT NOT NULL);
`;

/** Host-side metadata for a step. Never hashed; for tracing and display only. */
export interface StepMeta {
  traceparent?: string;
  tracestate?: string;
  client?: string;
}

function parse<T>(row: Record<string, SqlValue> | undefined): T | null {
  return row ? (JSON.parse(row.json as string) as T) : null;
}

export class SqliteStorage implements MowaStorage {
  /** Opens (and creates, if needed) the database. `now` is the host clock. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getFlow(flowHash: string): Promise<FlowDefinition | null> {
    return parse(this.db.prepare("SELECT json FROM flows WHERE flow_hash = ?").get(flowHash));
  }

  async saveFlow(flowHash: string, flow: FlowDefinition): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO flows (flow_hash, json) VALUES (?, ?)").run(flowHash, JSON.stringify(flow));
  }

  async getSession(sessionId: string): Promise<WorkflowSession | null> {
    return parse(this.db.prepare("SELECT json FROM sessions WHERE session_id = ?").get(sessionId));
  }

  async getIdempotency(dedupKey: string): Promise<IdempotencyRecord | null> {
    return parse(this.db.prepare("SELECT json FROM idempotency WHERE dedup_key = ?").get(dedupKey));
  }

  async getAudit(transitionId: string): Promise<TransitionAudit | null> {
    return parse(this.db.prepare("SELECT json FROM audit WHERE transition_id = ?").get(transitionId));
  }

  async getOutbox(outboxId: string): Promise<OutboxRecord | null> {
    return parse(this.db.prepare("SELECT json FROM outbox WHERE outbox_id = ?").get(outboxId));
  }

  async getPendingOutbox(limit = 50, now = this.now()): Promise<OutboxRecord[]> {
    return this.db
      .prepare(
        "SELECT json FROM outbox WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY next_attempt_at, outbox_id LIMIT ?"
      )
      .all(now, limit)
      .map((r) => JSON.parse(r.json as string) as OutboxRecord);
  }

  async getOutboxByStatus(status: OutboxStatus, limit = 50): Promise<OutboxRecord[]> {
    return this.db
      .prepare("SELECT json FROM outbox WHERE status = ? ORDER BY created_at, outbox_id LIMIT ?")
      .all(status, limit)
      .map((r) => JSON.parse(r.json as string) as OutboxRecord);
  }

  async getNextDueAt(): Promise<number | null> {
    const row = this.db.prepare("SELECT MIN(next_attempt_at) AS due FROM outbox WHERE status = 'PENDING'").get();
    return row?.due == null ? null : Number(row.due);
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
    this.transaction(() => {
      const record = parse<OutboxRecord>(this.db.prepare("SELECT json FROM outbox WHERE outbox_id = ?").get(outboxId));
      if (!record) return;
      record.status = status;
      if (data) {
        if (data.attempts !== undefined) record.attempts = data.attempts;
        if (data.nextAttemptAt !== undefined) record.nextAttemptAt = data.nextAttemptAt;
        if (data.lastAttemptAt !== undefined) record.lastAttemptAt = data.lastAttemptAt;
        if ("unhandledSince" in data) record.unhandledSince = data.unhandledSince;
        if ("lastError" in data) record.lastError = data.lastError;
      }
      this.db
        .prepare("UPDATE outbox SET status = ?, next_attempt_at = ?, json = ? WHERE outbox_id = ?")
        .run(record.status, record.nextAttemptAt, JSON.stringify(record), outboxId);
    });
  }

  async getSteps(sessionId: string): Promise<StepRecord[]> {
    return this.db
      .prepare("SELECT json FROM steps WHERE session_id = ? ORDER BY version")
      .all(sessionId)
      .map((r) => JSON.parse(r.json as string) as StepRecord);
  }

  async atomicCommit(
    sessionId: string,
    expectedVersion: number | null,
    commit: Commit,
    record: CommitRecord
  ): Promise<void> {
    const now = this.now();
    this.transaction(() => {
      const row = this.db.prepare("SELECT version FROM sessions WHERE session_id = ?").get(sessionId);
      const actual = row ? Number(row.version) : null;
      if (actual !== expectedVersion) {
        throw new CasConflictError(sessionId, expectedVersion, actual);
      }
      const session = commit.newSession;
      this.db
        .prepare(
          "INSERT INTO sessions (session_id, version, updated_at, json) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (session_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, json = excluded.json"
        )
        .run(sessionId, session.version, now, JSON.stringify(session));
      const idem: IdempotencyRecord = {
        dedupKey: commit.dedupKey,
        sessionId,
        intentHash: record.intentHash,
        commit,
        createdAt: now,
      };
      this.db.prepare("INSERT INTO idempotency (dedup_key, json) VALUES (?, ?)").run(commit.dedupKey, JSON.stringify(idem));
      this.db
        .prepare("INSERT INTO audit (transition_id, json) VALUES (?, ?)")
        .run(commit.audit.transitionId, JSON.stringify(commit.audit));
      const step: StepRecord = {
        ...record.inputs,
        transitionId: commit.audit.transitionId,
        sessionId,
        version: session.version,
        commit,
      };
      this.db
        .prepare("INSERT INTO steps (transition_id, session_id, version, json) VALUES (?, ?, ?, ?)")
        .run(step.transitionId, sessionId, step.version, JSON.stringify(step));
      for (const effect of commit.outbox) {
        const out: OutboxRecord = {
          outboxId: effect.id,
          sessionId,
          transitionId: commit.audit.transitionId,
          effect,
          status: "PENDING",
          attempts: 0,
          createdAt: now,
          nextAttemptAt: now,
        };
        this.db
          .prepare(
            "INSERT INTO outbox (outbox_id, session_id, status, next_attempt_at, created_at, json) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(out.outboxId, sessionId, out.status, out.nextAttemptAt, out.createdAt, JSON.stringify(out));
      }
    });
  }

  // ---- beyond MowaStorage: what the MCP server and the review commands need ----

  /** Sessions, most recently changed first. */
  listSessions(limit = 50): WorkflowSession[] {
    return this.db
      .prepare("SELECT json FROM sessions ORDER BY updated_at DESC, session_id LIMIT ?")
      .all(limit)
      .map((r) => JSON.parse(r.json as string) as WorkflowSession);
  }

  /** Every outbox record of one session, oldest first. */
  outboxForSession(sessionId: string): OutboxRecord[] {
    return this.db
      .prepare("SELECT json FROM outbox WHERE session_id = ? ORDER BY created_at, outbox_id")
      .all(sessionId)
      .map((r) => JSON.parse(r.json as string) as OutboxRecord);
  }

  /** Every flow ever installed, for registering effect handlers on start-up. */
  listFlows(): FlowDefinition[] {
    return this.db.prepare("SELECT json FROM flows").all().map((r) => JSON.parse(r.json as string) as FlowDefinition);
  }

  saveStepMeta(transitionId: string, meta: StepMeta): void {
    this.db
      .prepare("INSERT OR REPLACE INTO step_meta (transition_id, json) VALUES (?, ?)")
      .run(transitionId, JSON.stringify(meta));
  }

  getStepMeta(transitionId: string): StepMeta | null {
    return parse(this.db.prepare("SELECT json FROM step_meta WHERE transition_id = ?").get(transitionId));
  }
}
