// Browser and bundler entry point (package.json "exports" default condition).
// Same API as the Node entry, except that the kernel must be passed in:
//
//   import { loadKernel } from "@mowaos/kernel";
//   const report = await verifyBundle(bundle, { wasm: await loadKernel() });
import type { VerifyOptions, VerifyReport } from "./types.js";
import { verifyBundleWith } from "./verify-core.js";

export * from "./types.js";
export * from "./spec-hash.js";
export { jsonEqual, verifyBundleWith } from "./verify-core.js";

export async function verifyBundle(
  bundleInput: unknown,
  options: VerifyOptions = {}
): Promise<VerifyReport> {
  if (!options.wasm) {
    throw new Error(
      "In the browser, pass the kernel: verifyBundle(bundle, { wasm: await loadKernel() }) with loadKernel from @mowaos/kernel."
    );
  }
  return verifyBundleWith(bundleInput, options.wasm);
}
