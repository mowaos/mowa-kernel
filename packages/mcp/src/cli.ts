#!/usr/bin/env node
// mowa-mcp: the MCP server an AI agent talks to, and the commands a person uses to review
// and act on the same cases. Both share one SQLite database.
//
//   mowa-mcp serve   --flow flow.json [--facts facts.json] [--db path]   (stdio, for the agent's MCP client)
//   mowa-mcp cases   [--db path]
//   mowa-mcp show    <caseId> [--db path]
//   mowa-mcp act     <caseId> <EVENT> --as <ACTOR_TYPE> [--id name] [--payload json] [--expect hash] [--facts f]
//   mowa-mcp confirm <effectId> [--db path]
//   mowa-mcp reject  <effectId> [--reason text] [--db path]
//   mowa-mcp export  <caseId>... [--out bundle.json] [--db path]
//
// Keep the database and the facts file where the agent cannot write (outside its working
// folder): the agent must not be able to change its own facts or records.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { AGENT_ACTOR_TYPE, AgentHost } from "./agent-host.js";
import { McpServer, serveStdio } from "./server.js";

const VERSION = "0.5.2";
const USAGE = `mowa-mcp ${VERSION}: an MCP server that puts the MO·WA OS kernel in front of an AI agent.

The agent (over MCP):
  mowa-mcp serve --flow flow.json [--facts facts.json] [--db path]

People (in a terminal):
  mowa-mcp cases                         list cases
  mowa-mcp show <caseId>                 history, effects, and what people can do
  mowa-mcp act <caseId> <EVENT> --as <ACTOR_TYPE> [--id name] [--payload json] [--expect hash]
  mowa-mcp confirm <effectId>            confirm an effect that waits for a person
  mowa-mcp reject <effectId> [--reason text]
  mowa-mcp export <caseId>... [--out bundle.json]   then: npx @mowaos/verify bundle.json

Options:
  --db path      database (default ~/.mowa/mcp.db)
  --facts path   facts the host supplies, as JSON (default ~/.mowa/facts.json, if present)
Keep both where the agent cannot write.`;

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = "true";
      else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function fail(message: string, code = 2): never {
  process.stderr.write(`mowa-mcp: ${message}\n`);
  process.exit(code);
}

async function openHost(flags: Record<string, string>, withFlow: boolean): Promise<AgentHost> {
  // node:sqlite prints an "experimental" warning on Node 22; it is noise for users.
  const emit = process.emitWarning;
  process.emitWarning = (w: string | Error, ...rest: unknown[]) => {
    if (String(w instanceof Error ? w.message : w).includes("SQLite")) return;
    emit.call(process, w, ...rest);
  };
  const { DatabaseSync } = await import("node:sqlite");
  const { loadKernel } = await import("@mowaos/kernel");

  const dbPath = resolve(flags.db ?? join(homedir(), ".mowa", "mcp.db"));
  mkdirSync(dirname(dbPath), { recursive: true });
  const defaultFacts = join(homedir(), ".mowa", "facts.json");
  const factsPath = flags.facts ? resolve(flags.facts) : existsSync(defaultFacts) ? defaultFacts : undefined;

  let flow;
  if (withFlow) {
    if (!flags.flow) fail("serve needs --flow flow.json");
    try {
      flow = JSON.parse(readFileSync(resolve(flags.flow), "utf8"));
    } catch (err) {
      fail(`cannot read flow ${flags.flow}: ${(err as Error).message}`);
    }
  }
  try {
    return await AgentHost.open({ db: new DatabaseSync(dbPath), kernel: await loadKernel(), flow, factsPath });
  } catch (err) {
    fail((err as Error).message);
  }
}

function print(value: unknown): void {
  process.stdout.write(typeof value === "string" ? value + "\n" : JSON.stringify(value, null, 2) + "\n");
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  switch (command) {
    case "serve": {
      const host = await openHost(flags, true);
      process.stderr.write(`mowa-mcp ${VERSION}: serving on stdio (kernel ${host.kernelVersion()})\n`);
      await serveStdio(new McpServer(host, { name: "mowa-mcp", version: VERSION }));
      return;
    }
    case "cases": {
      const host = await openHost(flags, false);
      const cases = host.listCases(Number(flags.limit ?? 50));
      print(cases.length ? cases.map((c) => `${c.caseId}  ${c.state}  (step ${c.version}, ${c.workflow})`).join("\n") : "No cases.");
      return;
    }
    case "show": {
      const host = await openHost(flags, false);
      const caseId = rest[0] ?? fail("show needs a case id");
      const history = await host.history(caseId);
      if (!history) fail(`no case '${caseId}'`, 1);
      const session = await host.storage.getSession(caseId);
      // What people can do: every move not reserved for the agent.
      const view = await host.view(session!, "*");
      const lines = [`Case ${caseId}: ${view.state}${view.terminal ? " (ended)" : ""}, expect ${view.expect}`, "", "History:"];
      for (const s of history.steps) {
        lines.push(
          `  ${s.version}. ${s.event} by ${s.actor}: ${s.from ?? "start"} → ${s.to}${s.guardFailed ? " (conditions failed)" : ""}` +
            (s.traceparent ? `  [trace ${s.traceparent}]` : "")
        );
      }
      if (history.effects.length) {
        lines.push("", "Effects:");
        for (const e of history.effects) lines.push(`  ${e.effectId}  ${e.kind}  ${e.status}  ${JSON.stringify(e.payload)}`);
      }
      const people = view.waitingFor.filter((w) => !w.allowedActors.every((a) => a === AGENT_ACTOR_TYPE));
      if (people.length) {
        lines.push("", "People can:");
        for (const w of people) lines.push(`  mowa-mcp act ${caseId} ${w.event} --as ${w.allowedActors.filter((a) => a !== AGENT_ACTOR_TYPE)[0]}   (→ ${w.to})`);
      }
      print(lines.join("\n"));
      return;
    }
    case "act": {
      const [caseId, event] = rest;
      if (!caseId || !event || !flags.as) fail("act needs <caseId> <EVENT> --as <ACTOR_TYPE>");
      if (flags.as === AGENT_ACTOR_TYPE) fail(`people act as their own role, not as ${AGENT_ACTOR_TYPE}`);
      let payload: unknown;
      if (flags.payload) {
        try {
          payload = JSON.parse(flags.payload);
        } catch {
          fail("--payload must be JSON");
        }
      }
      const host = await openHost(flags, false);
      const id = flags.id ?? process.env.USER ?? "person";
      const r = await host.propose({ caseId, event, actor: { type: flags.as, id: `person:${id}` }, payload, expect: flags.expect });
      if (!r.ok) fail(`${r.code}: ${r.message}`, 1);
      const s = r.step;
      print(`Recorded step ${s.version}: ${s.event}, ${s.from ?? "start"} → ${s.to}${s.guardFailed ? " (conditions failed)" : ""}`);
      for (const e of s.effects) print(`  effect ${e.effectId} ${e.kind}: ${e.status}`);
      return;
    }
    case "confirm": {
      const host = await openHost(flags, false);
      const effectId = rest[0] ?? fail("confirm needs an effect id");
      try {
        print({ confirmed: true, receipt: await host.confirmEffect(effectId) });
      } catch (err) {
        fail((err as Error).message, 1);
      }
      return;
    }
    case "reject": {
      const host = await openHost(flags, false);
      const effectId = rest[0] ?? fail("reject needs an effect id");
      try {
        await host.rejectEffect(effectId, flags.reason ?? "Rejected by a person");
        print(`Rejected ${effectId}.`);
      } catch (err) {
        fail((err as Error).message, 1);
      }
      return;
    }
    case "export": {
      if (rest.length === 0) fail("export needs one or more case ids");
      const host = await openHost(flags, false);
      try {
        const text = JSON.stringify(await host.exportBundle(rest), null, 2) + "\n";
        if (flags.out) {
          writeFileSync(resolve(flags.out), text);
          process.stderr.write(`Wrote ${flags.out}. Check it with: npx @mowaos/verify ${flags.out}\n`);
        } else process.stdout.write(text);
      } catch (err) {
        fail((err as Error).message, 1);
      }
      return;
    }
    case undefined:
    case "help":
    case "--help":
      print(USAGE);
      return;
    default:
      fail(`unknown command '${command}'\n\n${USAGE}`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err), 1));
