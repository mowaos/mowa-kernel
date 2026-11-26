#!/usr/bin/env node
// An AI agent works through MCP; the kernel blocks it, a person steps in, and the whole
// run is exported, verified offline, rewound, branched, and (unsuccessfully) rewritten.
//
//   node examples/ai-agent-time-travel/demo.mjs          # from the repository root
//   node examples/ai-agent-time-travel/demo.mjs --slow   # paced for a screen recording
//
// The "agent" is a short script speaking MCP over stdio, exactly as a model-driven agent
// would; it needs no API key and runs the same every time.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WasmKernelBridge } from "@mowaos/host-browser";
import { loadKernel } from "@mowaos/kernel";
import { verifyBundle } from "@mowaos/verify";

const here = dirname(fileURLToPath(import.meta.url));
const mcp = resolve(here, "../../packages/mcp/dist/cli.js");
const flow = resolve(here, "../../packages/mcp/examples/tool-guardrail.flow.json");
const work = mkdtempSync(join(tmpdir(), "mowa-demo-"));
const db = join(work, "mcp.db");
const factsFile = join(work, "facts.json");
const slow = process.argv.includes("--slow");

// ---- output ------------------------------------------------------------------------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, red, green, yellow, cyan] = [1, 2, 31, 32, 33, 36].map(paint);
const pause = (ms) => (slow ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
async function say(who, text) {
  const tag = { agent: cyan("agent  "), kernel: yellow("kernel "), person: green("person "), audit: bold("audit  ") }[who];
  console.log(`${tag} ${text}`);
  await pause(700);
}
const short = (h) => `${h.slice(0, 8)}…`;

// ---- the agent's MCP client ----------------------------------------------------------
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "demo-agent", version: "1" },
};
const server = spawn(process.execPath, [mcp, "serve", "--flow", flow, "--facts", factsFile, "--db", db], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
let buffer = "";
let nextId = 1;
server.stdout.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  for (let nl; (nl = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(nl + 1)) {
    const msg = JSON.parse(buffer.slice(0, nl));
    pending.get(msg.id)?.(msg);
  }
});
function tool(name, args = {}) {
  const id = nextId++;
  return new Promise((done) => {
    pending.set(id, (msg) => done(msg.result.structuredContent));
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: META } }) + "\n");
  });
}
const person = (...args) =>
  execFileSync(process.execPath, [mcp, ...args, "--db", db, "--facts", factsFile], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const facts = (budget) => writeFileSync(factsFile, JSON.stringify({ "policy:allowlist": "PASS", "policy:budget": budget }));

// ---- 1. the run ------------------------------------------------------------------------
console.log(bold("\n1. An AI agent works on a case, through MCP\n"));
facts("FAIL");
const { case: started } = await tool("mowa_start_case");
const caseId = started.caseId;
await say("agent", `started ${caseId}`);

let r = await tool("mowa_propose", { caseId, event: "PROPOSE_TOOL_CALL", payload: { tool: "web_search", query: "quarterly figures" } });
await say("agent", `proposes a tool call: web_search "quarterly figures"`);
await say("kernel", `${red("blocked")}: the host's budget check says FAIL → ${r.step.to}`);

r = await tool("mowa_propose", { caseId, event: "DISMISS" });
await say("agent", "tries to clear the block itself");
await say("kernel", `${red("refused")} ${r.code}: only a person may dismiss. Nothing recorded.`);

facts("PASS");
person("act", caseId, "DISMISS", "--as", "HUMAN", "--id", "dana");
await say("person", "raises the budget and dismisses the flag");

const view = await tool("mowa_list_actions", { caseId });
r = await tool("mowa_propose", { caseId, event: "PROPOSE_TOOL_CALL", payload: { tool: "web_search", query: "quarterly figures" }, expect: view.expect });
await say("agent", `proposes again → ${r.step.to}`);

r = await tool("mowa_propose", { caseId, event: "APPROVE_CALL" });
await say("agent", "tries to approve its own call");
await say("kernel", `${red("refused")} ${r.code}: an agent can propose, never approve.`);

person("act", caseId, "APPROVE_CALL", "--as", "HUMAN", "--id", "dana");
await say("person", "approves the call");
const effect = (await tool("mowa_list_actions", { caseId })).awaitingConfirmation.find((e) => e.kind === "call_tool");
const { receipt } = JSON.parse(person("confirm", effect.effectId));
await say("person", `confirms the tool call; receipt resultHash ${short(receipt.resultHash)}`);
server.stdin.end();

// ---- 2. the record ---------------------------------------------------------------------
console.log(bold("\n2. The record, checked offline\n"));
const bundlePath = join(work, "bundle.json");
person("export", caseId, "--out", bundlePath);
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const steps = bundle.sessions[0].steps;
for (const [i, s] of steps.entries()) {
  const a = s.commit.audit;
  await say("audit", `${i}. ${a.eventType.padEnd(17)} ${`${a.actor.type}:${a.actor.id}`.padEnd(20)} ${(a.fromState ?? "start").padEnd(8)} → ${a.toState.padEnd(9)} ${dim(short(a.resultHash))}`);
}
const report = await verifyBundle(bundle);
assert.equal(report.ok, true, JSON.stringify(report.errors));
await say("audit", `${green("PASS")}: ${report.totalStepsVerified} steps replayed on the kernel, every hash recomputed independently`);

// ---- 3. time travel --------------------------------------------------------------------
console.log(bold("\n3. Time travel, from the bundle alone\n"));
const kernel = new WasmKernelBridge(await loadKernel());
const flowDef = bundle.flows[steps[0].commit.newSession.flowHash];
const replay = (s, prev) => (s.call === "start" ? kernel.start(caseId, s.event, flowDef, s.ctx) : kernel.advance(prev, s.event, flowDef, s.facts, s.ctx));

const blocked = steps[1];
const again = replay(blocked, steps[0].commit.newSession);
assert.equal(again.audit.resultHash, blocked.commit.audit.resultHash);
await say("audit", `rewind to step 1 and replay it: → ${again.audit.toState}, same decision ${short(again.audit.decisionHash)} ${green("✓")}`);

const whatIf = replay({ ...blocked, facts: { facts: { ...blocked.facts.facts, "policy:budget": "PASS" } } }, steps[0].commit.newSession);
assert.notEqual(whatIf.audit.decisionHash, blocked.commit.audit.decisionHash);
await say("audit", `branch: "what if the budget had passed?" → ${whatIf.audit.toState}, decision ${short(whatIf.audit.decisionHash)} (a different history)`);

const forged = structuredClone(bundle);
forged.sessions[0].steps[1].facts.facts["policy:budget"] = "PASS";
const caught = await verifyBundle(forged);
assert.equal(caught.ok, false);
await say("audit", `rewrite history (claim the budget passed at step 1): ${red("FAIL")}, ${caught.errors.length} mismatches found`);

console.log(`\nThe record is in ${bundlePath}\nCheck it yourself: ${bold(`npx @mowaos/verify ${bundlePath}`)}\n`);
