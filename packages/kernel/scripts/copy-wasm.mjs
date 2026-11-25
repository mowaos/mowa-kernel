// Copy the kernel built by js-smoke/run.sh into this package.
// One .wasm binary serves both entry points; only the JS glue differs.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repo = resolve(pkgRoot, "..", "..");
const nodeBuild = resolve(repo, "pkg");
const webBuild = resolve(repo, "pkg-web");
const dest = resolve(pkgRoot, "wasm");

for (const dir of [nodeBuild, webBuild]) {
  if (!existsSync(resolve(dir, "mowa_wasm_bg.wasm"))) {
    console.error(`Missing kernel build at ${dir}. Run 'bash js-smoke/run.sh' from the repo root first.`);
    process.exit(1);
  }
}

const nodeWasm = readFileSync(resolve(nodeBuild, "mowa_wasm_bg.wasm"));
const webWasm = readFileSync(resolve(webBuild, "mowa_wasm_bg.wasm"));
if (!nodeWasm.equals(webWasm)) {
  console.error("pkg/ and pkg-web/ hold different mowa_wasm_bg.wasm binaries. Rebuild with js-smoke/run.sh.");
  process.exit(1);
}

// Start empty so no earlier build can ship.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const copies = [
  [resolve(webBuild, "mowa_wasm_bg.wasm"), "mowa_wasm_bg.wasm"],
  [resolve(webBuild, "mowa_wasm.js"), "mowa_wasm.web.js"],
  [resolve(webBuild, "mowa_wasm.d.ts"), "mowa_wasm.web.d.ts"],
  [resolve(nodeBuild, "mowa_wasm.js"), "mowa_wasm.node.cjs"],
  [resolve(webBuild, ".kernel-source-tag"), ".kernel-source-tag"],
];
for (const [src, name] of copies) {
  copyFileSync(src, resolve(dest, name));
}
