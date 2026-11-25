# Changelog

All notable changes are listed here, newest first. The project follows
[Semantic Versioning](https://semver.org/); before 1.0, a minor version may change
the JSON contract or a hash formula, and the entry will say so.

## `@mowaos/kernel` 0.5.0 (2026-11-25)

Published to npm from commit `20b316c` (signed tag `kernel-v0.5.0`). Kernel, crates
and the other npm packages are unchanged.

- **New npm package `@mowaos/kernel` (0.5.0):** the kernel for Node and browsers
  without a Rust toolchain or `wasm-bindgen`. `await loadKernel()` returns the JSON
  boundary that `@mowaos/host-browser` and `@mowaos/verify` already accept. It ships
  one `mowa_wasm_bg.wasm`, the same binary as the 0.5.0 release asset, used by both
  the Node and browser entry points. No kernel, hash or contract changes.

## `@mowaos/verify` 0.5.0 (2026-11-25)

Published to npm from commit `afbf244` (signed tag `verify-v0.5.0`). Kernel, crates
and `@mowaos/host-browser` stay at 0.5.0, unchanged.

- **New npm package `@mowaos/verify` (0.5.0):** a CLI (`mowa-verify`) and library that
  check a `mowa.verification-bundle/1` offline in two independent ways. It replays
  every step on the bundled 0.5.0 kernel (the same binary as the release asset), and
  it recomputes every hash from the hashing specification in plain JavaScript. It
  verifies sessions whose flow was later deprecated. It rejects empty bundles,
  duplicate sessions and a kernel version mismatch. No kernel, hash or contract
  changes.
- Test fixtures in `host-browser` and `mowa-flow` now use domain-neutral names.

## 0.5.0 (2026-11-24)

First public release, from the private 0.4.3 source. The minor version bump marks the
rename below; the release date is set when the tag is pushed.

- **Renamed (breaking for anyone using the private builds):** crates `fsm-canon`,
  `fsm-flow`, `fsm-core` and `fsm-wasm` are now `mowa-canon`, `mowa-flow`,
  `mowa-core` and `mowa-wasm`; the WASM files are now `mowa_wasm*`; the npm package
  is now `@mowaos/host-browser`. New `mowa-kernel` crate re-exports the kernel as one
  dependency. No hash formula, id or JSON contract changes. Only `kernelVersion` in audit records
  changes (to `0.5.0`), and with it each `resultHash`, as it does on every release.
- **Specifications:** new [flow specification](docs/flow-spec.md) with a
  [JSON Schema](docs/schemas/flow.schema.json), [kernel specification](docs/kernel-spec.md)
  and [host contract](docs/host-contract.md). New conformance cases
  (`docs/vectors/kernel-conformance.json`, `docs/vectors/flow-validation.json`) run in CI
  against the kernel, an independent JavaScript implementation of the hashing rules, and
  the schema.
- **AI agents:** the host contract (section 7) sets the rules for hosts that let AI
  agents act: the host sets the actor, facts and time; agents only propose events;
  effects with outside consequences need a person's step. The flow specification
  (section 12) adds the pattern "AI proposes, a person approves", with conformance
  cases.
- **Flows: unknown fields inside a guard are now rejected** (`BAD_REQUEST`), like
  everywhere else in a flow. Before, they were silently dropped from the flow hash.
  Flows without extra guard fields are unaffected, and no hash changes.
- **Browser host keeps what replay needs (breaking for custom storage):** every commit
  now also stores the step's event, facts and context, in the same transaction. New
  `MowaStorage.getSteps(sessionId)`; `atomicCommit` now takes
  `{intentHash, inputs}` instead of `intentHash`. New
  `MowaBrowserHost.exportVerificationBundle(sessionIds)` exports cases in the
  verification bundle format (host contract, section 6.1). IndexedDB database version 3
  adds a `steps` store; 0.4 databases upgrade automatically, but sessions committed
  before the upgrade cannot be exported: the export throws
  `IncompleteStepHistoryError` (with `sessionId`, `stepCount` and `sessionVersion`).
- **Browser host works from a snapshot of its inputs:** the host validates, decides on
  and stores a JSON snapshot of each event, facts, context and flow, not the caller's
  objects. Before, changing an object while a commit was in progress, or passing a
  getter, could store step inputs that no longer replayed to the same commit. Inputs
  that JSON cannot represent (for example circular objects) now fail with
  `ValidationError`.
- **Release build:** absolute build paths are stripped from the WASM binary, so the
  release build is byte-identical wherever it is built (and contains no local paths).
- **Docs:** README, [hashing specification](docs/hashing-spec.md) with a test vector
  that CI recomputes without kernel code.
- **Packaging:** Apache-2.0 `LICENSE` and `NOTICE`, shipped inside every crate and the npm
  package; crate and npm metadata, CI and release workflows, and a weekly RustSec
  advisory check.
  Built WASM is no longer committed; it is attached to each release with `SHA256SUMS`.

## 0.4.3 (2026-11-17)

- `getOutboxByStatus` returns records in the same order from every storage driver:
  `createdAt` ascending, then `outboxId`, before `limit` is applied.

## 0.4.2 (2026-11-17)

- Added `getOutboxByStatus(status, limit)` to `MowaStorage` and `MowaBrowserHost`.
- Added a `--target web` build (`pkg-web/`) for browser use without a bundler.

## 0.4.1 (2026-11-17)

- Undeclared facts are dropped before guard evaluation and before `factsHash` is computed.
- Requeuing an effect clears `unhandledSince` and `lastError`.

## 0.4.0 (2026-11-17)

- Audit hash chain (`prevResultHash`), strict fact ingestion, and an LRU flow cache in WASM.
- Outbox: exponential backoff, `AWAIT_CONFIRMATION` for human approval, and intent-hash
  conflict detection.

## 0.3.0 (2026-11-17)

- Domain-neutral baseline: Rust kernel, WASM bindings and TypeScript browser host.
