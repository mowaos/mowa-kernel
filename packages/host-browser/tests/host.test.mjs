/**
 * Integration test suite for @mowaos/host-browser
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import {
  MowaBrowserHost,
  WasmKernelBridge,
  MemorySessionLock,
  MemoryStorage,
  OutboxDispatcher,
  IdempotencyConflictError,
  IncompleteStepHistoryError,
} from "../dist/index.js";

const require = createRequire(import.meta.url);
const wasmPkg = require("../../../pkg/mowa_wasm.js");

function sampleFlow() {
  return {
    id: "APPROVAL_FLOW",
    version: "1.0.0",
    status: "ACTIVE",
    startNode: "INTAKE",
    startActors: ["SYSTEM", "OPERATOR"],
    effectiveFrom: 0,
    declaredFacts: {
      "doc:invoice": ["MISSING", "VERIFIED", "CONFLICTED"],
    },
    nodes: {
      INTAKE: {
        id: "INTAKE",
        type: "t",
        tier: "T1",
        onEnter: [{ kind: "EMIT_INTAKE_NOTIFICATION" }],
        transitions: {
          SUBMIT_DOCS: {
            to: "APPROVED",
            allowedActors: ["SYSTEM", "OPERATOR"],
            guard: {
              op: "status_is",
              target: "doc:invoice",
              status: "VERIFIED",
            },
            onGuardFail: "REVIEW",
          },
        },
      },
      REVIEW: {
        id: "REVIEW",
        type: "t",
        tier: "T2",
        onEnter: [{ kind: "REQUEST_REVIEW", payload: { reason: "Missing invoice" } }],
        transitions: {
          RESOLVE: {
            to: "APPROVED",
            allowedActors: ["OPERATOR"],
          },
        },
      },
      APPROVED: {
        id: "APPROVED",
        type: "t",
        tier: "T1",
        terminal: true,
        onEnter: [{ kind: "EMIT_APPROVED" }],
      },
    },
  };
}

describe("MowaBrowserHost End-to-End Suite", () => {
  const kernel = new WasmKernelBridge(wasmPkg);

  it("1. installFlow validates, caches in WASM, and stores in storage", async () => {
    const storage = new MemoryStorage();
    const host = new MowaBrowserHost(kernel, { storage });

    const flow = sampleFlow();
    const { flowHash, flowHandle } = await host.installFlow(flow);

    assert.equal(flowHash.length, 64);
    assert.ok(flowHandle.startsWith(flowHash));

    const stored = await storage.getFlow(flowHash);
    assert.ok(stored);
    assert.equal(stored.id, "APPROVAL_FLOW");
  });

  it("2. startSession creates session version 0 and writes atomic 4-store commit", async () => {
    const storage = new MemoryStorage();
    const host = new MowaBrowserHost(kernel, { storage });
    const { flowHash } = await host.installFlow(sampleFlow());

    const sessionId = "SESSION_101";
    const event = {
      id: "EVT_1",
      type: "INITIALIZE",
      source: "chrome_extension_action",
      caseId: "CASE_9921",
      timestamp: 1000,
      idempotencyKey: "idem_start_1",
      actor: { type: "OPERATOR", id: "OPERATOR_ALICE" },
      payload: {},
    };
    const ctx = { asOf: 1000, contextRefs: { manifestVersion: "2026.11" } };

    const commit = await host.startSession({
      sessionId,
      event,
      flowHash,
      ctx,
    });

    assert.equal(commit.newSession.id, sessionId);
    assert.equal(commit.newSession.state, "INTAKE");
    assert.equal(commit.newSession.version, 0);
    assert.equal(commit.newSession.flowHash, flowHash);
    assert.equal(commit.outbox.length, 1);
    assert.equal(commit.outbox[0].kind, "EMIT_INTAKE_NOTIFICATION");
    assert.equal(commit.audit.prevResultHash, null);
    assert.equal(commit.newSession.lastResultHash, commit.audit.resultHash);

    // Verify storage persistence
    const savedSession = await storage.getSession(sessionId);
    assert.ok(savedSession);
    assert.equal(savedSession.version, 0);

    const audit = await storage.getAudit(commit.audit.transitionId);
    assert.ok(audit);
    assert.equal(audit.toState, "INTAKE");
  });

  it("3. idempotent start: duplicate start event returns cached commit immediately", async () => {
    const storage = new MemoryStorage();
    const host = new MowaBrowserHost(kernel, { storage });
    const { flowHash } = await host.installFlow(sampleFlow());

    const startParams = {
      sessionId: "SESSION_IDEM_START",
      event: {
        id: "EVT_START_IDEM",
        type: "INITIALIZE",
        source: "action_card",
        caseId: "CASE_IDEM",
        timestamp: 1000,
        idempotencyKey: "idem_key_unique_1",
        actor: { type: "SYSTEM", id: "SYS_1" },
        payload: {},
      },
      flowHash,
      ctx: { asOf: 1000, contextRefs: {} },
    };

    const first = await host.startSession(startParams);
    const second = await host.startSession(startParams);

    assert.equal(first.dedupKey, second.dedupKey);
    assert.equal(first.audit.transitionId, second.audit.transitionId);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it("4. advanceSession transitions state, increments version, and chains audit hashes", async () => {
    const storage = new MemoryStorage();
    const outbox = new OutboxDispatcher(storage);
    const host = new MowaBrowserHost(kernel, { storage, outboxDispatcher: outbox });
    const { flowHash } = await host.installFlow(sampleFlow());

    const sessionId = "SESSION_ADV_1";
    const startCommit = await host.startSession({
      sessionId,
      event: {
        id: "EVT_INIT",
        type: "INITIALIZE",
        source: "action_card",
        caseId: "CASE_ADV",
        timestamp: 1000,
        idempotencyKey: "idem_init",
        actor: { type: "OPERATOR", id: "BOB" },
        payload: {},
      },
      flowHash,
      ctx: { asOf: 1000, contextRefs: {} },
    });

    // Advance with verified invoice fact
    const advanceCommit = await host.advanceSession({
      sessionId,
      event: {
        id: "EVT_DOCS",
        type: "SUBMIT_DOCS",
        source: "action_card",
        caseId: "CASE_ADV",
        timestamp: 2000,
        idempotencyKey: "idem_docs",
        actor: { type: "OPERATOR", id: "BOB" },
        payload: {},
      },
      facts: {
        facts: { "doc:invoice": "VERIFIED" },
      },
      ctx: { asOf: 2000, contextRefs: {} },
    });

    assert.equal(advanceCommit.newSession.state, "APPROVED");
    assert.equal(advanceCommit.newSession.version, 1);
    assert.equal(advanceCommit.audit.fromState, "INTAKE");
    assert.equal(advanceCommit.audit.toState, "APPROVED");
    assert.equal(advanceCommit.outbox[0].kind, "EMIT_APPROVED");
    assert.equal(advanceCommit.audit.prevResultHash, startCommit.audit.resultHash);
    assert.equal(advanceCommit.newSession.lastResultHash, advanceCommit.audit.resultHash);

    // Verify session updated in storage
    const updated = await storage.getSession(sessionId);
    assert.equal(updated?.version, 1);
    assert.equal(updated?.state, "APPROVED");
  });

  it("5. guard failure routes deterministically to REVIEW with Pre-fill outbox", async () => {
    const storage = new MemoryStorage();
    const outbox = new OutboxDispatcher(storage);
    const host = new MowaBrowserHost(kernel, { storage, outboxDispatcher: outbox });
    const { flowHash } = await host.installFlow(sampleFlow());

    const sessionId = "SESSION_REVIEW_1";
    await host.startSession({
      sessionId,
      event: {
        id: "EVT_0",
        type: "INIT",
        source: "action_card",
        caseId: "CASE_REV",
        timestamp: 1000,
        idempotencyKey: "idem_rev_0",
        actor: { type: "SYSTEM", id: "SYS" },
        payload: {},
      },
      flowHash,
      ctx: { asOf: 1000, contextRefs: {} },
    });

    // Advance with MISSING invoice fact -> guard fails, routes to REVIEW
    const commit = await host.advanceSession({
      sessionId,
      event: {
        id: "EVT_SUBMIT_MISSING",
        type: "SUBMIT_DOCS",
        source: "action_card",
        caseId: "CASE_REV",
        timestamp: 2000,
        idempotencyKey: "idem_missing",
        actor: { type: "SYSTEM", id: "SYS" },
        payload: {},
      },
      facts: {
        facts: { "doc:invoice": "MISSING" },
      },
      ctx: { asOf: 2000, contextRefs: {} },
    });

    assert.equal(commit.newSession.state, "REVIEW");
    assert.equal(commit.audit.guardFailed, true);
    assert.equal(commit.outbox[0].kind, "REQUEST_REVIEW");
  });

  it("6. outbox dispatcher handles AWAIT_CONFIRMATION without attempt increment, reject, and confirm", async () => {
    const storage = new MemoryStorage();
    const outbox = new OutboxDispatcher(storage, { maxAttempts: 3 });
    const host = new MowaBrowserHost(kernel, { storage, outboxDispatcher: outbox });
    const { flowHash } = await host.installFlow(sampleFlow());

    let emailDrafted = false;
    outbox.registerHandler("REQUEST_REVIEW", async (record) => {
      emailDrafted = true;
      // Pre-filled action card awaiting human confirmation
      return "AWAIT_CONFIRMATION";
    });

    const sessionId = "SESSION_OUTBOX_TEST";
    await host.startSession({
      sessionId,
      event: {
        id: "E0",
        type: "INIT",
        source: "test",
        caseId: "CASE_OB",
        timestamp: 1,
        idempotencyKey: "k0",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      flowHash,
      ctx: { asOf: 1, contextRefs: {} },
    });

    const commit = await host.advanceSession({
      sessionId,
      event: {
        id: "E1",
        type: "SUBMIT_DOCS",
        source: "test",
        caseId: "CASE_OB",
        timestamp: 2,
        idempotencyKey: "k1",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      facts: { facts: { "doc:invoice": "MISSING" } },
      ctx: { asOf: 2, contextRefs: {} },
    });

    const draftEffectId = commit.outbox[0].id;

    // Run outbox dispatch: should transition to AWAIT_CONFIRMATION
    await outbox.dispatchPending();
    assert.equal(emailDrafted, true);

    const record1 = await storage.getOutbox(draftEffectId);
    assert.ok(record1);
    assert.equal(record1.status, "AWAIT_CONFIRMATION");
    assert.equal(record1.attempts, 0); // Must NOT increment attempts!

    // Run 5 more unrelated dispatch passes: attempts MUST STAY 0 and NOT die in FAILED_DLQ!
    for (let i = 0; i < 5; i++) {
      await outbox.dispatchPending();
    }
    const recordAfterPasses = await storage.getOutbox(draftEffectId);
    assert.equal(recordAfterPasses?.status, "AWAIT_CONFIRMATION");
    assert.equal(recordAfterPasses?.attempts, 0);

    // Confirm effect
    await host.confirmEffect(draftEffectId);
    const confirmedRecord = await storage.getOutbox(draftEffectId);
    assert.equal(confirmedRecord?.status, "DISPATCHED");

    // Cannot confirm an already dispatched effect
    await assert.rejects(
      () => host.confirmEffect(draftEffectId),
      /expected 'AWAIT_CONFIRMATION'/
    );
  });

  it("7. unhandled effect kind pushes backoff without blocking other effects", async () => {
    const storage = new MemoryStorage();
    const outbox = new OutboxDispatcher(storage, {
      maxAttempts: 3,
      unhandledGraceIntervalMs: 1000,
      maxUnhandledGraceMs: 5000,
    });
    const host = new MowaBrowserHost(kernel, { storage, outboxDispatcher: outbox });
    const { flowHash } = await host.installFlow(sampleFlow());

    // Register handler for INTAKE effect but leave REQUEST_REVIEW unhandled
    let intakeHandled = false;
    outbox.registerHandler("EMIT_INTAKE_NOTIFICATION", async () => {
      intakeHandled = true;
      return "SUCCESS";
    });

    const sessionId = "SESSION_UNHANDLED_TEST";
    await host.startSession({
      sessionId,
      event: {
        id: "E0",
        type: "INIT",
        source: "test",
        caseId: "CASE_UNH",
        timestamp: 1,
        idempotencyKey: "k_unh_0",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      flowHash,
      ctx: { asOf: 1, contextRefs: {} },
    });

    // Advance creates REQUEST_REVIEW which has NO handler registered
    await host.advanceSession({
      sessionId,
      event: {
        id: "E1",
        type: "SUBMIT_DOCS",
        source: "test",
        caseId: "CASE_UNH",
        timestamp: 2,
        idempotencyKey: "k_unh_1",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      facts: { facts: { "doc:invoice": "MISSING" } },
      ctx: { asOf: 2, contextRefs: {} },
    });

    // Intake effect was already handled during startSession
    assert.equal(intakeHandled, true);

    // REQUEST_REVIEW was unhandled: verify it was deferred with grace interval
    const pending = await storage.getPendingOutbox(10, Date.now() + 20000);
    const unhandledRecord = pending.find((p) => p.effect.kind === "REQUEST_REVIEW");
    assert.ok(unhandledRecord);
    assert.equal(unhandledRecord.status, "PENDING");
    assert.ok(unhandledRecord.nextAttemptAt > 0);

    // Register handler now (simulating late registration in service worker)
    let reviewHandled = false;
    outbox.registerHandler("REQUEST_REVIEW", async () => {
      reviewHandled = true;
      return "SUCCESS";
    });

    // Make it immediately due and dispatch
    await storage.updateOutboxStatus(unhandledRecord.outboxId, "PENDING", {
      nextAttemptAt: Date.now() - 100,
    });
    const res = await outbox.dispatchPending();
    assert.equal(res.processed, 1);
    assert.equal(reviewHandled, true);
  });

  it("7b. requeueEffect clears unhandledSince and lastError, giving fresh grace period", async () => {
    const storage = new MemoryStorage();
    const outbox = new OutboxDispatcher(storage, {
      maxAttempts: 3,
      unhandledGraceIntervalMs: 500,
      maxUnhandledGraceMs: 1000,
    });
    const host = new MowaBrowserHost(kernel, { storage, outboxDispatcher: outbox });
    const { flowHash } = await host.installFlow(sampleFlow());

    const sessionId = "SESSION_REQUEUE_GRACE";
    await host.startSession({
      sessionId,
      event: {
        id: "E0",
        type: "INIT",
        source: "test",
        caseId: "CASE_REQ",
        timestamp: 1,
        idempotencyKey: "k_req_0",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      flowHash,
      ctx: { asOf: 1, contextRefs: {} },
    });

    await host.advanceSession({
      sessionId,
      event: {
        id: "E1",
        type: "SUBMIT_DOCS",
        source: "test",
        caseId: "CASE_REQ",
        timestamp: 2,
        idempotencyKey: "k_req_1",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      facts: { facts: { "doc:invoice": "MISSING" } },
      ctx: { asOf: 2, contextRefs: {} },
    });

    const pending = await storage.getPendingOutbox(10, Date.now() + 20000);
    const unhandled = pending.find((p) => p.effect.kind === "REQUEST_REVIEW");
    assert.ok(unhandled);

    // Simulate grace period expiry (past 1000ms)
    await storage.updateOutboxStatus(unhandled.outboxId, "PENDING", {
      unhandledSince: Date.now() - 2000,
      nextAttemptAt: Date.now() - 10,
    });
    await outbox.dispatchPending();

    // Effect should now be in FAILED_DLQ with UNHANDLED_EFFECT_KIND
    const dlqRecord = await storage.getOutbox(unhandled.outboxId);
    assert.equal(dlqRecord?.status, "FAILED_DLQ");
    assert.match(dlqRecord?.lastError ?? "", /UNHANDLED_EFFECT_KIND/);

    // Requeue effect
    await host.requeueEffect(unhandled.outboxId);

    // Verify unhandledSince and lastError are cleared
    const requeuedRecord = await storage.getOutbox(unhandled.outboxId);
    assert.equal(requeuedRecord?.status, "PENDING");
    assert.equal(requeuedRecord?.unhandledSince, undefined);
    assert.equal(requeuedRecord?.lastError, undefined);

    // Run dispatch again without registered handler: should be granted a FRESH grace period, NOT go straight back to DLQ!
    await outbox.dispatchPending();
    const freshRecord = await storage.getOutbox(unhandled.outboxId);
    assert.equal(freshRecord?.status, "PENDING"); // Must still be pending under its new grace period!
  });

  it("8. idempotency conflict: reusing dedupKey with altered event intent throws IdempotencyConflictError", async () => {
    const storage = new MemoryStorage();
    const host = new MowaBrowserHost(kernel, { storage });
    const { flowHash } = await host.installFlow(sampleFlow());

    const sessionId = "SESSION_IDEM_CONFLICT";
    const baseEvent = {
      id: "EVT_BASE",
      type: "INIT",
      source: "client_app",
      caseId: "CASE_IDEM_CONF",
      timestamp: 1000,
      idempotencyKey: "reused_idem_key",
      actor: { type: "SYSTEM", id: "S1" },
      payload: { value: 100 },
    };

    // First call succeeds
    await host.startSession({
      sessionId,
      event: baseEvent,
      flowHash,
      ctx: { asOf: 1000, contextRefs: {} },
    });

    // Replay with exact same intent (even with different ephemeral event id) succeeds idempotently
    const replayEvent = { ...baseEvent, id: "EVT_NEW_EPHEMERAL_ID", timestamp: 1050 };
    const replayCommit = await host.startSession({
      sessionId,
      event: replayEvent,
      flowHash,
      ctx: { asOf: 1000, contextRefs: {} },
    });
    assert.equal(replayCommit.newSession.id, sessionId);

    // Replay with CONFLICTING semantic intent (different payload value) throws IdempotencyConflictError!
    const conflictingEvent = { ...baseEvent, payload: { value: 999 } };
    await assert.rejects(
      () =>
        host.startSession({
          sessionId,
          event: conflictingEvent,
          flowHash,
          ctx: { asOf: 1000, contextRefs: {} },
        }),
      (err) => {
        assert.ok(err instanceof IdempotencyConflictError);
        assert.equal(err.dedupKey, replayCommit.dedupKey);
        return true;
      }
    );
  });

  it("9. wasm cache eviction auto-reload: evicted flow reloads seamlessly from storage", async () => {
    const storage = new MemoryStorage();
    const host = new MowaBrowserHost(kernel, { storage });

    // Install 35 distinct flows to exceed the 32-capacity WASM cache
    const flows = [];
    for (let i = 0; i < 35; i++) {
      const f = {
        ...sampleFlow(),
        id: `FLOW_${i}`,
      };
      const { flowHash } = await host.installFlow(f);
      flows.push({ flowHash, id: `FLOW_${i}` });
    }

    // The first installed flow (FLOW_0) has been evicted from the WASM cache
    const oldest = flows[0];

    // Starting a session with the evicted flow must auto-reload from storage without error!
    const commit = await host.startSession({
      sessionId: "SESSION_RELOAD_TEST",
      event: {
        id: "E0",
        type: "INIT",
        source: "test",
        caseId: "CASE_RELOAD",
        timestamp: 1,
        idempotencyKey: "k_reload",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      flowHash: oldest.flowHash,
      ctx: { asOf: 1, contextRefs: {} },
    });

    assert.equal(commit.newSession.workflowId, oldest.id);
  });

  it("10. concurrent calls on same session serialize with zero CAS conflicts", async () => {
    const storage = new MemoryStorage();
    const lock = new MemorySessionLock();
    const host = new MowaBrowserHost(kernel, { storage, lock });
    const { flowHash } = await host.installFlow(sampleFlow());

    const sessionId = "SESSION_CONCURRENT";
    await host.startSession({
      sessionId,
      event: {
        id: "E_START",
        type: "INIT",
        source: "test",
        caseId: "CASE_CONCUR",
        timestamp: 1,
        idempotencyKey: "k_concur_start",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      flowHash,
      ctx: { asOf: 1, contextRefs: {} },
    });

    // Fire 5 identical requests concurrently
    const promises = Array.from({ length: 5 }, (_, i) =>
      host.advanceSession({
        sessionId,
        event: {
          id: `EVT_CONCUR_${i}`,
          type: "SUBMIT_DOCS",
          source: "action_card",
          caseId: "CASE_CONCUR",
          timestamp: 10 + i,
          idempotencyKey: `idem_concur_identical`, // Same idempotency key!
          actor: { type: "SYSTEM", id: "S" },
          payload: {},
        },
        facts: { facts: { "doc:invoice": "VERIFIED" } },
        ctx: { asOf: 10 + i, contextRefs: {} },
      })
    );

    const results = await Promise.all(promises);

    // All 5 must succeed with the exact same commit and zero CAS errors!
    const firstCommit = results[0];
    for (const r of results) {
      assert.equal(r.newSession.version, 1);
      assert.equal(r.audit.transitionId, firstCommit.audit.transitionId);
    }
  });

  it("11. getOutboxByStatus queries outbox records by status", async () => {
    const storage = new MemoryStorage();
    const outbox = new OutboxDispatcher(storage);
    const host = new MowaBrowserHost(kernel, { storage, outboxDispatcher: outbox });
    const { flowHash } = await host.installFlow(sampleFlow());

    outbox.registerHandler("EMIT_INTAKE_NOTIFICATION", async () => "AWAIT_CONFIRMATION");

    const sessionId = "SESSION_STATUS_QUERY";
    const commit = await host.startSession({
      sessionId,
      event: {
        id: "E0_STATUS",
        type: "START",
        source: "test",
        caseId: "CASE_STATUS",
        timestamp: 1000,
        idempotencyKey: "k_status",
        actor: { type: "SYSTEM", id: "S" },
        payload: {},
      },
      flowHash,
      ctx: { asOf: 1000, contextRefs: {} },
    });

    // Run outbox dispatch to move effect to AWAIT_CONFIRMATION
    await outbox.dispatchPending();

    const pendingConfirmation = await host.getOutboxByStatus("AWAIT_CONFIRMATION");
    assert.equal(pendingConfirmation.length, 1);
    assert.equal(pendingConfirmation[0].outboxId, commit.outbox[0].id);
    assert.equal(pendingConfirmation[0].status, "AWAIT_CONFIRMATION");

    const dispatched = await host.getOutboxByStatus("DISPATCHED");
    assert.equal(dispatched.length, 0);
  });

  it("12. every step's inputs are kept, and an exported bundle replays to identical commits", async () => {
    const storage = new MemoryStorage();
    const host = new MowaBrowserHost(kernel, { storage, outboxDispatcher: new OutboxDispatcher(storage) });
    const { flowHash } = await host.installFlow(sampleFlow());
    const sessionId = "SESSION_REPLAY";
    const ev = (id, type, actor, ts) => ({
      id, type, source: "test", caseId: "CASE_REPLAY", timestamp: ts,
      idempotencyKey: `k_${id}`, actor: { type: actor, id: "u1" }, payload: {},
    });

    await host.startSession({ sessionId, event: ev("E0", "INIT", "SYSTEM", 1000), flowHash, ctx: { asOf: 1000 } });
    const facts = { facts: { "doc:invoice": "MISSING", "other:ignored": "X" } };
    const submit = { sessionId, event: ev("E1", "SUBMIT_DOCS", "OPERATOR", 2000), facts, ctx: { asOf: 2000, contextRefs: { feed: "v1" } } };
    await host.advanceSession(submit);
    await host.advanceSession(submit); // duplicate delivery: returns the stored commit, adds no step
    await host.advanceSession({ sessionId, event: ev("E2", "RESOLVE", "OPERATOR", 3000), ctx: { asOf: 3000 } });

    const steps = await storage.getSteps(sessionId);
    assert.deepEqual(steps.map((s) => [s.call, s.version]), [["start", 0], ["advance", 1], ["advance", 2]]);
    assert.deepEqual(steps[1].facts, facts, "facts are kept exactly as supplied");
    assert.deepEqual(steps[1].ctx, { asOf: 2000, contextRefs: { feed: "v1" } });
    assert.equal(steps[0].facts, undefined, "start takes no facts");

    const bundle = await host.exportVerificationBundle([sessionId], { feed: "reference data v1" });
    assert.equal(bundle.format, "mowa.verification-bundle/1");
    assert.equal(bundle.kernelVersion, wasmPkg.kernelVersion());
    assert.deepEqual(Object.keys(bundle.flows), [flowHash]);
    assert.deepEqual(bundle.contextData, { feed: "reference data v1" });

    // Replay: a verifier with only the bundle and the open kernel reproduces every commit.
    const replayed = JSON.parse(JSON.stringify(bundle)); // as if read from a file
    let session = null;
    for (const step of replayed.sessions[0].steps) {
      const flow = replayed.flows[step.commit.newSession.flowHash];
      const out = JSON.parse(
        step.call === "start"
          ? wasmPkg.startJson(JSON.stringify({ sessionId: replayed.sessions[0].sessionId, event: step.event, flow, ctx: step.ctx }))
          : wasmPkg.advanceJson(JSON.stringify({ session, event: step.event, flow, facts: step.facts, ctx: step.ctx }))
      );
      assert.equal(out.status, "OK");
      assert.deepEqual(out.commit, step.commit, `${step.call} v${step.commit.newSession.version} replays identically`);
      assert.equal(step.commit.audit.prevResultHash, session ? session.lastResultHash : null, "chain link");
      session = out.commit.newSession;
    }
  });

  it("13. export refuses a session without a complete step history", async () => {
    const storage = new MemoryStorage();
    const host = new MowaBrowserHost(kernel, { storage, outboxDispatcher: new OutboxDispatcher(storage) });
    const { flowHash } = await host.installFlow(sampleFlow());
    const commit = await host.startSession({
      sessionId: "S_OLD",
      event: { id: "E", type: "INIT", source: "t", caseId: "C", timestamp: 1, idempotencyKey: "k", actor: { type: "SYSTEM", id: "s" }, payload: {} },
      flowHash,
      ctx: { asOf: 1 },
    });
    // Simulate a session written by an older host: same session, no step records.
    const legacy = new MemoryStorage();
    await legacy.saveFlow(flowHash, sampleFlow());
    await legacy.atomicCommit("S_OLD", null, commit, { intentHash: "x", inputs: { call: "start", event: {}, ctx: {} } });
    legacy.steps.clear();
    const legacyHost = new MowaBrowserHost(kernel, { storage: legacy, outboxDispatcher: new OutboxDispatcher(legacy) });
    await assert.rejects(legacyHost.exportVerificationBundle(["S_OLD"]), (err) => {
      assert.ok(err instanceof IncompleteStepHistoryError);
      assert.equal(err.name, "IncompleteStepHistoryError");
      assert.equal(err.sessionId, "S_OLD");
      assert.equal(err.stepCount, 0);
      assert.equal(err.sessionVersion, 0);
      assert.match(err.message, /incomplete step history/);
      return true;
    });
    await assert.rejects(host.exportVerificationBundle(["NOPE"]), /not found/);
  });

  it("14. the host decides and stores a snapshot of its inputs, not the caller's live objects", async () => {
    // Storage that waits before writing, as IndexedDB does while it opens the database.
    class SlowStorage extends MemoryStorage {
      async atomicCommit(...args) {
        await new Promise((r) => setTimeout(r, 5));
        return super.atomicCommit(...args);
      }
    }
    const storage = new SlowStorage();
    const host = new MowaBrowserHost(kernel, { storage });
    const flow = sampleFlow();
    const { flowHash } = await host.installFlow(flow);
    flow.nodes.INTAKE.type = "changed after install";
    assert.equal((await storage.getFlow(flowHash)).nodes.INTAKE.type, "t", "installed flow is a snapshot");

    // 1. The caller changes its event while the commit is waiting on storage.
    const event = {
      id: "EVT_SNAP", type: "INITIALIZE", source: "test", caseId: "CASE_SNAP", timestamp: 1000,
      idempotencyKey: "idem_snap", actor: { type: "OPERATOR", id: "A" }, payload: { amount: 1 },
    };
    const ctx = { asOf: 1000, contextRefs: { ref: "r1" } };
    const pending = host.startSession({ sessionId: "S_SNAP", event, flowHash, ctx });
    setTimeout(() => { event.payload.amount = 999; ctx.contextRefs.ref = "r2"; }, 1);
    const commit = await pending;
    const [step] = await storage.getSteps("S_SNAP");
    assert.deepEqual(step.event.payload, { amount: 1 });
    assert.deepEqual(step.ctx.contextRefs, { ref: "r1" });
    const replay = kernel.start("S_SNAP", step.event, sampleFlow(), step.ctx);
    assert.equal(replay.audit.resultHash, commit.audit.resultHash, "stored inputs replay to the same commit");

    // 2. A getter is read once, so the dedup key, the decision and the stored step agree.
    let reads = 0;
    const tricky = {
      id: "EVT_GET", type: "INITIALIZE", source: "test", caseId: "CASE_GET", timestamp: 1000,
      actor: { type: "OPERATOR", id: "A" }, payload: {},
    };
    Object.defineProperty(tricky, "idempotencyKey", { enumerable: true, get: () => `k${reads++}` });
    const c2 = await host.startSession({ sessionId: "S_GET", event: tricky, flowHash, ctx: { asOf: 1000, contextRefs: {} } });
    assert.equal(reads, 1);
    const [step2] = await storage.getSteps("S_GET");
    assert.equal(step2.event.idempotencyKey, "k0");
    assert.equal(kernel.start("S_GET", step2.event, sampleFlow(), step2.ctx).audit.resultHash, c2.audit.resultHash);

    // 3. Values JSON cannot carry are rejected at the boundary, not passed on.
    const looped = { ...event, idempotencyKey: "idem_loop" };
    looped.payload = { self: null };
    looped.payload.self = looped.payload;
    await assert.rejects(host.startSession({ sessionId: "S_LOOP", event: looped, flowHash, ctx }), /Validation failed at 'event': not JSON-serialisable/);
  });
});
