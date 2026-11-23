# Host contract

The kernel decides; the **host** does everything else. A host is any program that runs
the kernel for real cases: the browser host in this repository
([`@mowaos/host-browser`](../packages/host-browser)), a server, or a customer's own
installation. This document says what every host MUST do so that decisions stay
correct, never happen twice, and can be verified later.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

| Responsibility | Kernel | Host |
| --- | --- | --- |
| Deciding a step | Yes | |
| Knowing who the actor is, and mapping people to actor types | | Yes |
| The decision time (`asOf`) | | Yes |
| Computing facts from real data | | Yes |
| Storing sessions, audit records and effects, atomically | | Yes |
| Preventing two writers from changing a session at once | | Yes |
| Detecting duplicate requests | Computes the keys | Yes |
| Carrying out effects | | Yes |
| Keeping what is needed to verify decisions | | Yes |

## 1. Calling the kernel

The kernel ships as WebAssembly with a JSON interface: each function takes one JSON
string and returns one JSON string. It never throws for bad input; every failure is a
JSON response.

| Function | Request | Success response |
| --- | --- | --- |
| `loadFlowJson` | A flow (flow-spec.md) | `{status: "OK", flowHandle, flowHash}` |
| `startJson` | `{sessionId, event, flow, ctx}` | `{status: "OK", commit}` |
| `advanceJson` | `{session, event, flow, facts?, ctx}` | `{status: "OK", commit}` |
| `dedupKeyJson` | `{op: "START" \| "ADVANCE", sessionId, event}` | `{status: "OK", dedupKey, intentHash}` |
| `kernelVersion` | (none) | The version as a plain string, e.g. `"0.5.0"` |

Request and response objects follow kernel-spec.md (events, context, facts, sessions,
commits) and reject unknown fields.

Failure responses:

| `status` | Fields | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | `reason` | The request JSON could not be read: syntax, a missing or unknown field, a wrong type, a non-integer number |
| `FLOW_INVALID` | `errors` | The flow failed validation (flow-spec.md, section 9) |
| `FLOW_HANDLE_NOT_FOUND` | `handle` | The flow handle is not (or no longer) in the cache |
| `KERNEL_ERROR` | `error: {code, …}` | The kernel refused the step (kernel-spec.md, section 9) |
| `INTERNAL_ERROR` | | The response could not be produced. Not expected; treat as a bug |

**Flow handles.** In `startJson` and `advanceJson`, `flow` is either a full flow or a
`flowHandle` returned by `loadFlowJson`. A handle avoids re-reading, re-validating and
re-hashing the flow on every call. Handles are opaque strings, valid only inside the
WebAssembly instance that issued them, and the cache keeps the 32 most recently used
flows. On `FLOW_HANDLE_NOT_FOUND` the host loads the flow again and retries; the browser
host does this automatically.

## 2. Inputs the host supplies

- **Actors.** The host MUST authenticate whoever submits an event and set
  `actor.type` from that identity, never from the client's own claim. The kernel only
  checks that the type is allowed (flow-spec.md, section 7).
- **Time.** `ctx.asOf` MUST come from the host's clock, not from the event. It MUST NOT
  go backwards for a session (the kernel refuses with `TIME_REGRESSED`).
- **Events.** Event `id`s SHOULD be unique. `idempotencyKey` SHOULD be chosen by the
  sender and reused when the same request is retried (section 4).
- **Facts.** Facts are categorical statuses computed by the host's **fact providers**
  (for example, checking a party against a sanctions list gives
  `check:sanctions = PASS | HIT`). A fact provider SHOULD be a pure function of its
  inputs and of versioned reference data, so its output can be recomputed later. The
  versions of reference data used SHOULD be recorded in `ctx.contextRefs`, e.g.
  `{"feed:sanctions": "2026-11-01@<content hash>"}`. Facts MUST NOT contain personal
  data: they carry the status, not the evidence.

## 3. Persisting a commit

A successful `start` or `advance` returns a commit. The host MUST write all of it in
one atomic transaction, or nothing:

| Record | Write |
| --- | --- |
| Session | `commit.newSession`, replacing the stored session |
| Audit | `commit.audit`, appended. Audit records MUST NOT be changed or deleted afterwards |
| Duplicate record | `commit.dedupKey` → the commit and the request's intent hash (section 4) |
| Outbox | One record per `commit.outbox` entry, keyed by its `id`, status `PENDING` (section 5) |
| Step | The event, facts and context the kernel was given, with the commit (section 6) |

**Concurrency.** The write is conditional on `commit.expectedSessionVersion`:

- `null` (from `start`): insert the session; fail if a session with that id exists.
- an integer `v` (from `advance`): write only if the stored session's version is still
  `v` (compare-and-swap, e.g. `UPDATE … WHERE id = $id AND version = $v`).

If the condition fails, another step won the race. The host MUST NOT retry the same
commit. It MAY read the session again and call the kernel again with the new version.
A host SHOULD also serialise work per session (the browser host uses a Web Lock named
`session:<id>`; a server can use a database advisory lock), so conflicts are rare.

## 4. Duplicate requests

Before calling `start` or `advance`, the host computes `dedupKey` and `intentHash` with
`dedupKeyJson` (kernel-spec.md, section 7) and looks up the duplicate record:

| Found? | Intent hash | Host does |
| --- | --- | --- |
| No | | Run the step and persist it (section 3) |
| Yes | Same | Return the stored commit. Do not run the step again |
| Yes | Different | Refuse: the key was reused for a different request (the browser host raises `IdempotencyConflictError`) |

The lookup and the write MUST be covered by the same per-session serialisation (or the
compare-and-swap) so that two copies of one request cannot both commit.

## 5. Effects (the outbox)

The kernel lists effects; the host carries them out after the commit, outside the
session lock, from its outbox.

```
              handler SUCCESS
   PENDING ─────────────────────────────► DISPATCHED
    │  ▲  │
    │  │  │ handler AWAIT_CONFIRMATION        operator confirms
    │  │  └──────────────► AWAIT_CONFIRMATION ─────────────────► DISPATCHED
    │  │                          │
    │  │ retry with backoff       │ operator rejects
    │  │ (RETRY or exception)     └──────────────────────────────► REJECTED
    │  │
    │  │ operator requeues
    │  └───────────── FAILED_DLQ ◄─── attempts exhausted, or no handler
    └────────────────────────────────►    within the grace period
```

- **At least once.** A handler may run more than once (after a crash, or a retry).
  Handlers MUST be idempotent, using the effect `id` as their key with the outside
  system. Effect ids are deterministic (hashing-spec.md, section 4.6), so a retried step
  never produces a different id for the same effect.
- **Human confirmation.** For actions that must not happen automatically (sending an
  email, submitting to a portal), the handler prepares the action and returns
  `AWAIT_CONFIRMATION`; the action happens only when an operator confirms. This is the
  "pre-fill and confirm" pattern.
- **Failures.** Retries use exponential backoff. After the attempt limit, or if no
  handler is registered for the effect kind within a grace period, the record moves to
  `FAILED_DLQ` for an operator to inspect and requeue.
- **Outcomes that matter to the case** SHOULD come back into the kernel as events (for
  example, `INVOICE_SENT`, or `APPROVAL_GIVEN` from the confirming operator), so they
  are decided on and recorded in the audit chain. Outbox status changes on their own
  are host records, not audited decisions.

## 6. Keeping what verification needs

hashing-spec.md, section 6, describes three checks: integrity of each record, links in
the chain, and replay of each decision. A host MUST keep, for as long as its records
must be kept:

| What | Needed for |
| --- | --- |
| Every commit, in full: session snapshot, audit record, outbox, `expectedSessionVersion` | Integrity and chain checks (recomputing `resultHash`) |
| Every flow version that any kept commit refers to, by `flowHash` | Replay |
| For each step, the full **event**, the **facts as supplied**, and the **context** | Replay. The audit stores only hashes of these |
| The reference data versions named in `contextRefs` | Checking that the facts were right |
| The kernel version (in each audit record), and access to that kernel's release | Replay |

Retention periods are set by each customer's obligations (for example, six years for UK
tax records).

Writing the step inputs in the same transaction as the commit (section 3) guarantees
that no decision is ever stored without what is needed to replay it.

### 6.1 Verification bundle

To let a customer, auditor or regulator check decisions without access to the host, a
host SHOULD be able to export everything about a case as one JSON document:

```json
{
  "format": "mowa.verification-bundle/1",
  "kernelVersion": "0.5.0",
  "flows": { "<flowHash>": { "…": "flow definition" } },
  "sessions": [
    {
      "sessionId": "…",
      "steps": [
        { "call": "start", "event": {}, "ctx": {}, "commit": {} },
        { "call": "advance", "event": {}, "facts": {}, "ctx": {}, "commit": {} }
      ]
    }
  ],
  "contextData": { "<contextRefs value>": "the reference data, or how to obtain it" }
}
```

`facts` appears on `advance` steps only, exactly as supplied. Steps are in version
order (0, 1, 2, …), and every session's history must be complete from version 0.

A verifier checks each step with the open kernel of the recorded version: recompute
`resultHash`, check the chain, then run the step and compare the commit. The browser
host produces this format (`exportVerificationBundle`, section 7). The format is
version 1 and may still change before 1.0; a standalone verification tool will follow.

## 7. The browser host

`@mowaos/host-browser` implements this contract for browsers and browser extensions:

| Section | How |
| --- | --- |
| 1 | `WasmKernelBridge` wraps the WASM functions; flow handles are reloaded on eviction |
| 3 | `IndexedDbStorage.atomicCommit`: one IndexedDB transaction over the `sessions`, `idempotency`, `audit_log`, `outbox` and `steps` stores, with a version check. `MemoryStorage` does the same in memory for tests |
| 3 | `WebLocksSessionLock` serialises each session within a browser profile |
| 4 | Duplicate lookup with intent-hash comparison in `MowaBrowserHost` |
| 5 | `OutboxDispatcher`: handlers per effect kind, backoff with jitter, dead-letter queue, unhandled-kind grace period, `confirmEffect` / `rejectEffect` / `requeueEffect` |
| 6 | Flows are stored by hash; every step's inputs and commit in the `steps` store (`getSteps`); `exportVerificationBundle` writes section 6.1's format |

Known limits in 0.5.0:

- **Sessions from earlier versions.** IndexedDB databases created by 0.4.x are upgraded
  automatically (database version 3 adds the `steps` store), but sessions committed
  before the upgrade have no step records, so they cannot be exported for replay.
- **One browser profile only.** Web Locks serialise work within one profile. Shared
  cases across users or devices need a server host acting as the single writer.
- Confirmations and rejections update the outbox record only; flows that need them in
  the audit chain should model them as events (section 5).

## 8. Conformance

The browser host's behaviour is tested in `packages/host-browser/tests/host.test.mjs`
(atomic commit, serialised concurrent calls, duplicate requests and key reuse, guard
fallback, outbox states and confirmation, unhandled effect kinds, flow handle
reloading, step records, and replaying an exported bundle to identical commits). A new host SHOULD pass equivalent tests, and MUST produce commits
that verify under hashing-spec.md, section 6.
