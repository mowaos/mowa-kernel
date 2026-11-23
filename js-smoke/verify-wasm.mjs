// WASM interface and in-memory flow cache verification suite
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const pkgDir = new URL("../pkg/", import.meta.url).pathname;
const kernel = require(`${pkgDir}/mowa_wasm.js`);
const expectedVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const call = (fn, req) => JSON.parse(fn(typeof req === "string" ? req : JSON.stringify(req)));

function makeFlow(id = "F", status = "ACTIVE", from = 0, to = null) {
  return {
    id,
    version: "1",
    status,
    startNode: "START",
    startActors: ["SYSTEM", "AGENT"],
    effectiveFrom: from,
    effectiveTo: to,
    declaredFacts: {
      "doc:verified": ["TRUE", "FALSE"]
    },
    nodes: {
      START: {
        id: "START",
        type: "t",
        tier: "T1",
        onEnter: [{ kind: "INITIALIZE" }],
        transitions: {
          STEP: {
            to: "DONE",
            allowedActors: ["SYSTEM", "AGENT"],
            guard: { op: "status_is", target: "doc:verified", status: "TRUE" },
            onGuardFail: "REVIEW"
          }
        }
      },
      REVIEW: {
        id: "REVIEW",
        type: "t",
        tier: "T2",
        transitions: {
          RESOLVE: { to: "DONE", allowedActors: ["AGENT"] }
        }
      },
      DONE: {
        id: "DONE",
        type: "t",
        tier: "T1",
        terminal: true,
        onEnter: [{ kind: "EMIT_COMPLETION" }]
      }
    }
  };
}

const event = (type, actor = "SYSTEM") => ({
  id: "E_1",
  type,
  source: "test_harness",
  caseId: "CASE_001",
  timestamp: 1000,
  idempotencyKey: "idem_key_1",
  actor: { type: actor, id: "ACTOR_1" },
  payload: {}
});

const ctx = { asOf: 50, contextRefs: { policyVer: "1.0" } };
const factsValid = { facts: { "doc:verified": "TRUE" } };

test("1. exports inspection: all required WASM boundaries exist", () => {
  const exports = ["startJson", "advanceJson", "dedupKeyJson", "kernelVersion", "loadFlowJson"];
  for (const exp of exports) {
    assert.equal(typeof kernel[exp], "function", `Missing export: ${exp}`);
  }
  assert.equal(kernel.kernelVersion(), expectedVersion);
});

test("2. loadFlowJson returns valid handle and SHA-256 content hash", () => {
  const flow = makeFlow("FLOW_A");
  const res = call(kernel.loadFlowJson, flow);
  assert.equal(res.status, "OK");
  assert.ok(typeof res.flowHandle === "string" && res.flowHandle.length > 0);
  assert.equal(res.flowHash.length, 64);
  assert.match(res.flowHash, /^[0-9a-f]{64}$/);
});

test("3. byte-for-byte determinism: full flow vs cached flowHandle produce identical commits", () => {
  const flow = makeFlow("FLOW_DET");
  const loadRes = call(kernel.loadFlowJson, flow);
  const handle = loadRes.flowHandle;

  // Start via full flow definition
  const startFull = call(kernel.startJson, { sessionId: "S_1", event: event("OPEN"), flow, ctx });
  // Start via cached handle
  const startCached = call(kernel.startJson, { sessionId: "S_1", event: event("OPEN"), flow: handle, ctx });

  assert.equal(JSON.stringify(startFull), JSON.stringify(startCached));

  const session = startFull.commit.newSession;

  // Advance via full flow definition
  const advFull = call(kernel.advanceJson, { session, event: event("STEP"), flow, facts: factsValid, ctx });
  // Advance via cached handle
  const advCached = call(kernel.advanceJson, { session, event: event("STEP"), flow: handle, facts: factsValid, ctx });

  assert.equal(JSON.stringify(advFull), JSON.stringify(advCached));
  assert.equal(advCached.commit.newSession.state, "DONE");
});

test("4. lifecycle sensitivity: different status or effective window yields different cache key", () => {
  const activeFlow = makeFlow("FLOW_LIFE", "ACTIVE", 0, 100);
  const deprecatedFlow = makeFlow("FLOW_LIFE", "DEPRECATED", 0, 100);
  const windowedFlow = makeFlow("FLOW_LIFE", "ACTIVE", 100, 200);

  const res1 = call(kernel.loadFlowJson, activeFlow);
  const res2 = call(kernel.loadFlowJson, deprecatedFlow);
  const res3 = call(kernel.loadFlowJson, windowedFlow);

  // Content hashes are identical (lifecycle fields excluded from content hash by design)
  assert.equal(res1.flowHash, res2.flowHash);
  assert.equal(res1.flowHash, res3.flowHash);

  // BUT cache handles must be distinct to prevent cache poisoning across lifecycle changes
  assert.notEqual(res1.flowHandle, res2.flowHandle);
  assert.notEqual(res1.flowHandle, res3.flowHandle);

  // Deprecated flow cannot start sessions
  const startDep = call(kernel.startJson, { sessionId: "S_DEP", event: event("OPEN"), flow: res2.flowHandle, ctx });
  assert.equal(startDep.status, "KERNEL_ERROR");
  assert.equal(startDep.error.code, "FLOW_NOT_ACTIVE");
});

test("5. cache eviction & bounded capacity: 40 flows loaded with LRU eviction", () => {
  const handles = [];
  for (let i = 0; i < 40; i++) {
    const flow = makeFlow(`FLOW_${i}`);
    const res = call(kernel.loadFlowJson, flow);
    assert.equal(res.status, "OK");
    handles.push(res.flowHandle);
  }

  // The latest handles must be resolvable and operational
  const latestHandle = handles[handles.length - 1];
  const startRes = call(kernel.startJson, { sessionId: "S_LATEST", event: event("OPEN"), flow: latestHandle, ctx });
  assert.equal(startRes.status, "OK");

  // The oldest handle (FLOW_0) should have been evicted by LRU capacity (32)
  const evictedHandle = handles[0];
  const evictedRes = call(kernel.startJson, { sessionId: "S_EVICTED", event: event("OPEN"), flow: evictedHandle, ctx });
  assert.equal(evictedRes.status, "FLOW_HANDLE_NOT_FOUND");
  assert.equal(evictedRes.handle, evictedHandle);
});

test("6. benchmark: flowHandle avoids re-parsing & hashing overhead", () => {
  const flow = makeFlow("FLOW_BENCH");
  const handle = call(kernel.loadFlowJson, flow).flowHandle;
  const startRes = call(kernel.startJson, { sessionId: "S_BENCH", event: event("OPEN"), flow: handle, ctx });
  const session = startRes.commit.newSession;

  // Warm-up to stabilize JIT
  for (let i = 0; i < 50; i++) {
    call(kernel.advanceJson, { session, event: event("STEP"), flow: handle, facts: factsValid, ctx });
  }

  const iterations = 500;

  // Measure with full FlowDefinition
  const t0 = performance.now();
  let fullCommit;
  for (let i = 0; i < iterations; i++) {
    fullCommit = call(kernel.advanceJson, { session, event: event("STEP"), flow, facts: factsValid, ctx });
  }
  const fullDuration = performance.now() - t0;

  // Measure with cached flowHandle
  const t1 = performance.now();
  let cachedCommit;
  for (let i = 0; i < iterations; i++) {
    cachedCommit = call(kernel.advanceJson, { session, event: event("STEP"), flow: handle, facts: factsValid, ctx });
  }
  const cachedDuration = performance.now() - t1;

  // Verify functional parity
  assert.equal(JSON.stringify(fullCommit), JSON.stringify(cachedCommit));

  console.log(`\n    ⚡ Benchmark (500 transitions):`);
  console.log(`       Full Flow Parsing : ${fullDuration.toFixed(2)} ms (${(fullDuration / iterations * 1000).toFixed(1)} µs/op)`);
  console.log(`       Cached flowHandle : ${cachedDuration.toFixed(2)} ms (${(cachedDuration / iterations * 1000).toFixed(1)} µs/op)`);
  console.log(`       Speedup           : ${(fullDuration / cachedDuration).toFixed(2)}x faster\n`);

  // Assert both completed reliably
  assert.ok(fullDuration > 0 && cachedDuration > 0);
});

test("7. fault injection & instance survivability", () => {
  // Missing flow handle
  const badHandle = call(kernel.advanceJson, {
    session: { id: "S", caseId: "C", workflowId: "W", workflowVersion: "1", flowHash: "H", state: "A", variables: {}, version: 1, createdAt: 0, updatedAt: 0 },
    event: event("E"),
    flow: "nonexistent_flow_handle_xyz",
    facts: {},
    ctx
  });
  assert.equal(badHandle.status, "FLOW_HANDLE_NOT_FOUND");
  assert.equal(badHandle.handle, "nonexistent_flow_handle_xyz");

  // Malformed JSON strings to all exports
  assert.equal(call(kernel.loadFlowJson, "{bad json").status, "BAD_REQUEST");
  assert.equal(call(kernel.startJson, "{bad json").status, "BAD_REQUEST");
  assert.equal(call(kernel.advanceJson, "{bad json").status, "BAD_REQUEST");
  assert.equal(call(kernel.dedupKeyJson, "{bad json").status, "BAD_REQUEST");

  // Float numbers (strictly banned)
  assert.equal(call(kernel.loadFlowJson, JSON.stringify({ ...makeFlow(), effectiveFrom: 1.5 })).status, "BAD_REQUEST");

  // The instance is still fully operational after all bad inputs
  const goodFlow = makeFlow("GOOD");
  const goodHandle = call(kernel.loadFlowJson, goodFlow).flowHandle;
  const goodStart = call(kernel.startJson, { sessionId: "S_GOOD", event: event("OPEN"), flow: goodHandle, ctx });
  assert.equal(goodStart.status, "OK");
});
