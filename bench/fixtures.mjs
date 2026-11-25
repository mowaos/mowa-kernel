// Benchmark inputs, shared by every runtime (Node, browser, native Rust) so all of
// them time exactly the same requests. No imports: this file runs anywhere.

export const FLOW_SIZES = [3, 50, 200];

export const CTX = { asOf: 1000, contextRefs: { policy: "v1" } };
export const FACTS = { facts: { "check:ok": "TRUE" } };

/** A chain N0 → N1 → … → N(size-2), plus a REVIEW node; every step is guarded. */
export function chainFlow(size) {
  const nodes = {};
  const last = size - 2;
  for (let i = 0; i <= last; i += 1) {
    const id = `N${i}`;
    nodes[id] =
      i === last
        ? { id, type: "t", tier: "T1", terminal: true, onEnter: [{ kind: "DONE" }] }
        : {
            id,
            type: "t",
            tier: "T1",
            onEnter: [{ kind: "ENTERED", payload: { step: i } }],
            transitions: {
              STEP: {
                to: `N${i + 1}`,
                allowedActors: ["OPERATOR"],
                guard: { op: "status_is", target: "check:ok", status: "TRUE" },
                onGuardFail: "REVIEW",
              },
            },
          };
  }
  nodes.REVIEW = {
    id: "REVIEW",
    type: "t",
    tier: "T2",
    transitions: { RESOLVE: { to: "N1", allowedActors: ["OPERATOR"] } },
  };
  return {
    id: `bench.chain.${size}`,
    version: "1",
    status: "ACTIVE",
    startNode: "N0",
    startActors: ["OPERATOR"],
    effectiveFrom: 0,
    declaredFacts: { "check:ok": ["TRUE", "FALSE"] },
    nodes,
  };
}

export function event(id, type, timestamp) {
  return {
    id,
    type,
    source: "bench",
    caseId: "CASE_BENCH",
    timestamp,
    idempotencyKey: `idem-${id}`,
    actor: { type: "OPERATOR", id: "op-1" },
    payload: {},
  };
}

/**
 * Build the request strings for one flow size. `kernel` is any object with the
 * kernel's JSON boundary (loadFlowJson, startJson, advanceJson).
 */
export function buildRequests(kernel, size) {
  const flow = chainFlow(size);
  const loaded = JSON.parse(kernel.loadFlowJson(JSON.stringify(flow)));
  if (loaded.status !== "OK") throw new Error(`flow ${size} rejected: ${JSON.stringify(loaded)}`);
  const handle = loaded.flowHandle;

  const startReq = { sessionId: "S_BENCH", event: event("E0", "OPEN", 1000), flow, ctx: CTX };
  const started = JSON.parse(kernel.startJson(JSON.stringify(startReq)));
  if (started.status !== "OK") throw new Error(`start ${size} failed: ${JSON.stringify(started)}`);

  const advanceObj = (f) => ({
    session: started.commit.newSession,
    event: event("E1", "STEP", 2000),
    flow: f,
    facts: FACTS,
    ctx: CTX,
  });

  return {
    size,
    flowBytes: JSON.stringify(flow).length,
    flow,
    handle,
    startFull: JSON.stringify(startReq),
    startHandle: JSON.stringify({ ...startReq, flow: handle }),
    advanceFull: JSON.stringify(advanceObj(flow)),
    advanceHandle: JSON.stringify(advanceObj(handle)),
    advanceHandleObj: advanceObj(handle),
  };
}
