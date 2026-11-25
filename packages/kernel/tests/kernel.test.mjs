import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repo = resolve(pkgRoot, "..", "..");
const wasmFile = resolve(pkgRoot, "wasm", "mowa_wasm_bg.wasm");
const vectors = JSON.parse(readFileSync(resolve(repo, "docs/vectors/basic-approval.json"), "utf8"));
const rootVersion = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8")).version;

// Run the published example (docs/vectors/basic-approval.json) on a kernel and
// compare every byte of output with the recorded commits.
function runVectors(kernel) {
  const { flow, start, advance } = vectors.inputs;
  const loaded = JSON.parse(kernel.loadFlowJson(JSON.stringify(flow)));
  assert.equal(loaded.status, "OK");
  assert.equal(loaded.flowHash, vectors.outputs.start.audit.flowHash);

  const sessionId = vectors.outputs.start.newSession.id;
  const s = JSON.parse(kernel.startJson(JSON.stringify({ sessionId, event: start.event, flow, ctx: start.ctx })));
  assert.equal(s.status, "OK");
  assert.deepEqual(s.commit, vectors.outputs.start);

  const a = JSON.parse(
    kernel.advanceJson(
      JSON.stringify({ session: s.commit.newSession, event: advance.event, flow, facts: advance.facts, ctx: advance.ctx })
    )
  );
  assert.equal(a.status, "OK");
  assert.deepEqual(a.commit, vectors.outputs.advance);
}

describe("@mowaos/kernel", () => {
  it("1. ships the kernel built from this source, at the repo version", () => {
    const shipped = readFileSync(wasmFile);
    const built = readFileSync(resolve(repo, "pkg-web", "mowa_wasm_bg.wasm"));
    assert.ok(shipped.equals(built), "wasm/mowa_wasm_bg.wasm differs from pkg-web/");
    assert.equal(readFileSync(resolve(pkgRoot, "wasm", ".kernel-source-tag"), "utf8").trim(), `v${rootVersion}`);
    assert.match(createHash("sha256").update(shipped).digest("hex"), /^[0-9a-f]{64}$/);
  });

  it("2. Node entry reproduces the published spec vectors", async () => {
    const { loadKernel } = await import("../dist/node.js");
    const kernel = await loadKernel();
    assert.equal(kernel.kernelVersion(), rootVersion);
    runVectors(kernel);
    assert.equal(await loadKernel(), kernel, "loadKernel returns one shared instance");
    assert.ok(Object.isFrozen(kernel));
  });

  it("3. browser entry reproduces the published spec vectors (bytes passed in)", async () => {
    const { loadKernel } = await import("../dist/browser.js");
    const kernel = await loadKernel({ wasm: readFileSync(wasmFile) });
    assert.equal(kernel.kernelVersion(), rootVersion);
    runVectors(kernel);
    assert.equal(await loadKernel(), kernel, "later calls reuse the first instance");
  });

  it("4. the package name resolves to the Node entry in Node", async () => {
    const viaName = await import("@mowaos/kernel");
    const viaPath = await import("../dist/node.js");
    assert.equal(viaName.loadKernel, viaPath.loadKernel);
  });

  it("5. plugs into @mowaos/host-browser and @mowaos/verify unchanged", async () => {
    const { loadKernel } = await import("../dist/node.js");
    const { MowaBrowserHost, WasmKernelBridge, MemoryStorage } = await import(
      "../../host-browser/dist/index.js"
    );
    const { verifyBundle } = await import("../../verify/dist/index.js");

    const kernel = await loadKernel();
    const host = new MowaBrowserHost(new WasmKernelBridge(kernel), { storage: new MemoryStorage() });
    const { flow, start, advance } = vectors.inputs;
    const { flowHash } = await host.installFlow(flow);
    const sessionId = "S_KERNEL_1";
    await host.startSession({ sessionId, event: start.event, flowHash, ctx: start.ctx });
    await host.advanceSession({ sessionId, event: advance.event, facts: advance.facts, ctx: advance.ctx });

    const bundle = await host.exportVerificationBundle([sessionId]);
    const report = await verifyBundle(bundle, { wasm: kernel });
    assert.deepEqual(report.errors, []);
    assert.equal(report.ok, true);
    assert.equal(report.totalStepsVerified, 2);
  });
});
