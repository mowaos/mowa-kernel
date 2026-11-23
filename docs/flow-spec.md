# Flow specification

A **flow** is a JSON document that defines a workflow: its states (nodes), the events
that move a case between them (transitions), the conditions on those moves (guards),
and the actions to take on arrival (effects). The kernel runs flows; it never changes
them.

This document defines the flow format for kernel 0.5. The key words MUST, MUST NOT,
SHOULD and MAY are used as in RFC 2119.

- Shape: [`schemas/flow.schema.json`](schemas/flow.schema.json) (JSON Schema 2020-12).
- Behaviour when a flow runs: [kernel-spec.md](kernel-spec.md).
- How the flow hash is computed: [hashing-spec.md](hashing-spec.md), section 4.1.
- Conformance cases: [`vectors/flow-validation.json`](vectors/flow-validation.json).

## 1. Overview

```json
{
  "id": "example.approval",
  "version": "1",
  "status": "ACTIVE",
  "startNode": "submitted",
  "startActors": ["SYSTEM"],
  "declaredFacts": { "check:screening": ["PASS", "HIT"] },
  "nodes": {
    "submitted": {
      "id": "submitted", "type": "intake", "tier": "T1",
      "transitions": {
        "approve": {
          "to": "approved",
          "allowedActors": ["REVIEWER"],
          "guard": { "op": "status_is", "target": "check:screening", "status": "PASS" },
          "onGuardFail": "held"
        }
      }
    },
    "held": {
      "id": "held", "type": "review", "tier": "T2",
      "transitions": { "release": { "to": "submitted", "allowedActors": ["REVIEWER"] } }
    },
    "approved": {
      "id": "approved", "type": "outcome", "tier": "T0", "terminal": true,
      "onEnter": [{ "kind": "notify", "payload": { "template": "approved" } }]
    }
  },
  "effectiveFrom": 0
}
```

A session of this flow starts in `submitted`. An `approve` event from a `REVIEWER`
moves it to `approved` if screening passed, and to `held` otherwise. Arriving in
`approved` emits one `notify` effect for the host to carry out.

The kernel decides only on **categorical facts**: named statuses such as
`check:screening = PASS` that the host supplies with each event. Personal data, amounts
and documents stay in the host; the flow only sees their status.

## 2. Document

A flow is a JSON object with these fields. Fields not listed here MUST be rejected; a
kernel reports them as `BAD_REQUEST`, not as a validation error.

| Field | Type | Required | Default | In flow hash | Meaning |
| --- | --- | --- | --- | --- | --- |
| `id` | string | yes | | yes | Stable identifier of the workflow, e.g. `example.approval` |
| `version` | string | yes | | yes | Version label chosen by the author (section 11) |
| `status` | `"DRAFT"` \| `"ACTIVE"` \| `"DEPRECATED"` | yes | | **no** | Lifecycle state (section 8) |
| `startNode` | string | yes | | yes | Key of the node every session starts in |
| `startActors` | array of strings | yes | | yes | Actor types allowed to start a session (section 7) |
| `description` | string or null | no | `null` | yes | Free text |
| `declaredFacts` | object: fact name → array of strings | no | `{}` | yes | Facts the flow may read and their allowed statuses |
| `nodes` | object: node key → node | yes | | yes | The states of the workflow (section 3) |
| `effectiveFrom` | integer | yes | | **no** | Start of the window in which sessions may start (epoch ms) |
| `effectiveTo` | integer or null | no | `null` | **no** | End of that window, exclusive; `null` = open-ended |

Rules that apply throughout:

- **Defaults are applied before hashing.** A field left out and the same field written
  with its default value give the same flow and the same hash.
- **Numbers are integers.** Every number anywhere in a flow MUST be an integer written
  without a decimal point or exponent. Integers in effect payloads MUST be within
  ±(2^53 − 1), so JavaScript hosts can represent them exactly; larger ones are
  rejected. `effectiveFrom` and `effectiveTo` are signed 64-bit, but hosts SHOULD keep
  them in the same safe range.
- **Strings** are compared exactly: case-sensitive, no trimming, no Unicode
  normalisation. `"ACTIVE"` is valid; `"active"` is rejected.
- **Object key order** in the document does not matter.

## 3. Nodes

Each entry in `nodes` is keyed by the node's id.

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `id` | string | yes | | MUST equal the key it is stored under |
| `type` | string | yes | | Free-form category for hosts and user interfaces (e.g. `intake`, `review`, `outcome`). The kernel does not read it |
| `tier` | `"T0"` … `"T4"` | yes | | Execution tier: a label for hosts, which may attach response-time budgets to it. The kernel cannot measure time and does not read it |
| `terminal` | boolean | no | `false` | A terminal node ends the session: no event can leave it |
| `transitions` | object: event type → transition | no | `{}` | The ways out of this node (section 4) |
| `onEnter` | array of effects | no | `[]` | Effects emitted when a session arrives here (section 6) |

A non-terminal node MUST have at least one transition, and a terminal node MUST have
none. The start node MUST NOT be terminal.

## 4. Transitions

A transition is keyed by the **event type** that triggers it. When an event of that
type arrives while a session is on this node, the transition is considered.

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `to` | string | yes | | Node to move to when the guard is true (or there is no guard) |
| `allowedActors` | array of strings | yes | | Actor types allowed to trigger this transition (section 7) |
| `guard` | guard or null | no | `null` | Condition on facts (section 5). `null` = always true |
| `onGuardFail` | string or null | no | `null` | Node to move to when the guard is false |

Each node has at most one transition per event type, so routing is never ambiguous.

When the guard is false:

- with `onGuardFail`, the session moves to that node and the audit record has
  `guardFailed: true`. This is a normal, successful step, used to route exceptions to
  human review;
- without `onGuardFail`, the event is refused with `GUARD_NOT_SATISFIED`.

`onGuardFail` requires a guard.

## 5. Guards

A guard is a small, always-terminating expression over the facts. It has no loops,
variables, arithmetic or access to anything except fact statuses.

| `op` | Fields | True when |
| --- | --- | --- |
| `status_is` | `target`: fact name, `status`: string | Fact `target` has status `status` |
| `none_with_status` | `prefix`: string, `status`: string | No declared fact whose name starts with `prefix` has status `status` |
| `all_of` | `guards`: array of guards | Every child is true. `all_of` with no children is true |
| `any_of` | `guards`: array of guards | At least one child is true. `any_of` with no children is false |
| `not` | `guard`: guard | The child is false |

- Fields other than those listed for each `op` MUST be rejected (`BAD_REQUEST`), as
  MUST an unknown `op`.
- `prefix` is a plain string prefix. Fact names conventionally use `namespace:name`, but
  the prefix `doc` matches `doc:invoice` and also `docs:other`; write `doc:` to match
  one namespace.
- **Depth.** A `status_is` or `none_with_status` has depth 1; `not`, `all_of` and
  `any_of` add 1 to the deepest child (an empty `all_of`/`any_of` has depth 1). The
  maximum depth is **16**.
- **Every fact a guard reads must be supplied.** Before evaluating, the kernel checks
  that every fact the guard refers to is present, including facts in branches that would
  not affect the result (kernel-spec.md, section 5). A missing fact is an error, never
  silently false.

## 6. Effects

An effect is an instruction to the host, emitted when a session arrives on a node
through `start` or `advance`. The kernel never performs effects; the host's outbox does
(host-contract.md, section 5).

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `kind` | string | yes | | What to do, e.g. `notify`. Hosts register a handler per kind |
| `payload` | any JSON value (integers only) | no | `null` | Parameters for the handler |

Effects are emitted in array order, and each gets a deterministic id
(hashing-spec.md, section 4.6), so a host can retry an effect without doing it twice.
Effects are emitted on every arrival, including when a loop returns to a node.

## 7. Actors

An event carries an actor `{type, id}`. Permissions are by **actor type** only:

- `startActors` lists the types that may start a session;
- each transition's `allowedActors` lists the types that may trigger it.

The actor `id` is recorded in the audit trail but never used for permission. Mapping
real users to actor types (and checking who they are) is the host's job.

Actor lists are **sets**: order and duplicates do not matter, and the hash uses the
values sorted with duplicates removed. Each list MUST be non-empty, and no entry may be
empty or only whitespace.

`SYSTEM` (the host acting on its own) and `AI` (a model proposing an event) are
reserved names by convention. The kernel treats them like any other type: a flow must
list them to allow them. Rules for hosts that let AI agents act are in
host-contract.md, section 7; the flow side is section 12 below.

## 8. Lifecycle

`status`, `effectiveFrom` and `effectiveTo` describe where a flow is in its life. They
are **not** part of the flow hash, so a flow can be deprecated or have its window
changed without breaking the sessions that run on it.

| Status | New sessions (`start`) | Running sessions (`advance`) |
| --- | --- | --- |
| `DRAFT` | Refused (`FLOW_NOT_ACTIVE`) | Refused (`FLOW_NOT_ACTIVE`) |
| `ACTIVE` | Allowed within the window | Allowed |
| `DEPRECATED` | Refused (`FLOW_NOT_ACTIVE`) | Allowed, so running sessions can finish |

The **window** is `effectiveFrom ≤ asOf < effectiveTo` (end exclusive, `null` = no end),
where `asOf` is the time the host supplies with the call. It applies to `start` only.

## 9. Validation rules

A flow must pass validation before the kernel runs it. The validator reports **every**
problem it finds, not just the first. Each problem has a `code` and the details below.

| Code | Details | Problem |
| --- | --- | --- |
| `START_NODE_MISSING` | `node` | `startNode` is not a key in `nodes` |
| `START_NODE_CANNOT_BE_TERMINAL` | `node` | The start node is terminal |
| `NO_START_ACTORS` | | `startActors` is empty |
| `EMPTY_START_ACTOR` | | An entry in `startActors` is empty or whitespace |
| `NODE_ID_MISMATCH` | `key`, `id` | A node's `id` differs from its key |
| `DEAD_END` | `node` | A non-terminal node has no transitions |
| `TERMINAL_HAS_TRANSITIONS` | `node` | A terminal node has transitions |
| `UNKNOWN_TARGET` | `from`, `event`, `target` | A transition's `to` is not a node |
| `UNKNOWN_FALLBACK` | `from`, `event`, `target` | A transition's `onGuardFail` is not a node |
| `FALLBACK_WITHOUT_GUARD` | `from`, `event` | `onGuardFail` is set but `guard` is not |
| `NO_ALLOWED_ACTORS` | `from`, `event` | `allowedActors` is empty |
| `EMPTY_ALLOWED_ACTOR` | `from`, `event` | An entry in `allowedActors` is empty or whitespace |
| `GUARD_TOO_DEEP` | `from`, `event` | The guard is deeper than 16 |
| `UNDECLARED_FACT` | `from`, `event`, `fact` | A `status_is` reads a fact not in `declaredFacts` |
| `INVALID_FACT_STATUS` | `from`, `event`, `fact`, `status` | A `status_is` tests a status the fact cannot have |
| `UNDECLARED_FACT_PREFIX` | `from`, `event`, `prefix` | No declared fact starts with a `none_with_status` prefix |
| `INVALID_FACT_STATUS_FOR_PREFIX` | `from`, `event`, `prefix`, `status` | No fact with that prefix can have that status |
| `EMPTY_FACT_KEY` | | A declared fact name is empty or whitespace |
| `EMPTY_FACT_STATUSES` | `fact` | A declared fact has no allowed statuses |
| `EMPTY_FACT_STATUS` | `fact` | An allowed status is empty or whitespace |
| `DUPLICATE_FACT_STATUS` | `fact`, `status` | A status is listed twice for one fact |
| `UNREACHABLE` | `node` | No path leads from the start node to this node, following both `to` and `onGuardFail` |
| `UNHASHABLE` | `reason` | The flow passed every check but could not be hashed. Not expected for any flow that was read successfully; reserved as a safeguard |

`UNREACHABLE` is checked only when the start node exists. Validation is a pure function
of the document: the same flow always gives the same result.

Two layers, two kinds of error:

1. **Shape** (types, required fields, unknown fields, enum values) is checked when the
   JSON is read. A failure is `BAD_REQUEST` with a message. The JSON Schema describes
   exactly this layer: a document matches the schema if and only if the kernel can read
   it.
2. **Meaning** (the table above) is checked next. A failure is `FLOW_INVALID` with the
   list of problems.

## 10. Flow hash

Every valid flow has a **flow hash**: SHA-256 over the canonical JSON of
`{id, version, startNode, startActors, description, declaredFacts, nodes}`, after
defaults are applied (hashing-spec.md, section 4.1).

- Sessions are **pinned** to the flow hash when they start. `advance` refuses any flow
  whose hash differs (`FLOW_HASH_MISMATCH`), so a running session can never silently
  switch to different rules.
- Lifecycle fields are excluded (section 8).
- Any other change, even to `description` or a node's `type`, changes the hash.

## 11. Changing a flow

- Treat a flow as immutable once a session has started on it. To change behaviour,
  publish a new `version`, and mark the old one `DEPRECATED` when new sessions should
  stop using it. Running sessions finish on the version they started on.
- A host MUST keep every flow version that any retained session or audit record
  refers to, so that decisions can be replayed (host-contract.md, section 6).
- Two documents with the same `id` and `version` but different content have different
  hashes; sessions started on one cannot advance on the other. Authors SHOULD never
  reuse a version label for different content.

## 12. Patterns

### 12.1 AI proposes, a person approves

When an AI agent may prepare an action with outside consequences (sending an email,
submitting a form, paying), give the agent a transition to a **waiting node**, and put
the effect behind a transition that only a person can take:

```json
{
  "submitted": {
    "id": "submitted", "type": "intake", "tier": "T1",
    "transitions": {
      "draft_reply": {
        "to": "draft_ready",
        "allowedActors": ["AI"],
        "guard": { "op": "none_with_status", "prefix": "doc:", "status": "CONFLICTED" },
        "onGuardFail": "held"
      }
    }
  },
  "draft_ready": {
    "id": "draft_ready", "type": "approval", "tier": "T2",
    "transitions": {
      "approve_reply": { "to": "replied", "allowedActors": ["REVIEWER"] },
      "reject_reply": { "to": "submitted", "allowedActors": ["REVIEWER"] }
    }
  },
  "replied": {
    "id": "replied", "type": "outcome", "tier": "T0", "terminal": true,
    "onEnter": [{ "kind": "send_reply", "payload": { "channel": "email" } }]
  }
}
```

- The agent can only move the case to `draft_ready`, which emits nothing. Its draft
  travels in the event payload and is recorded in the event hash.
- The guard reads facts supplied by the host, so the agent cannot talk its way past it;
  if documents conflict, the case goes to `held` for a person.
- `approve_reply` allows only `REVIEWER`. An `AI` actor trying it gets `UNAUTHORIZED`.
- The approval is itself a step in the audit chain, recording who approved and when;
  `send_reply` is emitted only then.

The kernel permits by actor type, so this pattern guarantees that a person approved,
not that it was a different person from the one who prepared the draft.

The conformance cases "AI proposes, a person approves" and "an agent's proposal still
passes guards on host facts" check this pattern.

### 12.2 Exceptions go to a person

Use a guard with `onGuardFail` to route anything unexpected (a failed check, a
conflict, a missing document reported as `MISSING`) to a review node, rather than
refusing the event. The case keeps moving, the exception is recorded with
`guardFailed: true`, and a person decides.

## 13. Conformance

An implementation conforms to this specification if, for every case in
[`vectors/flow-validation.json`](vectors/flow-validation.json), it returns the expected
result: `OK` with the expected hash relation, `FLOW_INVALID` with exactly the listed
codes, or `BAD_REQUEST`. CI runs these cases on every change
(`js-smoke/verify-conformance.mjs`), and also checks that the JSON Schema accepts
exactly the flows the kernel can read.
