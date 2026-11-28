// The shared host conformance suite (packages/host-browser/tests/host-suite.mjs) on
// SqliteStorage, plus what only a database file can show: a commit that fails part-way
// leaves nothing behind, and a closed database reopens with every case intact.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import * as lib from "@mowaos/host-browser";
import { hostSuite } from "../../host-browser/tests/host-suite.mjs";
import { SqliteStorage } from "../dist/index.js";

// Same filter as the CLI: node:sqlite's "experimental" warning is noise in the test log.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (String(w instanceof Error ? w.message : w).includes("SQLite")) return;
  emit.call(process, w, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");

const require = createRequire(import.meta.url);
const wasmPkg = require("../../../pkg/mowa_wasm.js");
const dir = mkdtempSync(join(tmpdir(), "mowa-host-conformance-"));
let files = 0;
const dbs = new WeakMap();

function makeStorage(file = join(dir, `case-${files++}.db`)) {
  const db = new DatabaseSync(file);
  const storage = new SqliteStorage(db);
  dbs.set(storage, db);
  return storage;
}

hostSuite("SqliteStorage", {
  lib,
  wasmPkg,
  makeStorage: () => makeStorage(),
  clearSteps: (storage) => dbs.get(storage).exec("DELETE FROM steps"),
});

describe("SqliteStorage only", () => {
  const kernel = new lib.WasmKernelBridge(wasmPkg);
  const flow = {
    id: "SQLITE_FLOW",
    version: "1",
    status: "ACTIVE",
    startNode: "OPEN",
    startActors: ["SYSTEM"],
    effectiveFrom: 0,
    declaredFacts: {},
    nodes: {
      OPEN: {
        id: "OPEN", type: "t", tier: "T1", onEnter: [{ kind: "OPENED" }],
        transitions: { NEXT: { to: "MIDDLE", allowedActors: ["SYSTEM"] } },
      },
      MIDDLE: {
        id: "MIDDLE", type: "t", tier: "T1", onEnter: [{ kind: "MOVED" }],
        transitions: { NEXT: { to: "DONE", allowedActors: ["SYSTEM"] } },
      },
      DONE: { id: "DONE", type: "t", tier: "T1", terminal: true },
    },
  };
  const ev = (id, type, ts) => ({
    id, type, source: "test", caseId: "CASE_SQL", timestamp: ts,
    idempotencyKey: `k_${id}`, actor: { type: "SYSTEM", id: "S" }, payload: {},
  });
  const ctx = (asOf) => ({ asOf, contextRefs: {} });

  it("a commit that fails part-way through rolls back every write", async () => {
    const storage = makeStorage();
    const host = new lib.MowaBrowserHost(kernel, { storage });
    const { flowHash } = await host.installFlow(flow);
    const start = await host.startSession({ sessionId: "S_ROLLBACK", event: ev("E0", "INIT", 1), flowHash, ctx: ctx(1) });

    // The right expected version, but a duplicate-record key that already exists: the
    // session row is written first, then the duplicate insert fails.
    const next = kernel.advance(start.newSession, ev("E1", "NEXT", 2), flow, { facts: {} }, ctx(2));
    const clash = { ...next, dedupKey: start.dedupKey };
    const inputs = { call: "advance", event: ev("E1", "NEXT", 2), facts: { facts: {} }, ctx: ctx(2) };
    await assert.rejects(storage.atomicCommit("S_ROLLBACK", 0, clash, { intentHash: "x", inputs }), /UNIQUE/);

    const session = await storage.getSession("S_ROLLBACK");
    assert.equal(session.version, 0, "session row rolled back");
    assert.equal(session.state, "OPEN");
    assert.equal(await storage.getAudit(next.audit.transitionId), null, "no audit record");
    assert.equal((await storage.getSteps("S_ROLLBACK")).length, 1, "no step record");
    for (const effect of next.outbox) assert.equal(await storage.getOutbox(effect.id), null, "no outbox record");

    // The case is not stuck: the real commit still goes through.
    await storage.atomicCommit("S_ROLLBACK", 0, next, { intentHash: "y", inputs });
    assert.equal((await storage.getSession("S_ROLLBACK")).version, 1);
  });

  it("a closed database reopens with its cases, carries on, and exports a bundle that replays", async () => {
    const file = join(dir, "reopen.db");
    const first = makeStorage(file);
    const host1 = new lib.MowaBrowserHost(kernel, { storage: first });
    const { flowHash } = await host1.installFlow(flow);
    await host1.startSession({ sessionId: "S_REOPEN", event: ev("E0", "INIT", 1), flowHash, ctx: ctx(1) });
    const step1 = await host1.advanceSession({ sessionId: "S_REOPEN", event: ev("E1", "NEXT", 2), ctx: ctx(2) });
    dbs.get(first).close();

    const second = makeStorage(file);
    const host2 = new lib.MowaBrowserHost(kernel, { storage: second });
    const reopened = await second.getSession("S_REOPEN");
    assert.deepEqual(reopened, step1.newSession, "session survives the reopen");
    // A repeated request after the reopen still returns the stored commit.
    const again = await host2.advanceSession({ sessionId: "S_REOPEN", event: ev("E1", "NEXT", 2), ctx: ctx(2) });
    assert.equal(again.audit.transitionId, step1.audit.transitionId);
    const step2 = await host2.advanceSession({ sessionId: "S_REOPEN", event: ev("E2", "NEXT", 3), ctx: ctx(3) });
    assert.equal(step2.newSession.state, "DONE");
    assert.equal(step2.audit.prevResultHash, step1.audit.resultHash, "chain continues across the reopen");

    const bundle = await host2.exportVerificationBundle(["S_REOPEN"]);
    const { verifyBundle } = await import("@mowaos/verify");
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.totalStepsVerified, 3);
  });
});
