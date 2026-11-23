// Runs docs/vectors/kernel-conformance.json and docs/vectors/flow-validation.json
// against the built kernel. For every successful step it also recomputes all hashes
// with the independent implementation in spec-lib.mjs, and it checks that
// docs/schemas/flow.schema.json accepts exactly the flows the kernel can parse.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { H, check, expectedHashes, flowContent, resultHashOf } from "./spec-lib.mjs";

const require = createRequire(import.meta.url);
const pkgDir = process.env.MOWA_WASM_PKG ?? new URL("../pkg/", import.meta.url).pathname;
const kernel = require(`${pkgDir}/mowa_wasm.js`);
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const conformance = read("../docs/vectors/kernel-conformance.json");
const validation = read("../docs/vectors/flow-validation.json");
const schema = read("../docs/schemas/flow.schema.json");
const call = (fn, req) => JSON.parse(fn(JSON.stringify(req)));

// JSON merge patch (RFC 7386).
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const out = target !== null && typeof target === "object" && !Array.isArray(target) ? structuredClone(target) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

// Minimal JSON Schema validator for the keywords flow.schema.json uses:
// type, enum, const, minimum, maximum, required, properties, additionalProperties,
// items, oneOf, $ref.
function typeOf(x) {
  if (x === null) return "null";
  if (Array.isArray(x)) return "array";
  if (typeof x === "number") return Number.isInteger(x) ? "integer" : "number";
  return typeof x;
}
function valid(s, x, root = schema) {
  if (s.$ref) return valid(s.$ref.split("/").slice(1).reduce((o, k) => o[k], root), x, root);
  if (s.oneOf && s.oneOf.filter((sub) => valid(sub, x, root)).length !== 1) return false;
  if (s.type) {
    const types = [].concat(s.type);
    const t = typeOf(x);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return false;
  }
  if (s.enum && !s.enum.includes(x)) return false;
  if (typeof x === "number" && "minimum" in s && x < s.minimum) return false;
  if (typeof x === "number" && "maximum" in s && x > s.maximum) return false;
  if ("const" in s && s.const !== x) return false;
  if (typeOf(x) === "object") {
    for (const r of s.required ?? []) if (!(r in x)) return false;
    for (const [k, v] of Object.entries(x)) {
      if (s.properties && k in s.properties) {
        if (!valid(s.properties[k], v, root)) return false;
      } else if (s.additionalProperties === false) {
        return false;
      } else if (typeof s.additionalProperties === "object" && !valid(s.additionalProperties, v, root)) {
        return false;
      }
    }
  }
  if (typeOf(x) === "array" && s.items) {
    for (const item of x) if (!valid(s.items, item, root)) return false;
  }
  return true;
}

// ---- Kernel conformance ---------------------------------------------------------

for (const c of conformance.cases) {
  test(`kernel: ${c.name}`, () => {
    let session = null;
    const results = [];
    c.steps.forEach((step, i) => {
      const label = `${c.name} [step ${i}]`;
      const flow = mergePatch(conformance.flow, step.flowPatch ?? {});
      const event = { ...conformance.eventDefaults, ...(step.event ?? {}) };
      const ctx = { ...conformance.ctxDefaults, ...(step.ctx ?? {}) };
      const facts = step.facts ?? { facts: {} };
      const expect = step.expect ?? {};

      if (step.call === "dedupKey") {
        const out = call(kernel.dedupKeyJson, { op: step.op, sessionId: step.sessionId, event });
        assert.equal(out.status, "OK", label);
        const op = step.op === "START" ? "start" : "advance";
        assert.equal(out.dedupKey, H({ op, sessionId: step.sessionId, caseId: event.caseId, idempotencyKey: event.idempotencyKey }), `${label} dedupKey formula`);
        const intent = H({ actor: event.actor, caseId: event.caseId, effectiveAt: event.effectiveAt ?? null, payload: event.payload ?? {}, source: event.source, type: event.type });
        assert.equal(out.intentHash, intent, `${label} intentHash formula`);
        if ("dedupKeyEqualsStep" in expect) assert.equal(out.dedupKey, results[expect.dedupKeyEqualsStep].dedupKey, label);
        if ("dedupKeyDiffersFromStep" in expect) assert.notEqual(out.dedupKey, results[expect.dedupKeyDiffersFromStep].dedupKey, label);
        if ("intentHashEqualsStep" in expect) assert.equal(out.intentHash, results[expect.intentHashEqualsStep].intentHash, label);
        if ("intentHashDiffersFromStep" in expect) assert.notEqual(out.intentHash, results[expect.intentHashDiffersFromStep].intentHash, label);
        results.push(out);
        return;
      }

      const out =
        step.call === "start"
          ? call(kernel.startJson, { sessionId: step.sessionId, event, flow, ctx })
          : call(kernel.advanceJson, { session, event, flow, facts, ctx });
      results.push(out.commit?.audit ?? out);
      assert.equal(out.status, expect.status, `${label} status: ${JSON.stringify(out.error ?? out.reason ?? "")}`);

      if (out.status === "KERNEL_ERROR") {
        assert.equal(out.error.code, expect.code, `${label} error code`);
        for (const [k, v] of Object.entries(expect.error ?? {})) assert.deepEqual(out.error[k], v, `${label} error.${k}`);
        return;
      }

      const commit = out.commit;
      assert.equal(commit.newSession.state, expect.state, `${label} state`);
      assert.equal(commit.newSession.version, expect.version, `${label} version`);
      if ("fromState" in expect) assert.equal(commit.audit.fromState, expect.fromState, `${label} fromState`);
      if ("guardFailed" in expect) assert.equal(commit.audit.guardFailed, expect.guardFailed, `${label} guardFailed`);
      if ("outbox" in expect) assert.deepEqual(commit.outbox.map((e) => e.kind), expect.outbox, `${label} outbox kinds`);
      if ("transitionIdDiffersFromStep" in expect) {
        assert.notEqual(commit.audit.transitionId, results[expect.transitionIdDiffersFromStep].transitionId, `${label} transitionId`);
      }

      // Independent recomputation of every hash and of the chain link.
      const op = step.call === "start" ? "start" : "advance";
      const sessionId = step.call === "start" ? step.sessionId : session.id;
      const fromVersion = step.call === "start" ? null : session.version;
      check(commit, expectedHashes(op, sessionId, fromVersion, event, step.call === "start" ? { facts: {} } : facts, ctx, flow));
      assert.equal(resultHashOf(commit), commit.audit.resultHash, `${label} resultHash`);
      assert.equal(commit.newSession.lastResultHash, commit.audit.resultHash, `${label} lastResultHash`);
      assert.equal(commit.audit.prevResultHash, session && step.call === "advance" ? session.lastResultHash : null, `${label} prevResultHash`);
      assert.equal(commit.expectedSessionVersion, fromVersion, `${label} expectedSessionVersion`);
      assert.equal(commit.audit.kernelVersion, kernel.kernelVersion(), `${label} kernelVersion`);
      session = commit.newSession;
    });
  });
}

// ---- Flow validation and schema parity --------------------------------------------

const baseHash = H(flowContent(validation.flow));

for (const c of validation.cases) {
  test(`flow: ${c.name}`, () => {
    const flow = mergePatch(validation.flow, c.patch);
    const out = call(kernel.loadFlowJson, flow);
    assert.equal(out.status, c.expect.status, `${c.name}: ${JSON.stringify(out.errors ?? out.reason ?? "")}`);
    if (out.status === "FLOW_INVALID") {
      assert.deepEqual(out.errors.map((e) => e.code).sort(), c.expect.codes, c.name);
    }
    if (out.status === "OK") {
      assert.equal(out.flowHash, H(flowContent(flow)), `${c.name}: flowHash formula`);
      if ("sameHashAsBase" in c.expect) assert.equal(out.flowHash === baseHash, c.expect.sameHashAsBase, c.name);
    }
    assert.equal(valid(schema, flow), out.status !== "BAD_REQUEST", `${c.name}: schema must accept exactly what the kernel parses`);
  });
}

test("docs: the README example flow is valid", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const block = readme.split("## A flow, briefly")[1].split("```json")[1].split("```")[0];
  const flow = JSON.parse(block);
  assert.equal(call(kernel.loadFlowJson, flow).status, "OK");
  assert.ok(valid(schema, flow));
});

test("docs: the flow-spec overview example is valid", () => {
  const spec = readFileSync(new URL("../docs/flow-spec.md", import.meta.url), "utf8");
  const flow = JSON.parse(spec.split("## 1. Overview")[1].split("```json")[1].split("```")[0]);
  assert.equal(call(kernel.loadFlowJson, flow).status, "OK");
  assert.ok(valid(schema, flow));
});

test("schema: the conformance flow and the hashing example flow match the schema", () => {
  assert.ok(valid(schema, conformance.flow));
  assert.ok(valid(schema, read("../docs/vectors/basic-approval.json").inputs.flow));
});
