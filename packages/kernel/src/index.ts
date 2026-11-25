// Type entry point. At run time Node resolves ./node.js and everything else
// ./browser.js (package.json "exports"); both export the same API.
export type { LoadKernelOptions, MowaKernel, WasmSource } from "./types.js";
export { loadKernel } from "./node.js";
