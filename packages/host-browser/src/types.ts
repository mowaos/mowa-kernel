/**
 * Core type definitions for MO·WA OS Browser Host Adapter.
 * Matches mowa-core and mowa-wasm wire contracts.
 */

export interface ActorRef {
  type: string;
  id: string;
}

export type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | { [key: string]: Value };

export interface CanonicalEvent {
  id: string;
  type: string;
  source: string;
  caseId: string;
  timestamp: number;
  effectiveAt?: number | null;
  idempotencyKey: string;
  actor: ActorRef;
  payload: Record<string, Value>;
}

export interface WorkflowSession {
  id: string;
  caseId: string;
  workflowId: string;
  workflowVersion: string;
  flowHash: string;
  state: string;
  variables: Record<string, Value>;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastResultHash?: string | null;
}

export interface DecisionContext {
  asOf: number;
  contextRefs: Record<string, string>;
}

export interface DecisionFacts {
  facts: Record<string, string>;
}

export interface SideEffect {
  id: string;
  kind: string;
  payload: Value;
}

export interface TransitionAudit {
  transitionId: string;
  sessionId: string;
  caseId: string;
  fromVersion: number | null;
  eventId: string;
  eventType: string;
  resolvedKey: string | null;
  fromState: string | null;
  toState: string;
  guardFailed: boolean;
  workflowId: string;
  workflowVersion: string;
  flowHash: string;
  kernelVersion: string;
  decisionHash: string;
  contextRefs: Record<string, string>;
  factsHash: string;
  actor: ActorRef;
  timestamp: number;
  prevResultHash?: string | null;
  resultHash: string;
}

export interface Commit {
  newSession: WorkflowSession;
  expectedSessionVersion: number | null;
  audit: TransitionAudit;
  dedupKey: string;
  outbox: SideEffect[];
}

export type FlowStatus = "DRAFT" | "ACTIVE" | "DEPRECATED";

export interface Transition {
  to: string;
  allowedActors: string[];
  guard?: unknown;
  onGuardFail?: string;
}

export interface FlowNode {
  id: string;
  type: string;
  tier: "T0" | "T1" | "T2" | "T3" | "T4";
  terminal?: boolean;
  transitions?: Record<string, Transition>;
  onEnter?: Array<{ kind: string; payload?: Value }>;
}

export interface FlowDefinition {
  id: string;
  version: string;
  status: FlowStatus;
  startNode: string;
  startActors: string[];
  description?: string;
  declaredFacts?: Record<string, string[]>;
  nodes: Record<string, FlowNode>;
  effectiveFrom: number;
  effectiveTo?: number | null;
}

export interface KernelError {
  code: string;
  [key: string]: unknown;
}

export type KernelResponse =
  | { status: "OK"; commit: Commit }
  | { status: "KERNEL_ERROR"; error: KernelError }
  | { status: "FLOW_INVALID"; errors: unknown[] }
  | { status: "FLOW_HANDLE_NOT_FOUND"; handle: string }
  | { status: "BAD_REQUEST"; reason: string };

export type LoadFlowResponse =
  | { status: "OK"; flowHandle: string; flowHash: string }
  | { status: "FLOW_INVALID"; errors: unknown[] }
  | { status: "BAD_REQUEST"; reason: string };

export type DedupResponse =
  | { status: "OK"; dedupKey: string; intentHash: string }
  | { status: "BAD_REQUEST"; reason: string };

// Storage Models
export type OutboxStatus =
  | "PENDING"
  | "AWAIT_CONFIRMATION"
  | "DISPATCHED"
  | "FAILED_DLQ"
  | "REJECTED";

export interface OutboxRecord {
  outboxId: string;
  sessionId: string;
  transitionId: string;
  effect: SideEffect;
  status: OutboxStatus;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  unhandledSince?: number;
  lastError?: string;
}

export interface IdempotencyRecord {
  dedupKey: string;
  sessionId: string;
  intentHash?: string;
  commit: Commit;
  createdAt: number;
}

/**
 * What the kernel was given for one step. Kept with every commit so the decision can
 * be replayed later (docs/host-contract.md, section 6). `facts` is present for
 * `advance` only, exactly as supplied (including facts the flow does not declare).
 */
export interface StepInputs {
  call: "start" | "advance";
  event: CanonicalEvent;
  facts?: DecisionFacts;
  ctx: DecisionContext;
}

/** One committed step: its inputs and the commit they produced. */
export interface StepRecord extends StepInputs {
  transitionId: string;
  sessionId: string;
  /** `commit.newSession.version`: 0 for `start`, then 1, 2, … */
  version: number;
  commit: Commit;
}

/** Written by `atomicCommit` together with the commit itself. */
export interface CommitRecord {
  intentHash: string;
  inputs: StepInputs;
}

/**
 * Everything needed to verify a set of sessions without access to the host
 * (docs/host-contract.md, section 6.1). Format version 1; may change before 1.0.
 */
export interface VerificationBundle {
  format: "mowa.verification-bundle/1";
  /** Version of the kernel that exported the bundle. Each step's own version is in `commit.audit.kernelVersion`. */
  kernelVersion: string;
  /** Every flow the sessions use, keyed by flow hash. */
  flows: Record<string, FlowDefinition>;
  sessions: Array<{
    sessionId: string;
    steps: Array<StepInputs & { commit: Commit }>;
  }>;
  /** Reference data named in `contextRefs`, or where to obtain it. Supplied by the caller. */
  contextData: Record<string, unknown>;
}

export class IdempotencyConflictError extends Error {
  constructor(
    public readonly dedupKey: string,
    public readonly existingIntentHash: string,
    public readonly incomingIntentHash: string
  ) {
    super(
      `Idempotency key '${dedupKey}' was previously committed with intent '${existingIntentHash}', conflicting with incoming intent '${incomingIntentHash}'.`
    );
    this.name = "IdempotencyConflictError";
  }
}

export class FlowHandleNotFoundError extends Error {
  constructor(public readonly handle: string) {
    super(`Flow handle '${handle}' not found in WASM cache.`);
    this.name = "FlowHandleNotFoundError";
  }
}
