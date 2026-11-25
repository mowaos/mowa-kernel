import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MowaBrowserHost,
  WasmKernelBridge,
  MemoryStorage,
  OutboxDispatcher,
} from "../../host-browser/dist/index.js";

import { verifyBundle } from "../dist/index.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const wasmPkg = require(resolve(pkgRoot, "wasm", "mowa_wasm.js"));

function sampleFlow() {
  return {
    id: "VERIFY_FLOW",
    version: "1.0.0",
    status: "ACTIVE",
    startNode: "INTAKE",
    startActors: ["SYSTEM", "OPERATOR"],
    effectiveFrom: 0,
    declaredFacts: {
      "doc:invoice": ["MISSING", "VERIFIED", "CONFLICTED"],
    },
    nodes: {
      INTAKE: {
        id: "INTAKE",
        type: "t",
        tier: "T1",
        onEnter: [{ kind: "EMIT_INTAKE" }],
        transitions: {
          CHECK_DOCS: {
            to: "APPROVED",
            allowedActors: ["SYSTEM", "OPERATOR"],
            guard: {
              op: "status_is",
              target: "doc:invoice",
              status: "VERIFIED",
            },
            onGuardFail: "REVIEW",
          },
        },
      },
      REVIEW: {
        id: "REVIEW",
        type: "t",
        tier: "T2",
        onEnter: [{ kind: "REQUEST_REVIEW" }],
        transitions: {
          APPROVE: {
            to: "APPROVED",
            allowedActors: ["OPERATOR"],
          },
        },
      },
      APPROVED: {
        id: "APPROVED",
        type: "t",
        tier: "T1",
        terminal: true,
        onEnter: [{ kind: "NOTIFY_APPROVED" }],
      },
    },
  };
}

async function buildSampleBundle({ deprecateBeforeExport = false } = {}) {
  const storage = new MemoryStorage();
  const kernel = new WasmKernelBridge(wasmPkg);
  const host = new MowaBrowserHost(kernel, {
    storage,
    outboxDispatcher: new OutboxDispatcher(storage),
  });

  const { flowHash } = await host.installFlow(sampleFlow());

  await host.startSession({
    sessionId: "S_VER_1",
    event: {
      id: "E0",
      type: "INIT",
      source: "test",
      caseId: "CASE_1",
      timestamp: 1000,
      idempotencyKey: "k0",
      actor: { type: "SYSTEM", id: "sys" },
      payload: {},
    },
    flowHash,
    ctx: { asOf: 1000, contextRefs: { policy: "v1" } },
  });

  // Trigger onGuardFail -> REVIEW, with an undeclared fact that must be kept in step inputs
  await host.advanceSession({
    sessionId: "S_VER_1",
    event: {
      id: "E1",
      type: "CHECK_DOCS",
      source: "test",
      caseId: "CASE_1",
      timestamp: 2000,
      idempotencyKey: "k1",
      actor: { type: "OPERATOR", id: "op1" },
      payload: {},
    },
    facts: {
      facts: {
        "doc:invoice": "MISSING",
        "extra:ignored": "RAW",
      },
    },
    ctx: { asOf: 2000, contextRefs: { policy: "v1" } },
  });

  // Duplicate delivery (must not create a duplicate step)
  await host.advanceSession({
    sessionId: "S_VER_1",
    event: {
      id: "E1",
      type: "CHECK_DOCS",
      source: "test",
      caseId: "CASE_1",
      timestamp: 2000,
      idempotencyKey: "k1",
      actor: { type: "OPERATOR", id: "op1" },
      payload: {},
    },
    facts: { facts: { "doc:invoice": "MISSING" } },
    ctx: { asOf: 2000, contextRefs: { policy: "v1" } },
  });

  // Resolve to terminal APPROVED
  await host.advanceSession({
    sessionId: "S_VER_1",
    event: {
      id: "E2",
      type: "APPROVE",
      source: "test",
      caseId: "CASE_1",
      timestamp: 3000,
      idempotencyKey: "k2",
      actor: { type: "OPERATOR", id: "op1" },
      payload: { note: "ok" },
    },
    facts: { facts: { "doc:invoice": "VERIFIED" } },
    ctx: { asOf: 3000, contextRefs: { policy: "v1" } },
  });

  if (deprecateBeforeExport) {
    // Same flowHash (lifecycle fields are not hashed), so this replaces the stored flow.
    await host.installFlow({ ...sampleFlow(), status: "DEPRECATED" });
  }

  return await host.exportVerificationBundle(["S_VER_1"]);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

describe("@mowaos/verify", () => {
  it("1. verifies a real exported bundle from @mowaos/host-browser", async () => {
    const bundle = await buildSampleBundle();
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, true);
    assert.equal(report.flowsChecked, 1);
    assert.equal(report.sessionsChecked, 1);
    assert.equal(report.totalStepsVerified, 3);
    assert.equal(report.errors.length, 0);
    assert.equal(report.sessions[0].sessionId, "S_VER_1");
    assert.equal(report.sessions[0].finalVersion, 2);
  });

  it("2. rejects tampered facts", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.sessions[0].steps[1].facts.facts["doc:invoice"] = "VERIFIED";
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.field === "commit" || e.field === "audit.factsHash"));
  });

  it("3. rejects tampered audit.decisionHash", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.sessions[0].steps[1].commit.audit.decisionHash = "0".repeat(64);
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.field === "audit.decisionHash"));
  });

  it("4. rejects tampered audit.resultHash", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.sessions[0].steps[2].commit.audit.resultHash = "f".repeat(64);
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.field === "audit.resultHash"));
  });

  it("5. rejects tampered outbox effect id", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.sessions[0].steps[0].commit.outbox[0].id = "bad_effect_id";
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.field === "outbox[0].id"));
  });

  it("6. rejects skipped step / broken version continuity", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.sessions[0].steps.splice(1, 1);
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.field === "newSession.version"));
  });

  it("7. rejects modified flow under original flowHash", async () => {
    const bundle = clone(await buildSampleBundle());
    const [hash] = Object.keys(bundle.flows);
    bundle.flows[hash].description = "tampered";
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.scope === "flow" && e.field === "flowHash"));
  });

  it("8. rejects malformed bundle", async () => {
    const report = await verifyBundle({ format: "unknown/0" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.scope === "bundle"));
  });

  it("9. CLI exits 0 on valid bundle, 1 on tampered bundle, 2 on bad input", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mowa-verify-"));
    const cli = resolve(pkgRoot, "dist", "cli.js");
    try {
      const validFile = resolve(dir, "valid.json");
      const badFile = resolve(dir, "tampered.json");
      const bundle = await buildSampleBundle();
      writeFileSync(validFile, JSON.stringify(bundle));

      const tampered = clone(bundle);
      tampered.sessions[0].steps[0].commit.audit.resultHash = "0".repeat(64);
      writeFileSync(badFile, JSON.stringify(tampered));

      const okOut = execFileSync(process.execPath, [cli, validFile, "--json"], {
        encoding: "utf8",
      });
      const parsed = JSON.parse(okOut);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.totalStepsVerified, 3);

      const failRes = spawnSync(process.execPath, [cli, badFile], {
        encoding: "utf8",
      });
      assert.equal(failRes.status, 1);
      assert.match(failRes.stderr, /FAIL:/);

      const errRes = spawnSync(
        process.execPath,
        [cli, resolve(dir, "missing.json")],
        { encoding: "utf8" }
      );
      assert.equal(errRes.status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("10. verifies sessions whose flow was deprecated before export", async () => {
    const bundle = await buildSampleBundle({ deprecateBeforeExport: true });
    const [hash] = Object.keys(bundle.flows);
    assert.equal(bundle.flows[hash].status, "DEPRECATED");
    const report = await verifyBundle(bundle);
    assert.deepEqual(report.errors, []);
    assert.equal(report.ok, true);
    assert.equal(report.totalStepsVerified, 3);
  });

  it("11. drops an undeclared fact named like an Object.prototype key", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.sessions[0].steps[1].facts.facts.constructor = "RAW";
    const report = await verifyBundle(bundle);
    assert.deepEqual(report.errors, []);
    assert.equal(report.ok, true);
  });

  it("12. rejects a bundle with no sessions", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.sessions = [];
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.scope === "bundle" && e.field === "sessions"));
  });

  it("13. rejects a bundle recorded with a different kernel version", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.kernelVersion = "9.9.9";
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.scope === "bundle" && e.field === "kernelVersion"));
  });

  it("14. rejects a session listed twice", async () => {
    const bundle = clone(await buildSampleBundle());
    bundle.sessions.push(clone(bundle.sessions[0]));
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.scope === "session" && /more than once/.test(e.message)));
  });
});
