import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoPkg = resolve(pkgRoot, "..", "..", "pkg");
const destDir = resolve(pkgRoot, "wasm");

const files = [
  "mowa_wasm.js",
  "mowa_wasm_bg.wasm",
  "mowa_wasm.d.ts",
  "mowa_wasm_bg.wasm.d.ts",
  ".kernel-source-tag",
];

if (!existsSync(resolve(repoPkg, "mowa_wasm.js"))) {
  console.error(
    `Missing built Node WASM artifacts at ${repoPkg}. Run 'bash js-smoke/run.sh' from the repo root first.`
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
writeFileSync(resolve(destDir, "package.json"), '{"type":"commonjs"}\n');
for (const file of files) {
  const src = resolve(repoPkg, file);
  if (existsSync(src)) {
    copyFileSync(src, resolve(destDir, file));
  }
}
