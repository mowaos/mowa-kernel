// @mowaos/mcp: protocol (both MCP eras over real stdio), the agent rules of the host
// contract, people acting from a second process on the same database, and the exported
// record verifying with @mowaos/verify.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../dist/cli.js");
const flowPath = resolve(here, "../examples/tool-guardrail.flow.json");
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test-agent", version: "1" },
};
const TRACE = "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01";

/** A minimal MCP client over the server's stdio. */
function startServer(args) {
  const child = spawn(process.execPath, [cli, "serve", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const stray = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      } else stray.push(msg);
    }
  });
  let next = 1;
  return {
    stray,
    raw(line) {
      child.stdin.write(line + "\n");
    },
    send(method, params, id = next++) {
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
      });
    },
    async call(name, args = {}, meta = META) {
      const res = await this.send("tools/call", { name, arguments: args, _meta: meta });
      assert.ok(res.result, JSON.stringify(res));
      return res.result;
    },
    close() {
      child.stdin.end();
      return new Promise((r) => child.on("exit", r));
    },
  };
}

function person(args) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

describe("MCP protocol", () => {
  let server;
  const dir = mkdtempSync(join(tmpdir(), "mowa-mcp-"));
  before(() => {
    server = startServer(["--flow", flowPath, "--db", join(dir, "p.db")]);
  });
  after(() => server.close());

  it("answers server/discover (2026-07-28)", async () => {
    const r = await server.send("server/discover", { _meta: META });
    assert.equal(r.result.resultType, "complete");
    assert.deepEqual(r.result.supportedVersions, ["2026-07-28"]);
    assert.deepEqual(Object.keys(r.result.capabilities).sort(), ["resources", "tools"]);
    assert.equal(r.result._meta["io.modelcontextprotocol/serverInfo"].name, "mowa-mcp");
  });

  it("rejects an unsupported version with -32022 listing what it supports", async () => {
    const r = await server.send("tools/list", { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
    assert.equal(r.error.code, -32022);
    assert.ok(r.error.data.supported.includes("2026-07-28"));
    assert.ok(r.error.data.supported.includes("2025-11-25"));
  });

  it("rejects a request without per-request metadata (no legacy handshake yet)", async () => {
    const r = await server.send("tools/list", {});
    assert.equal(r.error.code, -32602);
  });

  it("requires clientCapabilities on modern requests", async () => {
    const r = await server.send("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
    assert.equal(r.error.code, -32602);
  });

  it("lists exactly five tools, none of which can approve, confirm or set facts", async () => {
    const r = await server.send("tools/list", { _meta: META });
    const names = r.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["mowa_list_cases", "mowa_start_case", "mowa_list_actions", "mowa_propose", "mowa_get_case"]);
    for (const t of r.result.tools) {
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
      assert.ok(!("facts" in (t.inputSchema.properties ?? {})), `${t.name} must not take facts`);
      assert.ok(!("actor" in (t.inputSchema.properties ?? {})), `${t.name} must not take an actor`);
    }
  });

  it("reports unknown methods, unknown tools, missing resources and bad JSON", async () => {
    assert.equal((await server.send("nope/nothing", { _meta: META })).error.code, -32601);
    assert.equal((await server.send("tools/call", { name: "approve", arguments: {}, _meta: META })).error.code, -32602);
    const missing = await server.send("resources/read", { uri: "mowa://case/case-none", _meta: META });
    assert.equal(missing.error.code, -32602);
    assert.equal(missing.error.data.uri, "mowa://case/case-none");
    server.raw("{not json");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(server.stray.some((m) => m.error?.code === -32700));
  });

  it("serves a legacy client that sends initialize first (dual-era)", async () => {
    const legacy = startServer(["--flow", flowPath, "--db", join(dir, "legacy.db")]);
    const init = await legacy.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "old-client", version: "1" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.instructions.includes("actor type AI"));
    legacy.raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const list = await legacy.send("tools/list");
    assert.equal(list.result.tools.length, 5);
    assert.equal(list.result.resultType, undefined, "legacy results keep the legacy shape");
    const started = await legacy.send("tools/call", { name: "mowa_start_case", arguments: {} });
    assert.equal(started.result.structuredContent.case.state, "waiting");
    await legacy.close();
  });
});

describe("an agent and a person on one case", () => {
  const dir = mkdtempSync(join(tmpdir(), "mowa-mcp-"));
  const db = join(dir, "case.db");
  const facts = join(dir, "facts.json");
  const setFacts = (f) => writeFileSync(facts, JSON.stringify(f));
  let agent;
  let caseId;
  let version = 0;

  before(() => {
    setFacts({ "policy:allowlist": "PASS", "policy:budget": "FAIL" });
    agent = startServer(["--flow", flowPath, "--facts", facts, "--db", db]);
  });
  after(() => agent.close());

  it("the agent starts a case and sees only its own moves", async () => {
    const r = await agent.call("mowa_start_case");
    assert.equal(r.isError, false);
    caseId = r.structuredContent.case.caseId;
    const view = (await agent.call("mowa_list_actions", { caseId })).structuredContent;
    assert.deepEqual(view.actions.map((a) => a.event), ["PROPOSE_TOOL_CALL"]);
    assert.deepEqual(view.waitingFor.map((w) => w.event), ["CLOSE"]);
    assert.deepEqual(view.facts, { "policy:allowlist": "PASS", "policy:budget": "FAIL" });
  });

  it("host facts decide, even when the agent tries to pass its own", async () => {
    const r = await agent.call(
      "mowa_propose",
      { caseId, event: "PROPOSE_TOOL_CALL", payload: { tool: "web_search", query: "release notes" }, facts: { "policy:budget": "PASS" } },
      { ...META, traceparent: TRACE }
    );
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.step.to, "blocked");
    assert.equal(r.structuredContent.step.guardFailed, true);
    assert.deepEqual(r.structuredContent.step.effects.map((e) => [e.kind, e.status]), [["flag_for_review", "AWAIT_CONFIRMATION"]]);
    assert.ok(r.content.some((c) => c.type === "resource_link" && c.uri === `mowa://case/${caseId}/bundle`));
    version = r.structuredContent.step.version;
  });

  it("the agent cannot take a person's move; nothing is recorded", async () => {
    const r = await agent.call("mowa_propose", { caseId, event: "DISMISS" });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, "UNAUTHORIZED");
    assert.equal(r.structuredContent.current.version, version);
  });

  it("a stale 'expect' is refused, with the current case to recover from", async () => {
    const r = await agent.call("mowa_propose", { caseId, event: "PROPOSE_TOOL_CALL", expect: "0".repeat(64) });
    assert.equal(r.structuredContent.code, "STALE");
    assert.equal(r.structuredContent.current.state, "blocked");
  });

  it("a person acts from another process; the agent sees it", async () => {
    setFacts({ "policy:allowlist": "PASS", "policy:budget": "PASS" });
    assert.match(person(["act", caseId, "DISMISS", "--as", "HUMAN", "--id", "alice", "--db", db, "--facts", facts]), /blocked → waiting/);
    const view = (await agent.call("mowa_list_actions", { caseId })).structuredContent;
    assert.equal(view.state, "waiting");
    const r = await agent.call("mowa_propose", { caseId, event: "PROPOSE_TOOL_CALL", payload: { tool: "web_search" }, expect: view.expect });
    assert.equal(r.structuredContent.step.to, "proposed");
  });

  it("people cannot act as the agent", () => {
    assert.throws(() => person(["act", caseId, "WITHDRAW", "--as", "AI", "--db", db]), /not as AI/);
  });

  it("only a person approves; the effect then waits for confirmation, which returns a receipt", async () => {
    const self = await agent.call("mowa_propose", { caseId, event: "APPROVE_CALL" });
    assert.equal(self.structuredContent.code, "UNAUTHORIZED");
    assert.match(person(["act", caseId, "APPROVE_CALL", "--as", "HUMAN", "--id", "alice", "--db", db, "--facts", facts]), /proposed → executed/);
    const view = (await agent.call("mowa_list_actions", { caseId })).structuredContent;
    // The earlier flag_for_review still waits too: nobody has confirmed it.
    assert.deepEqual(view.awaitingConfirmation.map((e) => e.kind), ["flag_for_review", "call_tool"]);
    const callTool = view.awaitingConfirmation.find((e) => e.kind === "call_tool");
    const out = JSON.parse(person(["confirm", callTool.effectId, "--db", db]));
    assert.equal(out.confirmed, true);
    const history = (await agent.call("mowa_get_case", { caseId })).structuredContent;
    const step = history.steps.find((s) => s.event === "APPROVE_CALL");
    assert.equal(out.receipt.resultHash, step.resultHash);
    assert.equal(out.receipt.caseId, caseId);
    assert.equal(history.effects.find((e) => e.kind === "call_tool").status, "DISPATCHED");
  });

  it("records who did what, and the agent's trace id, outside the hashes", async () => {
    const { steps } = (await agent.call("mowa_get_case", { caseId })).structuredContent;
    assert.deepEqual(
      steps.map((s) => [s.event, s.actor]),
      [
        ["CASE_STARTED", "AI:ai:test-agent"],
        ["PROPOSE_TOOL_CALL", "AI:ai:test-agent"],
        ["DISMISS", "HUMAN:person:alice"],
        ["PROPOSE_TOOL_CALL", "AI:ai:test-agent"],
        ["APPROVE_CALL", "HUMAN:person:alice"],
      ]
    );
    assert.equal(steps[1].traceparent, TRACE);
  });

  it("serves the case and its bundle as resources", async () => {
    const list = await agent.send("resources/list", { _meta: META });
    assert.ok(list.result.resources.some((r) => r.uri === `mowa://case/${caseId}`));
    const read = await agent.send("resources/read", { uri: `mowa://case/${caseId}/bundle`, _meta: META });
    const bundle = JSON.parse(read.result.contents[0].text);
    assert.equal(bundle.format, "mowa.verification-bundle/1");
    assert.equal(bundle.sessions[0].steps.length, 5);
  });

  it("the exported record verifies with @mowaos/verify, payloads and host facts included", async () => {
    const out = join(dir, "bundle.json");
    person(["export", caseId, "--out", out, "--db", db]);
    const bundle = JSON.parse(readFileSync(out, "utf8"));
    const steps = bundle.sessions[0].steps;
    assert.deepEqual(steps[1].event.payload, { tool: "web_search", query: "release notes" });
    assert.equal(steps[1].facts.facts["policy:budget"], "FAIL", "the host's fact, not the agent's");
    const { verifyBundle } = await import("@mowaos/verify");
    const report = await verifyBundle(bundle);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.totalStepsVerified, 5);
  });
});

describe("storage", () => {
  it("two writers racing on one case: exactly one commits, the other gets STALE", async () => {
    // Same filter as the CLI: node:sqlite's "experimental" warning is noise in the test log.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...rest) => {
      if (String(w instanceof Error ? w.message : w).includes("SQLite")) return;
      emit.call(process, w, ...rest);
    };
    const { DatabaseSync } = await import("node:sqlite");
    const { loadKernel } = await import("@mowaos/kernel");
    const { AgentHost } = await import("../dist/index.js");
    const dir = mkdtempSync(join(tmpdir(), "mowa-mcp-"));
    const file = join(dir, "race.db");
    const flow = JSON.parse(readFileSync(flowPath, "utf8"));
    const kernel = await loadKernel();
    const factsPath = join(dir, "facts.json");
    writeFileSync(factsPath, JSON.stringify({ "policy:allowlist": "PASS", "policy:budget": "PASS" }));
    // Two hosts with their own connections: like the agent's server and a second process.
    const a = await AgentHost.open({ db: new DatabaseSync(file), kernel, flow, factsPath });
    const b = await AgentHost.open({ db: new DatabaseSync(file), kernel, factsPath });
    const actor = { type: "AI", id: "ai:race" };
    const started = await a.startCase({ actor });
    const { caseId, expect } = started.case;
    const results = await Promise.all([
      a.propose({ caseId, event: "PROPOSE_TOOL_CALL", actor, expect }),
      b.propose({ caseId, event: "PROPOSE_TOOL_CALL", actor, expect }),
    ]);
    assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
    assert.equal(results.find((r) => !r.ok).code, "STALE");
    assert.equal((await a.storage.getSteps(caseId)).length, 2, "one start, one proposal: the case never forks");
  });
});
