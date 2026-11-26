# Changelog

All notable changes are listed here, newest first. The project follows
[Semantic Versioning](https://semver.org/); before 1.0, a minor version may change
the JSON contract or a hash formula, and the entry will say so.

## 0.5.2 (2026-11-26)

New packages and tools; decisions are unchanged. Every `flowHash`, `decisionHash`,
`factsHash`, identifier and outbox entry is the same as in 0.5.1. As on every release,
`kernelVersion` in audit records changes (to `0.5.2`), and with it each `resultHash`.
Bundles recorded with 0.5.1 verify with `npx @mowaos/verify@0.5.1`.

- **New package `@mowaos/mcp`:** an MCP server that puts the kernel in front of an AI
  agent, following the host contract's rules for agents (section 7). The agent gets
  five tools (`mowa_list_cases`, `mowa_start_case`, `mowa_list_actions`,
  `mowa_propose`, `mowa_get_case`) and always acts as actor type `AI`. It cannot
  approve, confirm effects, supply facts or choose its actor. Facts come from a file
  the host controls; effects wait in `AWAIT_CONFIRMATION` until a person confirms them
  with `mowa-mcp confirm`, which returns a receipt. `mowa_propose` takes an `expect`
  token (the case's latest `resultHash`): a move on a stale view, or a retried one, is
  refused as `STALE`. People review and act from the same CLI (`cases`, `show`, `act`,
  `confirm`, `reject`, `export`). Read-only resources serve each case and its
  verification bundle. W3C `traceparent` from the request is stored with the step,
  outside the hashes. Storage is SQLite through `node:sqlite`, safe for the server and
  review commands to share. The protocol is implemented without an SDK and is
  dual-era: MCP 2026-07-28 (`server/discover`, per-request metadata) plus the
  `initialize` handshake of 2025-11-25, 2025-06-18 and 2025-03-26 clients. Needs
  Node 22.13 or later. Tested over real stdio, with a person acting from a second
  process and the exported bundle checked by `@mowaos/verify`, and checked against the
  official MCP Inspector.
- **Example `examples/ai-agent-time-travel`** (`npm run demo:agent`, about 15 s): a
  scripted agent works through `@mowaos/mcp`, is blocked by a host fact and refused
  twice, a person clears and approves, and the exported record verifies. Then, from the
  bundle alone, it replays a step to the same decision, branches with a different fact,
  and shows that rewriting history fails verification. CI runs it on every change.
- The public gate now also checks `@mowaos/mcp`'s version and that npm packages pin
  `@mowaos/*` dependencies to the release version exactly.
- **`@mowaos/verify` runs in browsers.** The same `verifyBundle` API works in Vite,
  webpack and plain browsers; pass the kernel with
  `{ wasm: await loadKernel() }` from `@mowaos/kernel`. In Node, hashing still uses
  `node:crypto`. Elsewhere it uses a built-in SHA-256, tested against `node:crypto`,
  chosen through the package's `imports` map. No Node APIs remain in the shared code.
  The CLI and the Node API are unchanged.
- **Playground** (`playground/`, deployed to GitHub Pages): three example flows on the
  real kernel, host and verifier, in the browser. It has a state graph, time travel
  (rewinding replays the kept steps to identical hashes), a per-step table of WASM
  against pure-JS hashes, a live PASS badge over the whole history, a tamper button,
  the outbox with `AWAIT_CONFIRMATION`, and bundle download. It needs no bundler and
  no dependencies: an import map loads the packages' built `dist` folders.
  `npm run playground` serves it locally. CI runs every preset in Node and drives the
  page in headless Chrome.
- **Playground replay links:** the address bar always holds the current run
  (`#r=…`, about 130 characters), refused attempts and any tampering included. Anyone
  who opens it gets the same session and the same final `resultHash`, computed in their
  own browser; nothing is uploaded. Links are size-capped and validated against the
  preset before anything runs. Also: a copy-receipt button, link previews, `?preset=`
  deep links, and a line under the hash table explaining what a mismatch means.
- **Playground guide for newcomers:** each preset walks through its path one step at a
  time, saying what to try and then what just happened, with a "Do it for me" button.
  It notices when you leave the path and offers a restart; at the end it points to
  tamper, rewind and the replay link. Every panel has a one-sentence "?" explanation.
  The guide text lives with each preset's demo steps, and the Chrome self-test walks
  every preset through the guide, so the text cannot drift from the flows.

## 0.5.1 (2026-11-25)

A performance release. Decisions are unchanged: every `flowHash`, `decisionHash`,
`factsHash`, identifier and outbox entry is the same as in 0.5.0. As on every release,
`kernelVersion` in audit records changes (to `0.5.1`), and with it each `resultHash`.

- **Calls with a flow handle no longer slow down with flow size.** Cached flows are
  shared instead of copied on every call. `advance` with a handle on a 200-node flow
  went from 298 to 62 µs in Chrome.
- **The release build is optimised for speed** (`opt-level = 3`, was `"s"`): 41% faster
  in WASM. The binary is 8% smaller raw and 4% larger gzipped (182 kB).
- **Benchmarks:** `npm run bench` (Node and native Rust) and `npm run bench:browser`
  (headless Chrome) time the same requests in each runtime. Method and results for
  0.5.0 and 0.5.1 are in [docs/benchmarks.md](docs/benchmarks.md).
- **All packages move to 0.5.1:** the crates, `@mowaos/kernel`, `@mowaos/host-browser`
  (no code changes) and `@mowaos/verify`, which now bundles the 0.5.1 kernel. Bundles
  recorded with 0.5.0 verify with `npx @mowaos/verify@0.5.0`.
- `docs/vectors/basic-approval.json` and the worked example in the hashing
  specification carry the 0.5.1 result hashes.

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
