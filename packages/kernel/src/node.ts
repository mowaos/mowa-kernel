import { createRequire } from "node:module";

import type { LoadKernelOptions, MowaKernel } from "./types.js";

export type { LoadKernelOptions, MowaKernel, WasmSource } from "./types.js";

const require = createRequire(import.meta.url);

let kernel: MowaKernel | undefined;

function bind(mod: MowaKernel): MowaKernel {
  return Object.freeze({
    loadFlowJson: mod.loadFlowJson,
    startJson: mod.startJson,
    advanceJson: mod.advanceJson,
    dedupKeyJson: mod.dedupKeyJson,
    kernelVersion: mod.kernelVersion,
  });
}

/**
 * Load the kernel. In Node the binary is read from the package synchronously,
 * so this resolves at once; it is async so the same code runs in browsers.
 */
export async function loadKernel(_options: LoadKernelOptions = {}): Promise<MowaKernel> {
  kernel ??= bind(require("../wasm/mowa_wasm.node.cjs") as MowaKernel);
  return kernel;
}
