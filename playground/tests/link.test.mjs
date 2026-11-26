// Replay links: a link must rebuild the same session, hashes included, and anything
// malformed must be rejected with a LinkError before it reaches the kernel.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import * as host from "../../packages/host-browser/dist/index.js";
import * as verify from "../../packages/verify/dist/index.js";
import { createEngine } from "../engine.js";
import { decodeLink, encodeLink, LinkError } from "../link.js";
import { PRESETS } from "../presets.js";

const require = createRequire(import.meta.url);
const kernel = require("../../pkg/mowa_wasm.js");

async function playDemo(preset) {
  const engine = await createEngine({ host, verify, kernel, preset });
  for (const step of preset.demo) {
    Object.assign(engine.facts, step.facts ?? {});
    await engine.fire(step.event, step.actor);
  }
  return engine;
}

async function encodeRaw(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(
    await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()
  );
  return btoa(String.fromCharCode(...out)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("replay links", () => {
  for (const preset of PRESETS) {
    it(`${preset.title}: rebuilds the same session and hashes, refusals included`, async () => {
      const original = await playDemo(preset);
      original.setTamper(1);
      const link = await encodeLink({ preset, attempts: original.attempts, tamper: 1, at: 2 });
      assert.ok(link.length < 600, `link is ${link.length} characters`);

      const decoded = await decodeLink(link, PRESETS);
      assert.equal(decoded.preset, preset);
      assert.equal(decoded.tamper, 1);
      assert.equal(decoded.at, 2);

      const copy = await createEngine({ host, verify, kernel, preset });
      await copy.replay(decoded.attempts);
      copy.setTamper(decoded.tamper);
      assert.deepEqual(await copy.bundle(), await original.bundle());
      assert.deepEqual(copy.refusals, original.refusals);
      assert.equal((await copy.check()).ok, false, "the tampered step travels with the link");
    });
  }

  it("drops attempts after the rewind point", async () => {
    const engine = await playDemo(PRESETS[0]);
    await engine.rewind(1);
    assert.ok(engine.attempts.every((a) => a.at <= 1));
    const decoded = await decodeLink(await encodeLink({ preset: PRESETS[0], attempts: engine.attempts }), PRESETS);
    const copy = await createEngine({ host, verify, kernel, preset: PRESETS[0] });
    await copy.replay(decoded.attempts);
    assert.deepEqual(await copy.bundle(), await engine.bundle());
  });

  const coffee = PRESETS[0];
  const good = ["INSERT_COIN", "CUSTOMER", ["OK", "OK"]];
  const bad = {
    "garbage": "!!!not-a-link",
    "not deflate": "aGVsbG8",
    "wrong version": { v: 2, p: "coffee", s: [] },
    "unknown preset": { v: 1, p: "nope", s: [] },
    "steps not an array": { v: 1, p: "coffee", s: "x" },
    "too many steps": { v: 1, p: "coffee", s: Array(201).fill(good) },
    "unknown actor": { v: 1, p: "coffee", s: [["INSERT_COIN", "ROOT", ["OK", "OK"]]] },
    "bad event name": { v: 1, p: "coffee", s: [["<script>", "CUSTOMER", ["OK", "OK"]]] },
    "undeclared status": { v: 1, p: "coffee", s: [["INSERT_COIN", "CUSTOMER", ["OK", "MAYBE"]]] },
    "missing fact": { v: 1, p: "coffee", s: [["INSERT_COIN", "CUSTOMER", ["OK"]]] },
    "bad tamper index": { v: 1, p: "coffee", s: [good], t: -1 },
    "bad selected step": { v: 1, p: "coffee", s: [good], a: "2" },
  };
  for (const [name, value] of Object.entries(bad)) {
    it(`rejects: ${name}`, async () => {
      const fragment = typeof value === "string" ? value : await encodeRaw(value);
      await assert.rejects(decodeLink(fragment, PRESETS), LinkError);
    });
  }

  it("rejects a link that inflates past 64 KiB", async () => {
    const fragment = await encodeRaw({ v: 1, p: "coffee", s: [], pad: "x".repeat(100_000) });
    assert.ok(fragment.length < 1000);
    await assert.rejects(decodeLink(fragment, PRESETS), /too large/);
  });

  it("accepts a valid hand-made link", async () => {
    const decoded = await decodeLink(await encodeRaw({ v: 1, p: "coffee", s: [good] }), PRESETS);
    assert.equal(decoded.attempts.length, 1);
    assert.deepEqual(decoded.attempts[0].facts, { "machine:water": "OK", "machine:beans": "OK" });
    assert.equal(decoded.preset, coffee);
  });
});
