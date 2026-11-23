// Independent implementation of docs/hashing-spec.md in plain JavaScript, with no
// kernel code. Shared by the spec and conformance tests.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// Canonical JSON (RFC 8785 subset): sorted keys (UTF-16 order, which is JS's default
// sort), no whitespace, integers only. JSON.stringify's string escaping matches JCS.
export function canon(x) {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
  return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + canon(x[k])).join(",") + "}";
}
export const H = (x) => createHash("sha256").update(canon(x), "utf8").digest("hex");

// Sets (startActors, allowedActors): duplicates removed, sorted by UTF-8 bytes (section 3).
const sortedSet = (xs) => [...new Set(xs)].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));

// A flow as the kernel sees it after defaults are applied (spec section 4.1).
export function flowContent(f) {
  const nodes = {};
  for (const [id, n] of Object.entries(f.nodes)) {
    const transitions = {};
    for (const [key, t] of Object.entries(n.transitions ?? {})) {
      transitions[key] = {
        to: t.to,
        allowedActors: sortedSet(t.allowedActors),
        guard: t.guard ?? null,
        onGuardFail: t.onGuardFail ?? null,
      };
    }
    nodes[id] = {
      id: n.id,
      type: n.type,
      tier: n.tier,
      terminal: n.terminal ?? false,
      transitions,
      onEnter: (n.onEnter ?? []).map((e) => ({ kind: e.kind, payload: e.payload ?? null })),
    };
  }
  return {
    id: f.id,
    version: f.version,
    startNode: f.startNode,
    startActors: sortedSet(f.startActors),
    description: f.description ?? null,
    declaredFacts: f.declaredFacts ?? {},
    nodes,
  };
}

export const withDefaults = (e) => ({ effectiveAt: null, payload: {}, ...e });

export function expectedHashes(op, sessionId, fromVersion, event, facts, ctx, flow) {
  const declared = flow.declaredFacts ?? {};
  const kept = Object.fromEntries(Object.entries(facts?.facts ?? {}).filter(([k]) => k in declared));
  const flowHash = H(flowContent(flow));
  const eventHash = H(withDefaults(event));
  const factsHash = H({ facts: kept });
  const decisionHash = H({
    caseId: event.caseId,
    eventHash,
    workflowVersion: flow.version,
    flowHash,
    contextRefs: ctx.contextRefs ?? {},
    factsHash,
  });
  const from = fromVersion === null ? null : String(fromVersion);
  const transitionId = "tr_" + H({ sessionId, fromVersion: from, eventHash }).slice(0, 32);
  const dedupKey = H({ op, sessionId, caseId: event.caseId, idempotencyKey: event.idempotencyKey });
  return { flowHash, factsHash, decisionHash, transitionId, dedupKey };
}

export function check(commit, expected) {
  assert.equal(commit.audit.flowHash, expected.flowHash, "flowHash");
  assert.equal(commit.audit.factsHash, expected.factsHash, "factsHash");
  assert.equal(commit.audit.decisionHash, expected.decisionHash, "decisionHash");
  assert.equal(commit.audit.transitionId, expected.transitionId, "transitionId");
  assert.equal(commit.dedupKey, expected.dedupKey, "dedupKey");
  commit.outbox.forEach((effect, i) => {
    assert.equal(effect.id, H({ transitionId: expected.transitionId, index: String(i) }).slice(0, 32), "effectId");
  });
}

export function resultHashOf(commit) {
  const session = { ...commit.newSession, lastResultHash: null };
  const audit = { ...commit.audit, resultHash: "" };
  return H([session, audit, commit.outbox, commit.expectedSessionVersion]);
}

