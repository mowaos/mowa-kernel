/**
 * Runtime boundary validation.
 * Validates untrusted input crossing network/extension boundaries.
 *
 * Every validator first takes a snapshot of its input (a JSON round trip, which is the
 * form the kernel receives), then checks and returns the snapshot. The host only ever
 * uses that snapshot, so what is hashed, decided and stored as the step's inputs is the
 * same data, even if the caller changes its object afterwards or a property is a getter.
 * Unknown fields are kept, so the kernel still rejects them rather than the host
 * silently dropping them.
 */

import type {
  CanonicalEvent,
  DecisionContext,
  DecisionFacts,
  FlowDefinition,
} from "./types.js";

export class ValidationError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`Validation failed at '${path}': ${message}`);
    this.name = "ValidationError";
  }
}

function assertString(val: unknown, path: string): asserts val is string {
  if (typeof val !== "string" || val.length === 0) {
    throw new ValidationError(path, "expected non-empty string");
  }
}

function assertInteger(val: unknown, path: string): asserts val is number {
  if (typeof val !== "number" || !Number.isSafeInteger(val)) {
    throw new ValidationError(path, "expected safe integer");
  }
}

function snapshot(val: unknown, path: string): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(val);
  } catch (err) {
    throw new ValidationError(path, `not JSON-serialisable (${err instanceof Error ? err.message : String(err)})`);
  }
  if (text === undefined) {
    throw new ValidationError(path, "not JSON-serialisable");
  }
  return JSON.parse(text) as unknown;
}

function assertObject(
  val: unknown,
  path: string
): asserts val is Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    throw new ValidationError(path, "expected non-null object");
  }
}

export function validateCanonicalEvent(raw: unknown): CanonicalEvent {
  const input = snapshot(raw, "event");
  assertObject(input, "event");
  assertString(input.id, "event.id");
  assertString(input.type, "event.type");
  assertString(input.source, "event.source");
  assertString(input.caseId, "event.caseId");
  assertInteger(input.timestamp, "event.timestamp");
  assertString(input.idempotencyKey, "event.idempotencyKey");

  assertObject(input.actor, "event.actor");
  assertString(input.actor.type, "event.actor.type");
  assertString(input.actor.id, "event.actor.id");

  if (input.effectiveAt !== undefined && input.effectiveAt !== null) {
    assertInteger(input.effectiveAt, "event.effectiveAt");
  }

  assertObject(input.payload ?? {}, "event.payload");

  return input as unknown as CanonicalEvent;
}

export function validateDecisionContext(raw: unknown): DecisionContext {
  const input = snapshot(raw, "context");
  assertObject(input, "context");
  assertInteger(input.asOf, "context.asOf");

  const refs = input.contextRefs ?? {};
  assertObject(refs, "context.contextRefs");
  for (const [k, v] of Object.entries(refs)) {
    assertString(k, `context.contextRefs.${k}`);
    assertString(v, `context.contextRefs.${k}`);
  }

  return {
    asOf: input.asOf,
    contextRefs: refs as Record<string, string>,
  };
}

export function validateDecisionFacts(raw: unknown): DecisionFacts {
  if (raw === undefined || raw === null) {
    return { facts: {} };
  }
  const input = snapshot(raw, "facts");
  assertObject(input, "facts");
  const factsObj = input.facts ?? {};
  assertObject(factsObj, "facts.facts");
  for (const [k, v] of Object.entries(factsObj)) {
    assertString(k, `facts.facts.${k}`);
    assertString(v, `facts.facts.${k}`);
  }

  return { facts: factsObj as Record<string, string> };
}

export function validateFlowDefinition(raw: unknown): FlowDefinition {
  const input = snapshot(raw, "flow");
  assertObject(input, "flow");
  assertString(input.id, "flow.id");
  assertString(input.version, "flow.version");
  assertString(input.status, "flow.status");
  if (!["DRAFT", "ACTIVE", "DEPRECATED"].includes(input.status)) {
    throw new ValidationError(
      "flow.status",
      "expected DRAFT, ACTIVE, or DEPRECATED"
    );
  }
  assertString(input.startNode, "flow.startNode");
  if (!Array.isArray(input.startActors) || input.startActors.length === 0) {
    throw new ValidationError(
      "flow.startActors",
      "expected non-empty array of strings"
    );
  }
  for (let i = 0; i < input.startActors.length; i++) {
    assertString(input.startActors[i], `flow.startActors[${i}]`);
  }

  assertInteger(input.effectiveFrom, "flow.effectiveFrom");
  if (input.effectiveTo !== undefined && input.effectiveTo !== null) {
    assertInteger(input.effectiveTo, "flow.effectiveTo");
  }

  assertObject(input.nodes, "flow.nodes");
  if (Object.keys(input.nodes).length === 0) {
    throw new ValidationError("flow.nodes", "expected non-empty nodes object");
  }

  return input as unknown as FlowDefinition;
}
