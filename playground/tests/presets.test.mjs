// Runs every playground preset through the same engine the page uses, on the real
// kernel, host and verifier (their built dist folders), and checks the claims the page
// makes: refusals, routing, the AWAIT_CONFIRMATION gate, time travel and tamper detection.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import * as host from "../../packages/host-browser/dist/index.js";
import * as verify from "../../packages/verify/dist/index.js";
import { createEngine } from "../engine.js";
import { PRESETS } from "../presets.js";

const require = createRequire(import.meta.url);
const kernel = require("../../pkg/mowa_wasm.js");

async function runDemo(preset) {
  const engine = await createEngine({ host, verify, kernel, preset });
  for (const step of preset.demo) {
    Object.assign(engine.facts, step.facts ?? {});
    const r = await engine.fire(step.event, step.actor);
    if (step.refused) {
      assert.equal(r.ok, false, `${step.event} as ${step.actor} should be refused`);
      assert.equal(r.code, step.refused);
    } else {
      assert.equal(r.ok, true, `${step.event} as ${step.actor}: ${r.message}`);
      if (step.expect) assert.equal(r.commit.newSession.state, step.expect);
    }
  }
  return engine;
}

describe("playground presets", () => {
  it("are three domain-neutral flows with unique keys", () => {
    assert.deepEqual(
      PRESETS.map((p) => p.title),
      ["Smart Coffee Machine", "Two-Phase Action Approval", "AI Tool-Calling Guardrail"]
    );
    assert.equal(new Set(PRESETS.map((p) => p.key)).size, PRESETS.length);
  });

  for (const preset of PRESETS) {
    describe(preset.title, () => {
      it("is a valid flow", () => {
        const res = JSON.parse(kernel.loadFlowJson(JSON.stringify(preset.flow)));
        assert.equal(res.status, "OK", JSON.stringify(res));
      });

      it("has guide text for every demo step", () => {
        for (const step of preset.demo) {
          assert.ok(step.say?.length > 10, `${step.event}: say`);
          assert.ok(step.after?.length > 10, `${step.event}: after`);
        }
      });

      it("declares every actor and fact it uses", () => {
        const used = new Set([
          ...preset.flow.startActors,
          ...Object.values(preset.flow.nodes).flatMap((n) =>
            Object.values(n.transitions ?? {}).flatMap((t) => t.allowedActors)
          ),
        ]);
        assert.deepEqual([...used].sort(), [...preset.actors].sort());
        assert.deepEqual(
          Object.keys(preset.initialFacts).sort(),
          Object.keys(preset.flow.declaredFacts).sort()
        );
      });

      it("runs its demo, and both engines pass the bundle", async () => {
        const engine = await runDemo(preset);
        const report = await engine.check();
        assert.equal(report.ok, true, JSON.stringify(report.errors));
        assert.equal(report.totalStepsVerified, engine.stepCount);
        for (let i = 0; i < engine.stepCount; i++) {
          for (const row of await engine.hashMatrix(i)) assert.ok(row.match, `step ${i} ${row.field}`);
        }
      });

      it("gives the same hashes every run (fixed clock)", async () => {
        const a = await (await runDemo(preset)).bundle();
        const b = await (await runDemo(preset)).bundle();
        assert.deepEqual(a, b);
      });

      it("rewinds to identical hashes, then branches", async () => {
        const engine = await runDemo(preset);
        const before = await engine.steps();
        await engine.rewind(1);
        const after = await engine.steps();
        assert.equal(after.length, 2);
        assert.deepEqual(after, before.slice(0, 2));
        const report = await engine.check();
        assert.equal(report.ok, true, JSON.stringify(report.errors));
      });

      it("detects a tampered step with both engines", async () => {
        const engine = await runDemo(preset);
        engine.setTamper(1);
        const report = await engine.check();
        assert.equal(report.ok, false);
        assert.ok(report.errors.some((e) => /Pure-JS/.test(e.message)), "spec hasher flags it");
        assert.ok(report.errors.some((e) => !/Pure-JS/.test(e.message)), "replay flags it");
        assert.ok((await engine.hashMatrix(1)).some((r) => !r.match));
        engine.setTamper(null);
        assert.equal((await engine.check()).ok, true);
      });
    });
  }

  it("holds the approved action until a person confirms it", async () => {
    const engine = await runDemo(PRESETS.find((p) => p.key === "approval"));
    const waiting = (await engine.outbox()).filter((r) => r.status === "AWAIT_CONFIRMATION");
    assert.deepEqual(waiting.map((r) => r.effect.kind), ["run_action"]);
    await engine.confirmEffect(waiting[0].outboxId);
    const after = (await engine.outbox()).find((r) => r.outboxId === waiting[0].outboxId);
    assert.equal(after.status, "DISPATCHED");
  });
});
