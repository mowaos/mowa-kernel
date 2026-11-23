/**
 * Runtime boundary validation.
 * Validates untrusted input crossing network/extension boundaries.
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

function assertObject(
  val: unknown,
  path: string
): asserts val is Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    throw new ValidationError(path, "expected non-null object");
  }
}

export function validateCanonicalEvent(input: unknown): CanonicalEvent {
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

export function validateDecisionContext(input: unknown): DecisionContext {
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

export function validateDecisionFacts(input: unknown): DecisionFacts {
  if (input === undefined || input === null) {
    return { facts: {} };
  }
  assertObject(input, "facts");
  const factsObj = input.facts ?? {};
  assertObject(factsObj, "facts.facts");
  for (const [k, v] of Object.entries(factsObj)) {
    assertString(k, `facts.facts.${k}`);
    assertString(v, `facts.facts.${k}`);
  }

  return { facts: factsObj as Record<string, string> };
}

export function validateFlowDefinition(input: unknown): FlowDefinition {
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
