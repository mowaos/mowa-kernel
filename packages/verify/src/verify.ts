import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { VerifyOptions, VerifyReport, WasmBindings } from "./types.js";
import { verifyBundleWith } from "./verify-core.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export function loadWasmModule(wasmPath?: string): WasmBindings {
  const candidates = wasmPath
    ? [resolve(process.cwd(), wasmPath)]
    : [
        resolve(here, "..", "wasm", "mowa_wasm.js"),
        resolve(here, "..", "..", "..", "pkg", "mowa_wasm.js"),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const mod = require(candidate) as Partial<WasmBindings>;
      if (
        typeof mod.startJson === "function" &&
        typeof mod.advanceJson === "function" &&
        typeof mod.loadFlowJson === "function" &&
        typeof mod.kernelVersion === "function"
      ) {
        return mod as WasmBindings;
      }
      throw new Error(`Module at '${candidate}' does not export expected mowa_wasm bindings.`);
    }
  }

  throw new Error(
    `Could not locate mowa_wasm.js (checked: ${candidates.join(", ")}). Pass --wasm <path> or run 'npm run build'.`
  );
}

/**
 * Verify a `mowa.verification-bundle/1`. Uses `options.wasm` if given, else the
 * kernel at `options.wasmPath`, else the kernel bundled with this package.
 */
export async function verifyBundle(
  bundleInput: unknown,
  options: VerifyOptions = {}
): Promise<VerifyReport> {
  return verifyBundleWith(bundleInput, options.wasm ?? loadWasmModule(options.wasmPath));
}
