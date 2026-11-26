# @mowaos/mcp

An MCP server that puts the **MO·WA OS** kernel in front of an AI agent. The agent
proposes, the flow decides, and a person approves.

Your agent (in any MCP client: a coding assistant, a desktop app, your own agent) gets five tools for working on cases
in a workflow you define. It can propose moves. It cannot approve them, confirm their
effects, supply the facts they depend on, or pick who it is. Every step is recorded
with SHA-256 hashes, and the record can be checked offline with
`npx @mowaos/verify`.

## Quick start

1. **Write a flow:** the states, the moves, who may make each one, and which facts they
   depend on. [`examples/tool-guardrail.flow.json`](examples/tool-guardrail.flow.json) is
   a complete example: the agent proposes a tool call, policy checks run, and a person
   approves. The format is in the [flow specification](../../docs/flow-spec.md).
2. **Write the facts the host supplies**, as JSON, for example
   `{ "policy:allowlist": "PASS", "policy:budget": "FAIL" }`. They are read on every
   decision, so you can change them while the agent works.
3. **Add the server to your MCP client:**

   ```json
   {
     "mcpServers": {
       "mowa": {
         "command": "npx",
         "args": ["-y", "@mowaos/mcp", "serve", "--flow", "/path/outside/the/agent/workspace/flow.json", "--facts", "/path/outside/the/agent/workspace/facts.json"]
       }
     }
   }
   ```

4. **Review and act as a person** in a terminal, on the same cases:

   ```bash
   npx @mowaos/mcp cases
   npx @mowaos/mcp show case-1a2b3c4d5e6f
   npx @mowaos/mcp act case-1a2b3c4d5e6f APPROVE_CALL --as HUMAN
   npx @mowaos/mcp confirm <effectId>          # prints a receipt
   npx @mowaos/mcp export case-1a2b3c4d5e6f --out bundle.json
   npx @mowaos/verify bundle.json
   ```

**Keep the flow, the facts file and the database (`~/.mowa/mcp.db` by default) where
the agent cannot write.** A coding agent can edit files in its working folder. If it
could edit its own facts, the checks that depend on them would mean nothing.

## What the agent sees

| Tool | What it does |
| --- | --- |
| `mowa_list_cases` | Recent cases and their states |
| `mowa_start_case` | Starts a case and returns its id |
| `mowa_list_actions` | The case's state, the moves the agent may propose now, the moves waiting for a person, effects waiting for confirmation, and an `expect` value |
| `mowa_propose` | Proposes a move. The kernel records it or refuses it (a refusal records nothing). Data goes in `payload`, which is recorded and hashed with the step |
| `mowa_get_case` | The case's full history and every effect with its status |

Resources: `mowa://case/{caseId}` (the case as the agent sees it) and
`mowa://case/{caseId}/bundle` (the full verification bundle, for people and tools
rather than the model's context; tool results link to it).

Refusals come back as tool errors the model can act on (`UNAUTHORIZED`,
`NO_TRANSITION`, `STALE`, `MISSING_REQUIRED_FACT`, …), each with the case as it is now.

## The rules it enforces

These are the host contract's rules for AI agents
([host-contract.md, section 7](../../docs/host-contract.md)):

- **The host sets the actor.** Every agent call is actor type `AI`. The flow decides
  what `AI` may do; moves reserved for people are refused with `UNAUTHORIZED`.
- **The host supplies the facts**, from your file. The agent cannot send facts; any it
  tries to pass are ignored. Put what the agent found or wrote in `payload` instead.
- **The host supplies the time** for every decision.
- **Effects wait for a person.** An effect is something the flow asks the outside world
  to do. It stays in `AWAIT_CONFIRMATION` until someone runs `mowa-mcp confirm`, which
  returns a receipt (`decisionHash`, `resultHash`, `transitionId`) for whatever carries
  the effect out. As a library, you can register handlers that run effects instead.
- **Acting on a stale view is refused.** Pass the `expect` value from your last read to
  `mowa_propose`. If anything changed in between, including a person acting, the move is
  refused as `STALE`, and the current case is returned. This also makes retries safe:
  a retried proposal that already went through comes back `STALE` rather than recorded
  twice.

## Protocol

- MCP **2026-07-28** (per-request metadata, `server/discover`), and the earlier
  `initialize`-based revisions **2025-11-25**, **2025-06-18** and **2025-03-26** on the
  same process, as the specification's "dual-era" servers do.
- stdio transport. The protocol is implemented directly, with no SDK.
- W3C `traceparent` / `tracestate` in a request's `_meta` are stored with the step, next
  to who acted. They are not hashed. `mowa-mcp show` and `mowa_get_case` display them.

## Storage

SQLite, through Node's built-in `node:sqlite` (Node 22.13 or later; no npm
dependencies). The server and the review commands can run at the same time: each
commit is one transaction that checks the case version, so two writers can never fork
a case.

## As a library

```js
import { DatabaseSync } from "node:sqlite";
import { loadKernel } from "@mowaos/kernel";
import { AgentHost, McpServer, serveStdio } from "@mowaos/mcp";

const host = await AgentHost.open({
  db: new DatabaseSync("/var/lib/mowa/mcp.db"),
  kernel: await loadKernel(),
  flow,
  factsPath: "/etc/mowa/facts.json",
  effects: {
    // Runs when a call_tool effect is due; the receipt proves the kernel decided it.
    call_tool: async (record, receipt) => (await runTool(record.effect.payload, receipt)) ? "SUCCESS" : "RETRY",
  },
});
await serveStdio(new McpServer(host, { name: "my-server", version: "1.0.0" }));
```

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
