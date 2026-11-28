# Kernel specification

The kernel is a pure function. Given a flow, a session, an event, facts and a decision
context, it returns either a **commit** (the new session state, an audit record and the
effects to carry out) or an **error**. It reads no clock, performs no I/O, keeps no
state between calls and never stores anything. Identical inputs always give
byte-identical output.

This document defines that behaviour for kernel 0.5, precisely enough to write a second
implementation. The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

- Flow format: [flow-spec.md](flow-spec.md).
- Hashes and identifiers: [hashing-spec.md](hashing-spec.md).
- What a host must do with the output: [host-contract.md](host-contract.md).
- Conformance cases: [`vectors/kernel-conformance.json`](vectors/kernel-conformance.json).

## 1. Operations

| Operation | Inputs | Output |
| --- | --- | --- |
| `start` | session id, event, flow, context | A commit creating version 0 of a new session |
| `advance` | session, event, flow, facts, context | A commit moving the session one step |
| `dedupKey` | `START` or `ADVANCE`, session id, event | The duplicate-detection key and intent hash (section 7) |
| `loadFlow` | flow | The flow hash, or the validation errors (flow-spec.md, section 9) |

`start` and `advance` MUST only run on a flow that passed validation.

## 2. Inputs

Every input object rejects fields it does not define (`BAD_REQUEST`). Integers follow
hashing-spec.md, section 2. Times are integers in epoch milliseconds.

### 2.1 Event

The cause of a step: something that happened, proposed by a person, the host, an
integration or an AI model.

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `id` | string | yes | | Unique id of this event, chosen by the host |
| `type` | string | yes | | Event type: the transition key looked up on the current node |
| `source` | string | yes | | Where the event came from (e.g. `ui`, `email-ingest`, `model:x@3`) |
| `caseId` | string | yes | | The case the event belongs to |
| `timestamp` | integer | yes | | When the event occurred, as reported by its source |
| `effectiveAt` | integer or null | no | `null` | Reserved for business effective time; recorded, not interpreted |
| `idempotencyKey` | string | yes | | The sender's retry key (section 7) |
| `actor` | `{type: string, id: string}` | yes | | Who proposed the event (flow-spec.md, section 7) |
| `payload` | object (integers only) | no | `{}` | Extra data. Not read by the kernel; included in the event hash |

The whole event, with defaults applied, is hashed into `eventHash`. The kernel decides
using only `type`, `caseId` and `actor.type`; the event `timestamp` is never used as the
decision time.

### 2.2 Decision context

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `asOf` | integer | yes | | The decision time, supplied by the host. The kernel has no clock |
| `contextRefs` | object: string → string | no | `{}` | Versions of everything outside the flow the decision relied on, e.g. `{"feed:sanctions": "2026-11-01@<hash>"}` |

`contextRefs` is recorded in the audit and covered by the decision hash, so each
decision records which external data versions applied.

### 2.3 Facts

`{"facts": {name: status, …}}`, default `{"facts": {}}`. Facts are categorical statuses
computed by the host, e.g. `"check:screening": "PASS"`. Only facts declared by the flow
are used (section 4, steps 6–7).

### 2.4 Session

A session is the state of one case in one flow. The kernel creates it in `start`,
returns a new version from every `advance`, and the host stores it and passes it back
unchanged.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Session id, chosen by the host |
| `caseId` | string | The case, copied from the start event |
| `workflowId`, `workflowVersion` | string | The flow's `id` and `version` |
| `flowHash` | string | The flow hash the session is pinned to |
| `state` | string | Current node key |
| `variables` | object | Reserved for future use. `start` sets `{}`; `advance` copies it unchanged |
| `version` | integer | 0 after `start`, +1 per `advance` |
| `createdAt` | integer | `asOf` of the `start` |
| `updatedAt` | integer | `asOf` of the latest step |
| `lastResultHash` | string or null | `resultHash` of the commit that produced this version |

## 3. Start

`start(sessionId, event, flow, ctx)` runs these checks in order and returns the first
error:

1. `flow.status` is `ACTIVE`, else `FLOW_NOT_ACTIVE`.
2. `flow.effectiveFrom ≤ ctx.asOf`, and `ctx.asOf < flow.effectiveTo` when
   `effectiveTo` is set, else `OUTSIDE_EFFECTIVE_WINDOW`.
3. `event.actor.type` is in `flow.startActors`, else `START_UNAUTHORIZED`.

Then it builds the commit:

- **Session:** `id` = `sessionId`; `caseId` = `event.caseId`; `workflowId`,
  `workflowVersion` and `flowHash` from the flow; `state` = `startNode`;
  `variables` = `{}`; `version` = 0; `createdAt` = `updatedAt` = `ctx.asOf`.
- **Facts:** none. The facts hash is computed over `{"facts": {}}`.
- **Effects:** the start node's `onEnter` list.
- **Audit:** `fromVersion`, `fromState`, `resolvedKey` and `prevResultHash` are `null`;
  `guardFailed` is `false`.
- **Concurrency predicate:** `expectedSessionVersion` = `null`, meaning the host MUST
  insert the session and fail if one with that id already exists.

The event `type` is recorded but not matched against any transition; by convention it
is a name such as `SESSION_INITIALIZED`.

## 4. Advance

`advance(session, event, flow, facts, ctx)` runs these checks **in this order** and
returns the first error. The order is part of the specification: two implementations
must report the same error for the same inputs.

1. `flow.status` is not `DRAFT`, else `FLOW_NOT_ACTIVE`. (`DEPRECATED` is allowed, and
   the effective window is not checked: running sessions always finish.)
2. `session.workflowId` = `flow.id` and `session.workflowVersion` = `flow.version`, else
   `WORKFLOW_MISMATCH`.
3. `session.flowHash` = the flow's hash, else `FLOW_HASH_MISMATCH`.
4. `event.caseId` = `session.caseId`, else `CASE_MISMATCH`.
5. `ctx.asOf ≥ session.updatedAt`, else `TIME_REGRESSED`. Equal times are allowed.
6. For each supplied fact, in name order, that the flow declares: its status is one of
   the declared statuses, else `INVALID_FACT_STATUS`. Undeclared facts are not checked.
7. Undeclared facts are removed. Everything that follows, including the facts hash,
   uses only the declared facts. (Hosts may therefore pass one shared pool of facts to
   several flows.)
8. `session.state` is a node of the flow, else `UNKNOWN_STATE`.
9. That node is not terminal, else `SESSION_TERMINAL`.
10. The node has a transition keyed `event.type`, else `NO_TRANSITION`.
11. `event.actor.type` is in the transition's `allowedActors`, else `UNAUTHORIZED`.
12. Every fact the guard refers to is present, else `MISSING_REQUIRED_FACT`
    (section 5.1).
13. The guard decides the target:
    - no guard, or the guard is true: the target is `to`;
    - the guard is false and `onGuardFail` is set: the target is `onGuardFail`, and
      `guardFailed` is `true`;
    - the guard is false and there is no `onGuardFail`: `GUARD_NOT_SATISFIED`.

Then it builds the commit:

- **Session:** a copy of the input session with `state` = the target, `version` =
  `session.version + 1` (`VERSION_OVERFLOW` if that does not fit in an unsigned 64-bit
  integer), and `updatedAt` = `ctx.asOf`. All other fields are unchanged.
- **Effects:** the target node's `onEnter` list, in order. A fallback target emits its
  effects like any other.
- **Audit:** `fromVersion` = `session.version`, `fromState` = `session.state`,
  `resolvedKey` = `event.type`, `prevResultHash` = `session.lastResultHash`.
- **Concurrency predicate:** `expectedSessionVersion` = `session.version`, meaning the
  host MUST write the new session only if the stored version still equals it.

A conflict in the facts (say, two documents disagreeing) is **not** an error. Flows
route such cases with a guard and `onGuardFail`, and the result is a normal commit that
records `guardFailed: true`.

## 5. Guard evaluation

### 5.1 Every referenced fact must be present

Before evaluating, the kernel walks the guard depth-first, children in order:

- `status_is`: the fact `target` must be present.
- `none_with_status`: every **declared** fact whose name starts with `prefix` must be
  present, checked in name order.
- `all_of`, `any_of`, `not`: every child is checked, including children that would not
  change the result.

The first missing fact is reported as `MISSING_REQUIRED_FACT`. A missing fact is never
treated as false: the host must supply a status for everything the rule depends on, so
that a decision can never rest on missing information.

### 5.2 Evaluation

| `op` | Value |
| --- | --- |
| `status_is` | `facts[target] = status` |
| `none_with_status` | No declared fact with a name starting with `prefix` has status `status` |
| `all_of` | Every child is true (true when empty) |
| `any_of` | Some child is true (false when empty) |
| `not` | The child is false |

Evaluation always terminates (depth ≤ 16) and has no side effects.

## 6. Lifecycle

| | `DRAFT` | `ACTIVE` | `DEPRECATED` |
| --- | --- | --- | --- |
| `start` | `FLOW_NOT_ACTIVE` | Allowed within `[effectiveFrom, effectiveTo)` | `FLOW_NOT_ACTIVE` |
| `advance` | `FLOW_NOT_ACTIVE` | Allowed | Allowed |

Lifecycle fields are outside the flow hash, so deprecating a flow does not change the
hash its sessions are pinned to (flow-spec.md, section 8).

## 7. Duplicate requests

Events can arrive more than once (retries, double clicks, redelivered messages). The
kernel keeps no memory, so detecting duplicates is the host's job, using two values the
kernel computes (hashing-spec.md, sections 4.3 and 4.6):

- **`dedupKey`** = H({op, sessionId, caseId, idempotencyKey}). It depends only on the
  operation, the session, the case and the sender's `idempotencyKey`, so the host can
  compute it **before** calling the kernel, and it stays the same however the facts,
  `asOf` or the event's `id` and `timestamp` differ between deliveries. Every commit
  carries its `dedupKey`.
- **`intentHash`** = H({actor, caseId, effectiveAt, payload, source, type}): what the
  event asks for, without its transport details (`id`, `timestamp`, `idempotencyKey`).

A host uses them as follows (host-contract.md, section 4): if a commit with the same
`dedupKey` exists and its intent hash matches, return that commit instead of running
the step again; if the intent differs, the sender reused a key for a different request,
which is an error.

## 8. The commit

| Field | Meaning |
| --- | --- |
| `newSession` | The session after the step (section 2.4), with `lastResultHash` set |
| `expectedSessionVersion` | `null` from `start` (insert); the previous version from `advance` (compare-and-swap) |
| `audit` | The audit record (below) |
| `dedupKey` | Section 7 |
| `outbox` | Effects to carry out: `[{id, kind, payload}]`, in `onEnter` order |

Audit record fields:

| Field | Meaning |
| --- | --- |
| `transitionId` | Unique id of this step (hashing-spec.md, 4.6) |
| `sessionId`, `caseId` | Session and case |
| `fromVersion` | Version the step applied to; `null` for `start` |
| `eventId`, `eventType` | From the event |
| `resolvedKey` | Transition key taken; `null` for `start` |
| `fromState`, `toState` | Node before (`null` for `start`) and after |
| `guardFailed` | `true` if the `onGuardFail` route was taken |
| `workflowId`, `workflowVersion`, `flowHash` | The flow that decided |
| `kernelVersion` | The kernel version that decided |
| `decisionHash` | What the decision was based on (hashing-spec.md, 4.5) |
| `contextRefs` | From the context |
| `factsHash` | Hash of the declared facts used (hashing-spec.md, 4.4) |
| `actor` | From the event |
| `timestamp` | `ctx.asOf`, the decision time |
| `prevResultHash` | The previous commit's `resultHash`; `null` for `start` |
| `resultHash` | Hash over the whole commit, chaining the audit trail (hashing-spec.md, 4.7) |

The host MUST persist the commit atomically, or not at all (host-contract.md,
section 3). An error produces no commit, and the host writes nothing.

## 9. Errors

Errors are objects with a `code` and the details shown.

| Code | Details | From | Cause |
| --- | --- | --- | --- |
| `FLOW_NOT_ACTIVE` | `flowId`, `version` | start, advance | Lifecycle (section 6) |
| `OUTSIDE_EFFECTIVE_WINDOW` | `asOf` | start | Outside the effective window |
| `START_UNAUTHORIZED` | `actor` | start | Actor type not in `startActors` |
| `WORKFLOW_MISMATCH` | `session`, `flow` (each `id@version`) | advance | Different flow id or version |
| `FLOW_HASH_MISMATCH` | `session`, `flow` (hashes) | advance | Different flow content |
| `CASE_MISMATCH` | `sessionCase`, `eventCase` | advance | Event for another case |
| `TIME_REGRESSED` | `asOf`, `sessionUpdatedAt` | advance | Decision time earlier than the last step |
| `INVALID_FACT_STATUS` | `fact`, `status` | advance | A declared fact has a status the flow does not allow |
| `UNKNOWN_STATE` | `state` | advance | The session's state is not in the flow |
| `SESSION_TERMINAL` | `state` | advance | The session has ended |
| `NO_TRANSITION` | `state`, `key` | advance | No transition for this event type here |
| `UNAUTHORIZED` | `state`, `key`, `actor` | advance | Actor type not allowed on this transition |
| `MISSING_REQUIRED_FACT` | `fact` | advance | A fact the guard needs was not supplied |
| `GUARD_NOT_SATISFIED` | `state`, `key` | advance | Guard false and no `onGuardFail` |
| `VERSION_OVERFLOW` | | advance | Session version cannot be incremented |
| `SERIALIZATION` | `reason` | start, advance | A value could not be hashed. Not expected for inputs that were read successfully |

Errors about the request itself (unreadable JSON, unknown fields, an invalid flow) are
reported by the interface, not the kernel (host-contract.md, section 2).

## 10. Determinism

The guarantee is: **same inputs, same output, byte for byte, on every platform.** The
implementation enforces it as follows, and a second implementation MUST do the same:

- no clock, no randomness, no I/O, no environment variables;
- no floating-point numbers anywhere, in inputs, outputs or arithmetic;
- maps iterated in sorted key order, never insertion or hash order;
- every hash over canonical JSON (hashing-spec.md, section 2).

`kernelVersion` is recorded in every audit record and covered by `resultHash`, so the
same step run by two kernel versions gives different result hashes. Every other hash
and identifier (`flowHash`, `factsHash`, `decisionHash`, `transitionId`, effect ids,
`dedupKey`) is independent of the kernel version. Any change to a formula in
hashing-spec.md is a breaking change and is announced in the changelog.

## 11. Conformance

An implementation conforms to this specification if it passes every case in
[`vectors/kernel-conformance.json`](vectors/kernel-conformance.json) and
[`vectors/basic-approval.json`](vectors/basic-approval.json). CI runs them on every
change (`js-smoke/verify-conformance.mjs`, `js-smoke/verify-spec.mjs`); for every
successful step it also recomputes each hash with an independent JavaScript
implementation of hashing-spec.md (`js-smoke/spec-lib.mjs`) that shares no code with
the kernel. The same vectors, with `vectors/flow-validation.json`, also run against the
native build (`crates/mowa-wasm/tests/vectors.rs`, part of `cargo test`), so a host that
links the Rust crates directly reaches the same decisions as one that loads the WASM.
