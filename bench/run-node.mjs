// Node benchmark. Run from the repo root after `npm test` (or the kernel and
// host builds):  npm run bench
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS, formatTable, runHostScenario, runKernelScenarios } from "./core.mjs";
import { FLOW_SIZES, buildRequests } from "./fixtures.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repo, "target", "bench");
mkdirSync(outDir, { recursive: true });

const { loadKernel } = await import(resolve(repo, "packages/kernel/dist/node.js"));
const hostLib = await import(resolve(repo, "packages/host-browser/dist/index.js"));
const kernel = await loadKernel();
const now = () => performance.now();

const wasm = readFileSync(resolve(repo, "packages/kernel/wasm/mowa_wasm_bg.wasm"));
const env = {
  runtime: `Node ${process.version}`,
  cpu: cpus()[0]?.model?.trim() ?? "unknown",
  os: `${platform()} ${release()}`,
  kernelVersion: kernel.kernelVersion(),
  wasmSha256: createHash("sha256").update(wasm).digest("hex"),
  method: DEFAULTS,
};

// Fixtures for the native Rust run: identical flows and requests.
const fixtures = FLOW_SIZES.map((size) => {
  const r = buildRequests(kernel, size);
  return { size, flow: r.flow, startFull: r.startFull, advanceFull: r.advanceFull };
});
writeFileSync(resolve(outDir, "fixtures.json"), JSON.stringify(fixtures));

const rows = [...runKernelScenarios(kernel, now), ...(await runHostScenario(hostLib, kernel, now))];

writeFileSync(resolve(outDir, "node.json"), JSON.stringify({ env, rows }, null, 2));
console.log(`${env.runtime} · ${env.cpu} · ${env.os}`);
console.log(`kernel ${env.kernelVersion} · wasm sha256 ${env.wasmSha256.slice(0, 16)}…\n`);
console.log(formatTable(rows));
console.log(`\nWrote ${resolve(outDir, "node.json")} and fixtures.json`);
