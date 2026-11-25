import init, {
  advanceJson,
  dedupKeyJson,
  kernelVersion,
  loadFlowJson,
  startJson,
} from "../wasm/mowa_wasm.web.js";

import type { LoadKernelOptions, MowaKernel } from "./types.js";

export type { LoadKernelOptions, MowaKernel, WasmSource } from "./types.js";

const kernel: MowaKernel = Object.freeze({
  loadFlowJson,
  startJson,
  advanceJson,
  dedupKeyJson,
  kernelVersion,
});

let ready: Promise<MowaKernel> | undefined;

/**
 * Load the kernel. The binary is fetched and compiled once per page or worker;
 * later calls return the same instance, and their `wasm` option is ignored.
 */
export function loadKernel(options: LoadKernelOptions = {}): Promise<MowaKernel> {
  ready ??= init(options.wasm === undefined ? undefined : { module_or_path: options.wasm }).then(
    () => kernel,
    (err: unknown) => {
      ready = undefined;
      throw err;
    }
  );
  return ready;
}
