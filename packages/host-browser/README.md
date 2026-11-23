# @mowaos/host-browser

Browser host for the [MO·WA OS kernel](../../README.md). It runs the kernel's WASM build
in the browser and provides what the kernel deliberately leaves out:

- **Storage:** `IndexedDbStorage` (and `MemoryStorage` for tests), with atomic commits
  and compare-and-swap on the session version.
- **Locking:** `WebLocksSessionLock` serialises work per session across tabs.
- **Outbox:** `OutboxDispatcher` runs side effects with exponential backoff. Effects
  that need a person's approval wait in `AWAIT_CONFIRMATION` until confirmed or rejected.
- **Input validation** at the boundary, before anything reaches the kernel.
- **Verification:** every step's event, facts and context are kept with its commit,
  and `exportVerificationBundle(sessionIds)` exports a case so anyone can replay its
  decisions with the open kernel.

The kernel's WASM module is passed in, not bundled, so you control which verified
build you run:

```js
import init, * as wasm from "./pkg-web/mowa_wasm.js";
import { MowaBrowserHost, WasmKernelBridge, IndexedDbStorage, WebLocksSessionLock } from "@mowaos/host-browser";

await init();
const host = new MowaBrowserHost(new WasmKernelBridge(wasm), {
  storage: new IndexedDbStorage(),
  lock: new WebLocksSessionLock(),
});
```

What every host must guarantee is specified in the
[host contract](../../docs/host-contract.md). Each release attaches the WASM build and its
SHA-256 checksum. Licensed under Apache-2.0.
