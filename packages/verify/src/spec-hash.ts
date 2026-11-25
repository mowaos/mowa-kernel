/**
 * Independent implementation of docs/hashing-spec.md in plain TypeScript, sharing no
 * code with the Rust/WASM kernel. SHA-256 comes from `node:crypto` in Node and from a
 * plain TypeScript implementation elsewhere (package.json "imports": "#sha256").
 */
import { sha256HexUtf8 } from "#sha256";

const utf8 = new TextEncoder();

/** Compare two strings by their UTF-8 bytes, as the spec orders sets. */
function compareUtf8(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

export function canon(x: unknown): string {
  if (x === null || typeof x !== "object") {
    return JSON.stringify(x);
  }
  if (Array.isArray(x)) {
    return "[" + x.map(canon).join(",") + "]";
  }
  const obj = x as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canon(obj[k])).join(",") +
    "}"
  );
}

export function sha256Hex(x: unknown): string {
  return sha256HexUtf8(canon(x));
}

function sortedSet(xs: unknown): string[] {
  if (!Array.isArray(xs)) return [];
  return [...new Set(xs.map(String))].sort(compareUtf8);
}

export function flowContent(f: Record<string, unknown>): Record<string, unknown> {
  const rawNodes = (f.nodes ?? {}) as Record<string, Record<string, unknown>>;
  const nodes: Record<string, unknown> = {};

  for (const [id, n] of Object.entries(rawNodes)) {
    const rawTransitions = (n.transitions ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const transitions: Record<string, unknown> = {};
    for (const [key, t] of Object.entries(rawTransitions)) {
      transitions[key] = {
        to: t.to,
        allowedActors: sortedSet(t.allowedActors),
        guard: t.guard ?? null,
        onGuardFail: t.onGuardFail ?? null,
      };
    }

    const rawOnEnter = Array.isArray(n.onEnter)
      ? (n.onEnter as Array<Record<string, unknown>>)
      : [];
    nodes[id] = {
      id: n.id,
      type: n.type,
      tier: n.tier,
      terminal: n.terminal ?? false,
      transitions,
      onEnter: rawOnEnter.map((e) => ({
        kind: e.kind,
        payload: e.payload ?? null,
      })),
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

export function flowHashOf(flow: Record<string, unknown>): string {
  return sha256Hex(flowContent(flow));
}

export function withEventDefaults(
  event: Record<string, unknown>
): Record<string, unknown> {
  return { effectiveAt: null, payload: {}, ...event };
}

export interface ExpectedHashes {
  flowHash: string;
  factsHash: string;
  decisionHash: string;
  transitionId: string;
  dedupKey: string;
}

export function expectedHashes(
  op: "start" | "advance",
  sessionId: string,
  fromVersion: number | null,
  event: Record<string, unknown>,
  facts: Record<string, unknown> | undefined,
  ctx: Record<string, unknown>,
  flow: Record<string, unknown>
): ExpectedHashes {
  const declared = (flow.declaredFacts ?? {}) as Record<string, unknown>;
  const rawFacts = (facts?.facts ?? {}) as Record<string, unknown>;
  const kept = Object.fromEntries(
    Object.entries(rawFacts).filter(([k]) => Object.hasOwn(declared, k))
  );

  const flowHash = flowHashOf(flow);
  const eventHash = sha256Hex(withEventDefaults(event));
  const factsHash = sha256Hex({ facts: kept });
  const decisionHash = sha256Hex({
    caseId: event.caseId,
    eventHash,
    workflowVersion: flow.version,
    flowHash,
    contextRefs: ctx.contextRefs ?? {},
    factsHash,
  });
  const from = fromVersion === null ? null : String(fromVersion);
  const transitionId =
    "tr_" + sha256Hex({ sessionId, fromVersion: from, eventHash }).slice(0, 32);
  const dedupKey = sha256Hex({
    op,
    sessionId,
    caseId: event.caseId,
    idempotencyKey: event.idempotencyKey,
  });

  return { flowHash, factsHash, decisionHash, transitionId, dedupKey };
}

export function effectIdOf(transitionId: string, index: number): string {
  return sha256Hex({ transitionId, index: String(index) }).slice(0, 32);
}

export function resultHashOf(commit: {
  newSession: Record<string, unknown>;
  audit: Record<string, unknown>;
  outbox: unknown[];
  expectedSessionVersion: number | null;
}): string {
  const session = { ...commit.newSession, lastResultHash: null };
  const audit = { ...commit.audit, resultHash: "" };
  return sha256Hex([
    session,
    audit,
    commit.outbox,
    commit.expectedSessionVersion,
  ]);
}
