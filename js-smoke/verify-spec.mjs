// Checks docs/hashing-spec.md against docs/vectors/*.json in two ways:
//  1. Independent: recompute every hash from the spec's rules in plain JavaScript,
//     with no kernel code, and compare with the recorded outputs.
//  2. Regression: run the built kernel on the recorded inputs and compare the
//     hashes that do not depend on the kernel version.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, expectedHashes, resultHashOf } from "./spec-lib.mjs";

const require = createRequire(import.meta.url);
const vector = JSON.parse(
  readFileSync(new URL("../docs/vectors/basic-approval.json", import.meta.url), "utf8"),
);

const { inputs, outputs } = vector;

test("spec: start hashes recompute without the kernel", () => {
  const s = inputs.start;
  check(outputs.start, expectedHashes("start", s.sessionId, null, s.event, { facts: {} }, s.ctx, inputs.flow));
  assert.equal(resultHashOf(outputs.start), outputs.start.audit.resultHash, "resultHash");
  assert.equal(outputs.start.audit.prevResultHash, null, "genesis has no predecessor");
});

test("spec: advance hashes recompute without the kernel", () => {
  const a = inputs.advance;
  const sessionId = inputs.start.sessionId;
  check(outputs.advance, expectedHashes("advance", sessionId, 0, a.event, a.facts, a.ctx, inputs.flow));
  assert.equal(resultHashOf(outputs.advance), outputs.advance.audit.resultHash, "resultHash");
  assert.equal(outputs.advance.audit.prevResultHash, outputs.start.audit.resultHash, "hash chain link");
});

test("regression: the built kernel reproduces the vector's version-independent hashes", () => {
  const pkgDir = process.env.MOWA_WASM_PKG ?? new URL("../pkg/", import.meta.url).pathname;
  const kernel = require(`${pkgDir}/mowa_wasm.js`);
  const call = (fn, req) => JSON.parse(fn(JSON.stringify(req)));
  const s = call(kernel.startJson, { ...inputs.start, flow: inputs.flow });
  assert.equal(s.status, "OK");
  const a = call(kernel.advanceJson, { ...inputs.advance, session: s.commit.newSession, flow: inputs.flow });
  assert.equal(a.status, "OK");
  for (const [got, want] of [[s.commit, outputs.start], [a.commit, outputs.advance]]) {
    for (const k of ["flowHash", "factsHash", "decisionHash", "transitionId", "toState"]) {
      assert.equal(got.audit[k], want.audit[k], k);
    }
    assert.equal(got.dedupKey, want.dedupKey, "dedupKey");
    assert.deepEqual(got.outbox, want.outbox, "outbox");
    assert.equal(resultHashOf(got), got.audit.resultHash, "resultHash is self-consistent");
    // When the vector was produced by this kernel version, the whole commit must match.
    if (want.audit.kernelVersion === kernel.kernelVersion()) {
      for (const key of Object.keys(want)) assert.deepEqual(got[key], want[key], key);
    }
  }
});

test("the vector was produced by the current kernel version", () => {
  const pkgDir = process.env.MOWA_WASM_PKG ?? new URL("../pkg/", import.meta.url).pathname;
  const kernel = require(`${pkgDir}/mowa_wasm.js`);
  assert.equal(outputs.start.audit.kernelVersion, kernel.kernelVersion(), "regenerate docs/vectors on a version bump");
});
