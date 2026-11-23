// Node smoke test for the mowa-wasm boundary, run against the real .wasm binary.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const pkgDir = process.env.MOWA_WASM_PKG ?? new URL("../pkg/", import.meta.url).pathname;
const kernel = require(`${pkgDir}/mowa_wasm.js`);

const flow = {
  id: "F",
  version: "1",
  status: "ACTIVE",
  startNode: "A",
  startActors: ["SYSTEM"],
  effectiveFrom: 0,
  declaredFacts: {
    "doc:invoice": ["VERIFIED", "MISSING"]
  },
  nodes: {
    A: {
      id: "A",
      type: "t",
      tier: "T1",
      transitions: {
        go: {
          to: "B",
          allowedActors: ["SYSTEM"],
          guard: { op: "status_is", target: "doc:invoice", status: "VERIFIED" },
          onGuardFail: "B"
        }
      }
    },
    B: { id: "B", type: "t", tier: "T1", terminal: true }
  }
};

const event = (type) => ({
  id: "E",
  type,
  source: "t",
  caseId: "C",
  timestamp: 1,
  idempotencyKey: "k",
  actor: { type: "SYSTEM", id: "x" },
  payload: {}
});

const ctx = { asOf: 10, contextRefs: { snapshotId: "S1" } };
const facts = { facts: { "doc:invoice": "VERIFIED" } };

const call = (fn, req) => JSON.parse(fn(typeof req === "string" ? req : JSON.stringify(req)));
const startReq = { sessionId: "S", event: event("OPEN"), flow, ctx };

const started = () => {
  const out = call(kernel.startJson, startReq);
  assert.equal(out.status, "OK", JSON.stringify(out));
  return out.commit.newSession;
};

const advanceReq = (session, type) => ({ session, event: event(type), flow, facts, ctx });

test("exports the expected functions", () => {
  for (const name of ["startJson", "advanceJson", "dedupKeyJson", "kernelVersion", "loadFlowJson"]) {
    assert.equal(typeof kernel[name], "function", name);
  }
  assert.match(kernel.kernelVersion(), /\S/);
});

test("start creates a genesis session committed as an INSERT", () => {
  const out = call(kernel.startJson, startReq);
  assert.equal(out.status, "OK");
  assert.equal(out.commit.newSession.state, "A");
  assert.equal(out.commit.newSession.version, 0);
  assert.equal(out.commit.expectedSessionVersion, null);
});

test("start then advance round-trips through JSON", () => {
  const out = call(kernel.advanceJson, advanceReq(started(), "go"));
  assert.equal(out.status, "OK", JSON.stringify(out));
  assert.equal(out.commit.newSession.state, "B");
  assert.equal(out.commit.expectedSessionVersion, 0);
});

test("loadFlowJson caches flow and returns handle used in start and advance", () => {
  const loadOut = call(kernel.loadFlowJson, flow);
  assert.equal(loadOut.status, "OK", JSON.stringify(loadOut));
  assert.ok(loadOut.flowHandle && loadOut.flowHandle.length > 0);
  assert.ok(loadOut.flowHash && loadOut.flowHash.length === 64);

  const handle = loadOut.flowHandle;

  // Use flow handle directly in startJson
  const cachedStartReq = { sessionId: "S_CACHED", event: event("OPEN"), flow: handle, ctx };
  const startOut = call(kernel.startJson, cachedStartReq);
  assert.equal(startOut.status, "OK", JSON.stringify(startOut));
  const session = startOut.commit.newSession;

  // Use flow handle directly in advanceJson
  const cachedAdvReq = { session, event: event("go"), flow: handle, facts, ctx };
  const advOut = call(kernel.advanceJson, cachedAdvReq);
  assert.equal(advOut.status, "OK", JSON.stringify(advOut));
  assert.equal(advOut.commit.newSession.state, "B");
});

test("dedupKeyJson matches the key inside the commit", () => {
  const commit = call(kernel.advanceJson, advanceReq(started(), "go")).commit;
  const out = call(kernel.dedupKeyJson, { op: "ADVANCE", sessionId: "S", event: event("go") });
  assert.equal(out.status, "OK");
  assert.equal(out.dedupKey, commit.dedupKey);

  const startCommit = call(kernel.startJson, startReq).commit;
  const s = call(kernel.dedupKeyJson, { op: "START", sessionId: "S", event: event("OPEN") });
  assert.equal(s.dedupKey, startCommit.dedupKey);
});

test("identical inputs give byte-identical output (determinism)", () => {
  const req = JSON.stringify(advanceReq(started(), "go"));
  assert.equal(kernel.advanceJson(req), kernel.advanceJson(req));
});

test("kernel errors are structured", () => {
  const out = call(kernel.advanceJson, advanceReq(started(), "nope"));
  assert.equal(out.status, "KERNEL_ERROR");
  assert.equal(out.error.code, "NO_TRANSITION");
});

test("an invalid flow returns FLOW_INVALID", () => {
  const bad = structuredClone(flow);
  bad.nodes.A.transitions.go.to = "MISSING";
  const out = call(kernel.startJson, { ...startReq, flow: bad });
  assert.equal(out.status, "FLOW_INVALID", JSON.stringify(out));
  assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
});

test("malformed input returns BAD_REQUEST and never traps the instance", () => {
  const junk = ["", "{not json", "null", "[]", '{"extra":1}', "\u0000", "9".repeat(10000)];
  for (const fn of [kernel.startJson, kernel.advanceJson, kernel.dedupKeyJson, kernel.loadFlowJson]) {
    for (const input of junk) assert.equal(call(fn, input).status, "BAD_REQUEST", input.slice(0, 20));
  }
  // Floats are banned by the canonical value model.
  const withFloat = { ...startReq, ctx: { ...ctx, asOf: 1.5 } };
  assert.equal(call(kernel.startJson, withFloat).status, "BAD_REQUEST");
  // The same instance still works after all of that.
  assert.equal(call(kernel.startJson, startReq).status, "OK");
});
