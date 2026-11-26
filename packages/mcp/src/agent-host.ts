// The host the MCP server and the review commands share. It holds the rules of the host
// contract (docs/host-contract.md, section 7) for agents:
//   - the host sets the actor: an agent is always actor type "AI";
//   - the host supplies the facts (from a file a person controls), never the agent;
//   - the host supplies the time (asOf);
//   - effects wait for a person (AWAIT_CONFIRMATION) unless a handler is configured.
// It knows nothing about MCP; server.ts maps tools and resources onto it.
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import {
  CasConflictError,
  KernelExecutionError,
  MowaBrowserHost,
  OutboxDispatcher,
  ValidationError,
  WasmKernelBridge,
  type ActorRef,
  type Commit,
  type EffectExecutionResult,
  type FlowDefinition,
  type OutboxRecord,
  type StepRecord,
  type VerificationBundle,
  type WasmKernelModule,
  type WorkflowSession,
} from "@mowaos/host-browser";

import { SqliteStorage, type StepMeta } from "./sqlite-storage.js";

/** Proof that an effect was decided by the kernel: hand it to whatever carries the effect out. */
export interface EffectReceipt {
  effectId: string;
  kind: string;
  caseId: string;
  transitionId: string;
  flowHash: string;
  decisionHash: string;
  resultHash: string;
}

export type EffectHandler = (record: OutboxRecord, receipt: EffectReceipt) => Promise<EffectExecutionResult>;

export interface AgentHostOptions {
  db: DatabaseSync;
  kernel: WasmKernelModule;
  /** Flow for new cases. Optional for the review commands, which use each case's pinned flow. */
  flow?: FlowDefinition;
  /** JSON file of facts ({ "check:x": "PASS" }), read on every decision. */
  factsPath?: string;
  /** Effect handlers by kind. Kinds without one wait for a person (AWAIT_CONFIRMATION). */
  effects?: Record<string, EffectHandler>;
  now?: () => number;
  newId?: () => string;
}

export interface Refusal {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
  /** The case as it is now, when there is one, so the caller can recover. */
  current?: CaseView;
}

export interface Action {
  event: string;
  to: string;
  /** Present when the move depends on facts; where the case goes if they fail. */
  onGuardFail?: string;
  guarded: boolean;
}

export interface CaseView {
  caseId: string;
  workflow: string;
  state: string;
  terminal: boolean;
  version: number;
  /** Pass this back as `expect` to act only if nothing changed in between. */
  expect: string;
  /** Moves the given actor may propose now. */
  actions: Action[];
  /** Moves only others (for an agent: people) can make now. */
  waitingFor: { event: string; to: string; allowedActors: string[] }[];
  /** Effects waiting for a person to confirm. */
  awaitingConfirmation: { effectId: string; kind: string; payload: unknown }[];
  /** Facts the host currently supplies. Read-only: they come from the host, not the caller. */
  facts: Record<string, string>;
}

export interface Committed {
  ok: true;
  case: CaseView;
  step: {
    version: number;
    event: string;
    from: string | null;
    to: string;
    guardFailed: boolean;
    decisionHash: string;
    resultHash: string;
    effects: { effectId: string; kind: string; status: string }[];
  };
}

export const AGENT_ACTOR_TYPE = "AI";
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_PAYLOAD_BYTES = 16 * 1024;

function flowKinds(flow: FlowDefinition): string[] {
  return Object.values(flow.nodes).flatMap((n) => (n.onEnter ?? []).map((e) => e.kind));
}

export class AgentHost {
  readonly storage: SqliteStorage;
  private readonly host: MowaBrowserHost;
  private readonly now: () => number;
  private readonly newId: () => string;
  private flowHash: string | null = null;

  private constructor(private readonly options: AgentHostOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomBytes(6).toString("hex"));
    this.storage = new SqliteStorage(options.db, this.now);
    const outbox = new OutboxDispatcher(this.storage);
    const kinds = new Set([...this.storage.listFlows(), ...(options.flow ? [options.flow] : [])].flatMap(flowKinds));
    for (const kind of kinds) {
      const handler = options.effects?.[kind];
      outbox.registerHandler(kind, async (record) =>
        handler ? handler(record, await this.receipt(record)) : "AWAIT_CONFIRMATION"
      );
    }
    this.host = new MowaBrowserHost(new WasmKernelBridge(options.kernel), { storage: this.storage, outboxDispatcher: outbox });
  }

  static async open(options: AgentHostOptions): Promise<AgentHost> {
    const host = new AgentHost(options);
    if (options.flow) host.flowHash = (await host.host.installFlow(options.flow)).flowHash;
    return host;
  }

  kernelVersion(): string {
    return this.options.kernel.kernelVersion();
  }

  /** Facts from the host's file. The caller of a tool never supplies these. */
  readFacts(): Record<string, string> {
    const path = this.options.factsPath;
    if (!path || !existsSync(path)) return {};
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Facts file ${path} must hold a JSON object.`);
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== "string") throw new Error(`Fact '${k}' in ${path} must be a string status.`);
    }
    return raw as Record<string, string>;
  }

  private makeEvent(caseId: string, type: string, actor: ActorRef, payload: Record<string, unknown>) {
    return {
      id: `ev-${this.newId()}`,
      type,
      source: "mowa-mcp",
      caseId,
      timestamp: this.now(),
      idempotencyKey: `ik-${this.newId()}`,
      actor,
      payload,
    };
  }

  private async settle(): Promise<void> {
    // The host dispatches the outbox in the background after a commit; finish it here so
    // the answer shows settled effect statuses.
    await new Promise((r) => setTimeout(r, 0));
    await this.host.getOutbox().dispatchPending();
  }

  private refusal(err: unknown, current?: CaseView): Refusal {
    if (err instanceof KernelExecutionError) {
      const details = err.details as { error?: { code?: string } ; reason?: string };
      const code = details?.error?.code ?? err.status;
      return { ok: false, code, message: describe(code, details), details: details?.error ?? details, current };
    }
    if (err instanceof CasConflictError) {
      return { ok: false, code: "STALE", message: "Someone else acted on this case at the same moment. Read it again.", current };
    }
    if (err instanceof ValidationError) {
      return { ok: false, code: "BAD_REQUEST", message: err.message, current };
    }
    return { ok: false, code: "HOST_ERROR", message: err instanceof Error ? err.message : String(err), current };
  }

  private checkPayload(payload: unknown): { value: Record<string, unknown> } | Refusal {
    if (payload === undefined) return { value: {} };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, code: "BAD_REQUEST", message: "payload must be a JSON object." };
    }
    if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
      return { ok: false, code: "BAD_REQUEST", message: `payload is larger than ${MAX_PAYLOAD_BYTES} bytes.` };
    }
    return { value: payload as Record<string, unknown> };
  }

  /** Start a new case on the configured flow. The case id is minted here. */
  async startCase(params: { actor: ActorRef; payload?: unknown; meta?: StepMeta }): Promise<Committed | Refusal> {
    if (!this.flowHash) return { ok: false, code: "NO_FLOW", message: "This host has no flow for new cases (start it with --flow)." };
    const payload = this.checkPayload(params.payload);
    if (!("value" in payload)) return payload;
    const caseId = `case-${this.newId()}`;
    const event = this.makeEvent(caseId, "CASE_STARTED", params.actor, payload.value);
    try {
      const commit = await this.host.startSession({
        sessionId: caseId,
        event,
        flowHash: this.flowHash,
        ctx: { asOf: event.timestamp, contextRefs: {} },
      });
      return this.committed(commit, params.actor.type, params.meta);
    } catch (err) {
      return this.refusal(err);
    }
  }

  /** Propose an event on a case, as the given actor, with the host's current facts. */
  async propose(params: {
    caseId: string;
    event: string;
    actor: ActorRef;
    payload?: unknown;
    expect?: string;
    meta?: StepMeta;
  }): Promise<Committed | Refusal> {
    if (!ID.test(params.caseId)) return { ok: false, code: "BAD_REQUEST", message: "caseId is not a valid case id." };
    if (!ID.test(params.event)) return { ok: false, code: "BAD_REQUEST", message: "event must be an event name, such as APPROVE." };
    const session = await this.storage.getSession(params.caseId);
    if (!session) return { ok: false, code: "UNKNOWN_CASE", message: `No case '${params.caseId}'. Start one, or list cases.` };
    const current = await this.view(session, params.actor.type);
    if (params.expect !== undefined && params.expect !== session.lastResultHash) {
      return {
        ok: false,
        code: "STALE",
        message: "The case changed since you last read it. Nothing was done. Here is the case as it is now.",
        current,
      };
    }
    const payload = this.checkPayload(params.payload);
    if (!("value" in payload)) return { ...payload, current };
    let facts: Record<string, string>;
    try {
      facts = this.readFacts();
    } catch (err) {
      return { ok: false, code: "HOST_FACTS_INVALID", message: (err as Error).message, current };
    }
    const event = this.makeEvent(params.caseId, params.event, params.actor, payload.value);
    try {
      const commit = await this.host.advanceSession({
        sessionId: params.caseId,
        event,
        facts: { facts },
        ctx: { asOf: event.timestamp, contextRefs: {} },
      });
      return this.committed(commit, params.actor.type, params.meta);
    } catch (err) {
      return this.refusal(err, current);
    }
  }

  private async committed(commit: Commit, actorType: string, meta?: StepMeta): Promise<Committed> {
    if (meta && Object.keys(meta).length > 0) this.storage.saveStepMeta(commit.audit.transitionId, meta);
    await this.settle();
    const session = commit.newSession;
    const records = new Map(this.storage.outboxForSession(session.id).map((r) => [r.outboxId, r]));
    return {
      ok: true,
      case: await this.view(session, actorType),
      step: {
        version: session.version,
        event: commit.audit.eventType,
        from: commit.audit.fromState,
        to: commit.audit.toState,
        guardFailed: commit.audit.guardFailed,
        decisionHash: commit.audit.decisionHash,
        resultHash: commit.audit.resultHash,
        effects: commit.outbox.map((e) => ({ effectId: e.id, kind: e.kind, status: records.get(e.id)?.status ?? "PENDING" })),
      },
    };
  }

  private async flowOf(session: WorkflowSession): Promise<FlowDefinition> {
    const flow = await this.storage.getFlow(session.flowHash);
    if (!flow) throw new Error(`Flow ${session.flowHash} for case '${session.id}' is not in storage.`);
    return flow;
  }

  /** What a given actor type sees on a case: its moves, everyone else's, and what waits. */
  async view(session: WorkflowSession, actorType: string): Promise<CaseView> {
    const flow = await this.flowOf(session);
    const node = flow.nodes[session.state];
    const transitions = Object.entries(node?.transitions ?? {});
    let facts: Record<string, string> = {};
    try {
      const all = this.readFacts();
      const declared = flow.declaredFacts ?? {};
      facts = Object.fromEntries(Object.entries(all).filter(([k]) => Object.hasOwn(declared, k)));
    } catch {
      // An unreadable facts file is reported when someone acts; the view still works.
    }
    return {
      caseId: session.id,
      workflow: `${session.workflowId}@${session.workflowVersion}`,
      state: session.state,
      terminal: Boolean(node?.terminal),
      version: session.version,
      expect: session.lastResultHash ?? "",
      actions: transitions
        .filter(([, t]) => t.allowedActors.includes(actorType))
        .map(([event, t]) => ({
          event,
          to: t.to,
          guarded: Boolean(t.guard),
          ...(t.onGuardFail ? { onGuardFail: t.onGuardFail } : {}),
        })),
      waitingFor: transitions
        .filter(([, t]) => !t.allowedActors.includes(actorType))
        .map(([event, t]) => ({ event, to: t.to, allowedActors: t.allowedActors })),
      awaitingConfirmation: this.storage
        .outboxForSession(session.id)
        .filter((r) => r.status === "AWAIT_CONFIRMATION")
        .map((r) => ({ effectId: r.outboxId, kind: r.effect.kind, payload: r.effect.payload })),
      facts,
    };
  }

  async getCase(caseId: string, actorType: string): Promise<CaseView | null> {
    const session = ID.test(caseId) ? await this.storage.getSession(caseId) : null;
    return session ? this.view(session, actorType) : null;
  }

  /** The case's history, step by step, with each effect and its status. */
  async history(caseId: string): Promise<{ steps: StepSummary[]; effects: EffectSummary[] } | null> {
    const session = ID.test(caseId) ? await this.storage.getSession(caseId) : null;
    if (!session) return null;
    const steps = (await this.storage.getSteps(caseId)).map(summarise(this.storage));
    const effects = this.storage.outboxForSession(caseId).map((r) => ({
      effectId: r.outboxId,
      kind: r.effect.kind,
      payload: r.effect.payload,
      status: r.status,
    }));
    return { steps, effects };
  }

  listCases(limit = 50): { caseId: string; workflow: string; state: string; version: number }[] {
    return this.storage.listSessions(limit).map((s) => ({
      caseId: s.id,
      workflow: `${s.workflowId}@${s.workflowVersion}`,
      state: s.state,
      version: s.version,
    }));
  }

  async receipt(record: OutboxRecord): Promise<EffectReceipt> {
    const audit = await this.storage.getAudit(record.transitionId);
    if (!audit) throw new Error(`No audit record for ${record.transitionId}.`);
    return {
      effectId: record.outboxId,
      kind: record.effect.kind,
      caseId: record.sessionId,
      transitionId: record.transitionId,
      flowHash: audit.flowHash,
      decisionHash: audit.decisionHash,
      resultHash: audit.resultHash,
    };
  }

  /** A person confirms an effect that waits for them. Returns its receipt. */
  async confirmEffect(effectId: string): Promise<EffectReceipt> {
    await this.host.confirmEffect(effectId);
    const record = await this.storage.getOutbox(effectId);
    return this.receipt(record as OutboxRecord);
  }

  async rejectEffect(effectId: string, reason: string): Promise<void> {
    await this.host.rejectEffect(effectId, reason);
  }

  async exportBundle(caseIds: string[]): Promise<VerificationBundle> {
    return this.host.exportVerificationBundle(caseIds);
  }
}

export interface StepSummary {
  version: number;
  event: string;
  actor: string;
  from: string | null;
  to: string;
  guardFailed: boolean;
  at: number;
  resultHash: string;
  traceparent?: string;
}

export interface EffectSummary {
  effectId: string;
  kind: string;
  payload: unknown;
  status: string;
}

function summarise(storage: SqliteStorage) {
  return (s: StepRecord): StepSummary => {
    const meta = storage.getStepMeta(s.transitionId);
    return {
      version: s.version,
      event: s.event.type,
      actor: `${s.event.actor.type}:${s.event.actor.id}`,
      from: s.commit.audit.fromState,
      to: s.commit.audit.toState,
      guardFailed: s.commit.audit.guardFailed,
      at: s.ctx.asOf,
      resultHash: s.commit.audit.resultHash,
      ...(meta?.traceparent ? { traceparent: meta.traceparent } : {}),
    };
  };
}

// Plain-language reasons for the kernel's refusals (docs/kernel-spec.md, section 9).
function describe(code: string, details: unknown): string {
  const e = (details as { error?: Record<string, unknown> })?.error ?? {};
  switch (code) {
    case "UNAUTHORIZED":
      return `Refused: actor type ${String(e.actor)} may not do ${String(e.key)} here. Nothing was recorded.`;
    case "START_UNAUTHORIZED":
      return `Refused: actor type ${String(e.actor)} may not start a case on this flow.`;
    case "NO_TRANSITION":
      return `Refused: there is no ${String(e.key)} from state ${String(e.state)}. List the actions to see what is possible.`;
    case "SESSION_TERMINAL":
      return `Refused: the case has ended (state ${String(e.state)}).`;
    case "MISSING_REQUIRED_FACT":
      return `Refused: the host has not supplied fact '${String(e.fact)}'. Only a person can set facts.`;
    case "INVALID_FACT_STATUS":
      return `Refused: the host's fact '${String(e.fact)}' has a status the flow does not allow. A person must fix the facts.`;
    case "GUARD_NOT_SATISFIED":
      return "Refused: the conditions for this move are not met, and the flow has no fallback.";
    default:
      return `Refused by the kernel: ${code}.`;
  }
}
