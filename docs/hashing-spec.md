# Hashing and audit specification

This document defines every hash and identifier the MO·WA kernel produces, precisely
enough that anyone can recompute them without using this code. It is the contract
behind the kernel's main claim: **given the same inputs, anyone gets the same
result and the same hashes**.

The rules here are checked in CI. [`js-smoke/spec-lib.mjs`](../js-smoke/spec-lib.mjs)
implements them in plain JavaScript, with no kernel code, and recomputes every hash in
[`docs/vectors/basic-approval.json`](vectors/basic-approval.json) and in every
successful step of [`docs/vectors/kernel-conformance.json`](vectors/kernel-conformance.json).
The flow format and the kernel's behaviour are specified in [flow-spec.md](flow-spec.md)
and [kernel-spec.md](kernel-spec.md).

Applies to kernel version 0.5.x. Any change to a formula in this document is a
breaking change and must bump the kernel version.

## 1. Notation

- `H(x)` = SHA-256 of the UTF-8 bytes of `canon(x)`, written as 64 lowercase hex characters.
- `canon(x)` = the canonical JSON text of `x` (section 2).
- `short(h)` = the first 32 hex characters of `h`.
- `{a, b}` = a JSON object with exactly those keys. Key order in this document is
  irrelevant because `canon` sorts keys.
- Field names are camelCase, exactly as they appear in the kernel's JSON.

## 2. Canonical JSON

Canonical JSON is [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785) restricted
to a float-free subset:

1. **Numbers** must be integers in the range ±(2^53 − 1). Inputs containing a float
   (`1.5`, `1.0`, `1e3`) or a larger integer are rejected, not rounded. Integers are
   written in plain decimal.
2. **Object keys** are sorted by their UTF-16 code units, as JCS requires. This differs
   from UTF-8 byte order only for characters outside the Basic Multilingual Plane.
3. **Strings** use the JCS escape set: `\"`, `\\`, `\b`, `\t`, `\n`, `\f`, `\r`, and
   `\u00xx` (lowercase hex) for other control characters below U+0020. Every other
   character is written as literal UTF-8.
4. **No whitespace** between tokens.

Duplicate keys in input JSON are resolved last-wins by the parser. Hosts that need to
reject duplicates must do so before calling the kernel.

## 3. Serialisation rules that affect hashes

These rules describe how kernel structures become JSON before hashing:

- **Optional fields are always present.** An absent value is written as `null`, never
  omitted. For example, an event without `effectiveAt` hashes as `"effectiveAt": null`.
- **Defaults are applied before hashing.** A missing `payload` is `{}`, a missing
  `terminal` is `false`, and so on (section 4.1).
- **Sets are sorted arrays.** `startActors` and `allowedActors` are serialised as arrays
  sorted ascending by UTF-8 bytes, without duplicates, whatever order they arrived in.
- **Lists keep their order.** The allowed statuses in `declaredFacts` and the entries
  in `onEnter` are hashed in the order given.
- **Versions inside identifiers are decimal strings.** In `transitionId` and `effectId`,
  `fromVersion` and `index` are strings such as `"0"`. Everywhere else (sessions,
  audit records, `resultHash`) versions are JSON integers.

## 4. Hashes

### 4.1 Flow hash

```
flowHash = H({id, version, startNode, startActors, description, declaredFacts, nodes})
```

Lifecycle fields (`status`, `effectiveFrom`, `effectiveTo`) are excluded on purpose:
deprecating a flow or changing its effective dates must not change the hash that
running sessions are pinned to.

Each node is hashed with every field present and defaults applied:

| Field | Default when absent |
| --- | --- |
| `id`, `type`, `tier` | required |
| `terminal` | `false` |
| `transitions` | `{}` |
| `onEnter` | `[]` |

Each transition is `{to, allowedActors, guard, onGuardFail}`, with `guard` and
`onGuardFail` defaulting to `null`. Each `onEnter` entry is `{kind, payload}`, with
`payload` defaulting to `null`. `description` defaults to `null` and `declaredFacts`
to `{}`.

A guard is a tagged object whose `op` is one of `all_of`, `any_of`, `not`,
`status_is` or `none_with_status`, with its fields in camelCase.

### 4.2 Event hash

```
eventHash = H(event)
event     = {id, type, source, caseId, timestamp, effectiveAt, idempotencyKey, actor, payload}
actor     = {type, id}
```

This covers the whole event, including transport fields such as `id` and `timestamp`.

### 4.3 Intent hash

Returned by `dedupKeyJson`. It identifies the business intent of an event, ignoring
transport fields, so a client retry with new ids maps to the same intent:

```
intentHash = H({actor, caseId, effectiveAt, payload, source, type})
```

Here `effectiveAt` is a decimal string, or `null`.

### 4.4 Facts hash

Before hashing, the kernel **drops every fact the flow does not declare**. Facts the
flow declares are checked against its allowed statuses.

```
factsHash = H({facts: {<declared fact name>: <status>, ...}})
```

For `start`, which takes no facts, this is `H({facts: {}})`.

### 4.5 Decision hash

Records what a decision was based on:

```
decisionHash = H({caseId, eventHash, workflowVersion, flowHash, contextRefs, factsHash})
```

`contextRefs` is the host-supplied map of external references, such as which version
of a reference list was in force. Recording the version as a context ref is what
makes "which list applied that day" provable.

### 4.6 Identifiers

```
transitionId = "tr_" + short(H({sessionId, fromVersion, eventHash}))
effectId     = short(H({transitionId, index}))
dedupKey     = H({op, sessionId, caseId, idempotencyKey})
```

- `fromVersion` is the session version the step was applied to, as a decimal string,
  or `null` for `start`.
- `index` is the effect's position in the outbox, as a decimal string.
- `op` is `"start"` or `"advance"` (lowercase). The host can compute `dedupKey` before
  calling the kernel.

### 4.7 Result hash

The result hash seals the whole commit:

```
resultHash = H([newSession', audit', outbox, expectedSessionVersion])
```

- `newSession'` is the new session with `lastResultHash` set to `null`.
- `audit'` is the audit record with `resultHash` set to `""` (empty string).
- `expectedSessionVersion` is a JSON integer, or `null` for `start`.

The kernel then writes the result into both `audit.resultHash` and
`newSession.lastResultHash`.

The audit record includes `kernelVersion`, so `resultHash` changes whenever the
kernel version changes, even when no formula does.

## 5. The audit chain

Each commit's audit record points to the one before it:

```
audit.prevResultHash = previousSession.lastResultHash   (null for start)
```

The records of one session therefore form a hash chain from its first commit to its
latest. Changing, removing or reordering any record breaks every link after it.

## 6. How to verify a session

Given the stored audit records of a session, in version order:

1. **Recompute each `resultHash`** with section 4.7, using the stored session snapshot,
   audit record and outbox, and compare with the stored value.
2. **Check the links.** Each `prevResultHash` must equal the previous record's
   `resultHash`, and the first must be `null`.
3. **Replay the decision** (strongest check). Run the same kernel version on the stored
   flow, event, facts and context. It must produce an identical commit. Check the flow
   against `flowHash` and the facts against `factsHash` first.

Steps 1 and 2 prove the record was not altered after it was written. Step 3 proves
the decision followed from its inputs.

## 7. Worked example

[`docs/vectors/basic-approval.json`](vectors/basic-approval.json) contains a complete
example: a three-node flow, a `start`, and an `advance` that supplies one declared fact
(`check:screening = PASS`) and one undeclared fact (`other:ignored`), which is dropped.
Selected values from the `advance` commit:

| Value | Result |
| --- | --- |
| `flowHash` | `d411be2a3130518da01f14b7c9b1a44793ab5f5ec44b042cef87bb064290f373` |
| `factsHash` (undeclared fact dropped) | `28968637ff48e7c4246f9498264fdbb56bc4684244746b7fd791562a09fafc50` |
| `decisionHash` | `4988cbc2ca1244ae55af0fa4a80eb2321c15f3739f96e741c80e9e1ee8735055` |
| `transitionId` | `tr_c5b6503a2a15d6660016a3fd6310fc52` |
| `outbox[0].id` | `04b21541a7a888837f56a882c01cd45b` |
| `dedupKey` | `f289372b7b72bd4a59aa7e85d5c96566e7b5b49c781c2a1122decbb8a4970452` |
| `resultHash` (kernel 0.5.2) | `9b620663e6f58b1384d91d65f5c9c6043bdc990d101d213f14d84ed808c9ac04` |
| `prevResultHash` (= start's `resultHash`) | `fb8f75691e4a1c0995c9e608f3db688896cd888284dacc1d5e047398c0cd26de` |

## 8. Reproducible builds

Replay is only meaningful if verifiers run the same kernel. The release WASM is built
with a pinned Rust toolchain (`rust-toolchain.toml`), a pinned `wasm-bindgen` version
(`Cargo.lock`) and path remapping, so the binary is byte-identical wherever it is built.
CI builds it twice in different directories and fails if the two differ. Each release
publishes the binary's SHA-256 in `SHA256SUMS`.
