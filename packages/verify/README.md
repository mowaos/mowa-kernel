# @mowaos/verify

Independent verification CLI and library for **MO·WA OS** verification bundles (`mowa.verification-bundle/1`).

It verifies exported decision histories using **two independent paths**:

1. **WASM Kernel Replay (`mowa_wasm`):** Re-executes `startJson` and `advanceJson` on every step's saved `{ flow, event, facts, ctx }` and asserts the resulting `Commit` (`newSession`, `audit`, `outbox`, `dedupKey`) is identical to the recorded one, field by field.
2. **Pure-JS Canonical Hash Check (`node:crypto`):** Independently recomputes `flowHash`, `factsHash`, `decisionHash`, `transitionId`, `dedupKey`, effect IDs, and `resultHash` directly from [docs/hashing-spec.md](https://github.com/mowaos/mowa-kernel/blob/main/docs/hashing-spec.md) without sharing any Rust or WASM code.

## What a PASS proves, and what it does not

A PASS proves that every recorded decision follows from its recorded inputs, and that no record in the bundle was changed after it was written.

- **Same kernel version.** Replay needs the kernel version the bundle was recorded with. A bundle from another version fails with a `kernelVersion` error; use the matching `@mowaos/verify` release, or pass `--wasm`. For example, a bundle with `"kernelVersion": "0.5.0"` verifies with `npx @mowaos/verify@0.5.0 bundle.json`.
- **Lifecycle changes are fine.** `status`, `effectiveFrom` and `effectiveTo` are not part of `flowHash`, so a flow deprecated after its sessions ran still verifies.
- **Completeness needs an anchor.** A bundle is self-contained. Someone holding it can drop its latest steps, or build a whole new history from scratch, and it will still verify. To prove a bundle is complete and original, compare its final `resultHash` with a copy held elsewhere, such as a timestamp, a signed receipt or the counterparty's record.

## CLI Usage

```bash
# Verify a bundle exported from @mowaos/host-browser
npx @mowaos/verify bundle.json

# Read from stdin
cat bundle.json | npx @mowaos/verify -

# Machine-readable JSON report (for CI / audit pipelines)
npx @mowaos/verify bundle.json --json

# Bring your own compiled mowa_wasm.js module
npx @mowaos/verify bundle.json --wasm ./path/to/mowa_wasm.js
```

### Exit Codes

- `0` — All flows, sessions, steps, chain links, and hashes verified.
- `1` — Verification failed (reports exact `sessionId`, step `version`, and mismatch).
- `2` — Invalid CLI arguments, unreadable file, or malformed bundle JSON.

## Programmatic Usage

```ts
import { verifyBundle } from "@mowaos/verify";

const report = await verifyBundle(bundle);
if (!report.ok) {
  console.error(report.errors);
}
```

### In the browser

Browser support is on `main` and ships in the next npm release; 0.5.1 on npm runs in Node only.

The same API works in browsers and bundlers (Vite, webpack). Pass the kernel from [`@mowaos/kernel`](https://www.npmjs.com/package/@mowaos/kernel); the hash check uses a built-in SHA-256, so no Node APIs are needed:

```ts
import { loadKernel } from "@mowaos/kernel";
import { verifyBundle } from "@mowaos/verify";

const report = await verifyBundle(bundle, { wasm: await loadKernel() });
```
