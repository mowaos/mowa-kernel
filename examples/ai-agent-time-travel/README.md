# An AI agent, blocked, approved, and replayed

A single script that shows what [`@mowaos/mcp`](../../packages/mcp) does for an AI
agent, in about 15 seconds:

```bash
npm test                                         # once: builds the kernel and packages
npm run demo:agent                               # or: node examples/ai-agent-time-travel/demo.mjs --slow
```

```
1. An AI agent works on a case, through MCP

agent   proposes a tool call: web_search "quarterly figures"
kernel  blocked: the host's budget check says FAIL → blocked
agent   tries to clear the block itself
kernel  refused UNAUTHORIZED: only a person may dismiss. Nothing recorded.
person  raises the budget and dismisses the flag
agent   proposes again → proposed
agent   tries to approve its own call
kernel  refused UNAUTHORIZED: an agent can propose, never approve.
person  approves the call
person  confirms the tool call; receipt resultHash 07cb6b01…

2. The record, checked offline

audit   0. CASE_STARTED      AI:ai:demo-agent     start    → waiting   5bbad793…
audit   1. PROPOSE_TOOL_CALL AI:ai:demo-agent     waiting  → blocked   53661a20…
…
audit   PASS: 5 steps replayed on the kernel, every hash recomputed independently

3. Time travel, from the bundle alone

audit   rewind to step 1 and replay it: → blocked, same decision d5b567b5… ✓
audit   branch: "what if the budget had passed?" → proposed, decision 4f20b9ef… (a different history)
audit   rewrite history (claim the budget passed at step 1): FAIL, 5 mismatches found
```

## What happens

1. **The run.** A short script plays the agent. It speaks MCP to `mowa-mcp serve` over
   stdio, exactly as a model-driven agent would, so the demo needs no API key and runs
   the same every time. The flow is
   [`tool-guardrail.flow.json`](../../packages/mcp/examples/tool-guardrail.flow.json):
   the agent may propose a tool call; host policy facts decide whether it goes ahead or
   is blocked for review; only a person can clear a block or approve the call; and the
   approved call waits in the outbox until a person confirms it. The person's moves
   are the `mowa-mcp act` and `confirm` commands, run on the same database.
2. **The record.** The case is exported as a `mowa.verification-bundle/1` and checked
   by `@mowaos/verify`: every step replayed on the kernel, every hash recomputed from
   the [hashing specification](../../docs/hashing-spec.md) by separate code.
3. **Time travel.** Using only the bundle, the script replays step 1 and gets the same
   decision. It then branches: with the budget passing, the same proposal takes another
   path, with a different decision hash. Finally it rewrites history, claiming the
   budget passed at step 1, and verification fails.

The point of the last step: the record says what the host knew when the agent acted.
Nobody, the agent included, can change that afterwards without it showing.

## Check the record yourself

The script prints where it wrote the bundle:

```bash
npx @mowaos/verify /tmp/mowa-demo-…/bundle.json
```
