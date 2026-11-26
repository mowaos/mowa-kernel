# @mowaos/kernel

The **MO·WA OS** kernel as one npm package. It's the same WebAssembly binary in Node and in browsers, with no Rust toolchain or `wasm-bindgen` needed.

```bash
npm install @mowaos/kernel
```

```js
import { loadKernel } from "@mowaos/kernel";

const kernel = await loadKernel();
kernel.kernelVersion(); // "0.5.2"
```

`loadKernel()` returns the kernel's JSON boundary: `loadFlowJson`, `startJson`, `advanceJson`, `dedupKeyJson` and `kernelVersion`. Each call takes and returns a JSON string, as described in the [kernel specification](https://github.com/mowaos/mowa-kernel/blob/main/docs/kernel-spec.md) and [host contract](https://github.com/mowaos/mowa-kernel/blob/main/docs/host-contract.md). The first call loads the binary; later calls return the same instance.

## Where it runs

| Environment | What to do |
| --- | --- |
| Node 20+ | Nothing. The `node` export loads the binary from the package. |
| Vite, webpack 5 | Nothing. The bundler finds `mowa_wasm_bg.wasm` (through `new URL(…, import.meta.url)`) and emits it with your assets. |
| Chrome extension, or a custom server | Copy `@mowaos/kernel/mowa_wasm_bg.wasm` into your build and pass its URL: `loadKernel({ wasm: chrome.runtime.getURL("mowa_wasm_bg.wasm") })`. |
| Anywhere else | Pass the bytes or a `Response`: `loadKernel({ wasm: bytes })`. |

The server must send `.wasm` files as `application/wasm`.

## With the browser host and the verifier

The object `loadKernel()` returns plugs straight into the other packages:

```js
import { loadKernel } from "@mowaos/kernel";
import { MowaBrowserHost, WasmKernelBridge } from "@mowaos/host-browser";
import { verifyBundle } from "@mowaos/verify";

const kernel = await loadKernel();
const host = new MowaBrowserHost(new WasmKernelBridge(kernel));
// ... run sessions, then:
const report = await verifyBundle(await host.exportVerificationBundle([sessionId]), { wasm: kernel });
```

## Checking the binary

`mowa_wasm_bg.wasm` in this package is built from the tagged source and is byte-identical to the `mowa_wasm_bg-v<version>.wasm` asset on the matching [GitHub release](https://github.com/mowaos/mowa-kernel/releases), listed in its `SHA256SUMS`:

```bash
sha256sum node_modules/@mowaos/kernel/wasm/mowa_wasm_bg.wasm
```

The kernel version is recorded in every audit record, so replaying a decision needs the version that made it. Pin `@mowaos/kernel` to an exact version in production.
