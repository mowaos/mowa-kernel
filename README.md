# MO·WA OS Kernel

A deterministic workflow kernel whose decisions anyone can verify.

```
(session, event, flow, facts, context)  →  commit { new session, audit record, outbox }
```

The kernel is a pure function. It has no I/O, no clock, no randomness and no floating
point. The same inputs always produce the same commit, byte for byte, including its
SHA-256 hashes. An auditor can take a stored decision, rerun it, and get the same result.

## What it guarantees

- **Deterministic.** Hash maps, wall-clock time and floats are banned by lint rules
  (`clippy.toml`). Time arrives from the host as an input (`ctx.asOf`).
- **Only declared facts count.** A flow declares which facts it uses and their allowed
  values. Undeclared facts are dropped before the decision and before hashing.
- **Tamper-evident audit.** Every commit carries a `resultHash` and links to the
  previous one, forming a hash chain per session.
- **Pinned flows.** A session is pinned to its flow's content hash. It cannot be
  advanced with a modified flow.
- **Safe concurrency.** The kernel never writes anything. It returns a commit that the
  host stores atomically with compare-and-swap on the session version.
- **No panics.** `unsafe`, `unwrap`, `expect`, `panic` and slice indexing are denied by
  lint rules. Errors come back as structured values.

The exact hash formulas are in the [hashing specification](docs/hashing-spec.md), with
a worked example that CI recomputes independently.

## Try it in your browser

The [playground](https://mowaos.github.io/mowa-kernel/) runs three example flows on the
real kernel, entirely in the page: a coffee machine, a two-phase approval and an AI
tool-calling guardrail. Act as different actors, step back through every decision,
tamper with a step and watch both verification engines catch it, then download the
bundle and check it with `npx @mowaos/verify`. To run it locally, build the packages
(`npm test` does), then `npm run playground`.

## Packages

| Package | What it is |
| --- | --- |
| [`mowa-kernel`](crates/mowa-kernel) | One Rust dependency for the whole kernel: re-exports the three crates below |
| [`mowa-canon`](crates/mowa-canon) | Canonical JSON (RFC 8785, integers only) and SHA-256 helpers |
| [`mowa-flow`](crates/mowa-flow) | Flow definitions, the guard language, and the validator |
| [`mowa-core`](crates/mowa-core) | The pure `start` and `advance` reducers |
| [`mowa-wasm`](crates/mowa-wasm) | WebAssembly boundary: JSON string in, JSON string out |
| [`@mowaos/kernel`](packages/kernel) | The kernel as one npm package for Node and browsers; no Rust or `wasm-bindgen` needed |
| [`@mowaos/host-browser`](packages/host-browser) | Browser host: IndexedDB storage, Web Locks, outbox with human confirmation |
| [`@mowaos/verify`](packages/verify) | Offline verifier for exported decision histories: `npx @mowaos/verify bundle.json` |

## Quick start

Requirements: Rust 1.85 (installed automatically from `rust-toolchain.toml`), Node 20+,
and the `wasm-bindgen` CLI at the version in `Cargo.lock`. The CLI needs Rust 1.86 or
later, so install it with stable Rust:

```bash
cargo +stable install wasm-bindgen-cli --version 0.2.126 --locked
```

Run every test (Rust, WASM and the browser host):

```bash
npm test
```

Build the WASM bindings into `pkg/` (Node) and `pkg-web/` (browser):

```bash
bash js-smoke/run.sh
```

### Using it in the browser

```js
import init, * as wasm from "./pkg-web/mowa_wasm.js";
import { MowaBrowserHost, WasmKernelBridge, IndexedDbStorage, WebLocksSessionLock } from "@mowaos/host-browser";

await init();
const host = new MowaBrowserHost(new WasmKernelBridge(wasm), {
  storage: new IndexedDbStorage(),
  lock: new WebLocksSessionLock(),
});

const { flowHash } = await host.installFlow(flowDefinition);
await host.startSession({ sessionId, event: startEvent, flowHash, ctx: { asOf: Date.now() } });
const commit = await host.advanceSession({ sessionId, event, facts, ctx: { asOf: Date.now() } });
```

The host validates inputs, takes a per-session lock, calls the kernel, and writes the
commit atomically. Side effects go to an outbox. Effects that need a person's approval
wait in `AWAIT_CONFIRMATION` until `confirmEffect` or `rejectEffect` is called.

## A flow, briefly

A flow is data: nodes, transitions keyed by event type, who may trigger each one, and
an optional guard over declared facts.

```json
{
  "id": "example.approval", "version": "1", "status": "ACTIVE",
  "startNode": "submitted", "startActors": ["USER"], "effectiveFrom": 0,
  "declaredFacts": { "check:screening": ["PASS", "FAIL"] },
  "nodes": {
    "submitted": { "id": "submitted", "type": "task", "tier": "T0", "transitions": {
      "REVIEW": { "to": "approved", "allowedActors": ["USER"],
                  "guard": { "op": "status_is", "target": "check:screening", "status": "PASS" },
                  "onGuardFail": "held" } } },
    "approved": { "id": "approved", "type": "end", "tier": "T0", "terminal": true },
    "held":     { "id": "held", "type": "end", "tier": "T0", "terminal": true }
  }
}
```

Guards are a small, always-terminating language: `all_of`, `any_of`, `not`,
`status_is` and `none_with_status`. Flows are validated before use: unreachable nodes,
dead ends, undeclared facts and unknown targets are rejected.

## Documentation

| Document | What it defines |
| --- | --- |
| [Flow specification](docs/flow-spec.md) and [JSON Schema](docs/schemas/flow.schema.json) | The flow format: fields, defaults, guards, effects, lifecycle, every validation rule |
| [Kernel specification](docs/kernel-spec.md) | What `start` and `advance` do, step by step, and every error |
| [Hashing specification](docs/hashing-spec.md) | Canonical JSON, every hash and identifier, the audit chain, how to verify |
| [Host contract](docs/host-contract.md) | What a host must do: the WASM interface, atomic commits, duplicates, effects, what to keep for verification |
| [Benchmarks](docs/benchmarks.md) | How fast a decision is in native Rust, Node and Chrome, how it was measured, and how to run it yourself |
| [Conformance cases](docs/vectors) | Inputs and expected results for each rule, run in CI against the kernel and an independent JavaScript implementation of the hashing rules |

The specifications are precise enough to write a second implementation; the
conformance cases tell you whether it agrees.

## Status

Pre-1.0. The JSON contract and hash formulas may still change between minor versions;
every change is listed in the [changelog](CHANGELOG.md).

## Licence

[Apache License 2.0](LICENSE). Copyright 2026 Bruce Gardiner (ScrAtcH). The licence
does not cover the MO·WA name; see [TRADEMARKS.md](TRADEMARKS.md).
