// Playground presets. Each one is a flow (docs/flow-spec.md) plus what the page needs
// to drive it: who can act, what each event carries, which effects wait for a person,
// and a demo path that the tests run end to end.

const coffee = {
  key: "coffee",
  title: "Smart Coffee Machine",
  blurb:
    "Pay, then brew. If the water or beans run out, the machine routes to a technician instead of failing. Try refilling as the customer: the kernel refuses.",
  startEvent: { type: "POWER_ON", actor: "SYSTEM" },
  flow: {
    id: "example.coffee-machine",
    version: "1",
    status: "ACTIVE",
    startNode: "idle",
    startActors: ["SYSTEM"],
    description: "A coffee machine that sends supply problems to a technician.",
    declaredFacts: {
      "machine:water": ["OK", "EMPTY"],
      "machine:beans": ["OK", "EMPTY"],
    },
    nodes: {
      idle: {
        id: "idle", type: "waiting", tier: "T1",
        transitions: { INSERT_COIN: { to: "paid", allowedActors: ["CUSTOMER"] } },
      },
      paid: {
        id: "paid", type: "waiting", tier: "T1",
        transitions: {
          BREW: {
            to: "brewing",
            allowedActors: ["CUSTOMER"],
            guard: {
              op: "all_of",
              guards: [
                { op: "status_is", target: "machine:water", status: "OK" },
                { op: "status_is", target: "machine:beans", status: "OK" },
              ],
            },
            onGuardFail: "needs_service",
          },
          CANCEL: { to: "idle", allowedActors: ["CUSTOMER"] },
        },
      },
      brewing: {
        id: "brewing", type: "action", tier: "T0",
        onEnter: [{ kind: "dispense", payload: { drink: "coffee" } }],
        transitions: { CUP_TAKEN: { to: "idle", allowedActors: ["SYSTEM"] } },
      },
      needs_service: {
        id: "needs_service", type: "review", tier: "T2",
        onEnter: [{ kind: "alert_technician", payload: { reason: "supplies" } }],
        transitions: { REFILLED: { to: "paid", allowedActors: ["TECHNICIAN"] } },
      },
    },
    effectiveFrom: 0,
  },
  actors: ["CUSTOMER", "TECHNICIAN", "SYSTEM"],
  initialFacts: { "machine:water": "EMPTY", "machine:beans": "OK" },
  payloads: {},
  confirm: [],
  demo: [
    {
      event: "INSERT_COIN", actor: "CUSTOMER",
      say: "Insert a coin as the CUSTOMER.",
      after: "The kernel moved the machine from idle to paid and recorded it as step 1. Its hashes are in the Hash audit panel.",
    },
    {
      event: "BREW", actor: "CUSTOMER", expect: "needs_service",
      say: "Press BREW. The water is EMPTY (see the facts), so watch where the machine goes.",
      after: "Brewing needs water and beans to be OK. The check failed, so instead of refusing, the kernel sent the machine to needs_service and emitted an alert_technician effect (see the Outbox).",
    },
    {
      event: "REFILLED", actor: "CUSTOMER", refused: "UNAUTHORIZED",
      say: "Try refilling the machine yourself, as the CUSTOMER.",
      after: "Refused: only a TECHNICIAN may refill. The kernel rejected the event, and nothing was recorded.",
    },
    {
      event: "REFILLED", actor: "TECHNICIAN", facts: { "machine:water": "OK" },
      say: "Act as the TECHNICIAN, set the water to OK, and refill.",
      after: "Back to paid, and the water is now OK.",
    },
    {
      event: "BREW", actor: "CUSTOMER", expect: "brewing",
      say: "Brew again, as the CUSTOMER.",
      after: "Water and beans are both OK, so the check passes: the machine brews, and a dispense effect appears in the Outbox.",
    },
    {
      event: "CUP_TAKEN", actor: "SYSTEM", expect: "idle",
      say: "The machine's own sensor (SYSTEM) reports that the cup was taken.",
      after: "Back to idle. Every step is hashed and chained to the one before it.",
    },
  ],
};

const approval = {
  key: "approval",
  title: "Two-Phase Action Approval",
  blurb:
    "Phase one: a person approves the request in the flow. Phase two: the action waits in the outbox (AWAIT_CONFIRMATION) until someone confirms it. Requests over the limit escalate to an admin.",
  startEvent: { type: "CREATE_REQUEST", actor: "REQUESTER" },
  flow: {
    id: "example.two-phase-approval",
    version: "1",
    status: "ACTIVE",
    startNode: "draft",
    startActors: ["REQUESTER"],
    description: "Approve in the flow, then confirm the effect in the outbox.",
    declaredFacts: { "check:limit": ["WITHIN", "EXCEEDED"] },
    nodes: {
      draft: {
        id: "draft", type: "intake", tier: "T1",
        transitions: {
          SUBMIT: { to: "awaiting_approval", allowedActors: ["REQUESTER"] },
          CANCEL: { to: "cancelled", allowedActors: ["REQUESTER"] },
        },
      },
      awaiting_approval: {
        id: "awaiting_approval", type: "approval", tier: "T2",
        onEnter: [{ kind: "notify", payload: { to: "approver" } }],
        transitions: {
          APPROVE: {
            to: "approved",
            allowedActors: ["APPROVER"],
            guard: { op: "status_is", target: "check:limit", status: "WITHIN" },
            onGuardFail: "escalated",
          },
          REJECT: { to: "draft", allowedActors: ["APPROVER"] },
        },
      },
      escalated: {
        id: "escalated", type: "approval", tier: "T3",
        onEnter: [{ kind: "notify", payload: { to: "admin" } }],
        transitions: {
          OVERRIDE: { to: "approved", allowedActors: ["ADMIN"] },
          REJECT: { to: "draft", allowedActors: ["ADMIN"] },
        },
      },
      approved: {
        id: "approved", type: "outcome", tier: "T0", terminal: true,
        onEnter: [{ kind: "run_action", payload: { action: "nightly-export" } }],
      },
      cancelled: { id: "cancelled", type: "outcome", tier: "T0", terminal: true },
    },
    effectiveFrom: 0,
  },
  actors: ["REQUESTER", "APPROVER", "ADMIN"],
  initialFacts: { "check:limit": "EXCEEDED" },
  payloads: {},
  confirm: ["run_action"],
  demo: [
    {
      event: "SUBMIT", actor: "REQUESTER",
      say: "Submit the request as the REQUESTER.",
      after: "The request now waits for approval, and a notify effect tells the approver (see the Outbox).",
    },
    {
      event: "APPROVE", actor: "REQUESTER", refused: "UNAUTHORIZED",
      say: "Try approving your own request, still as the REQUESTER.",
      after: "Refused: only an APPROVER may approve. Nothing was recorded.",
    },
    {
      event: "APPROVE", actor: "APPROVER", expect: "escalated",
      say: "Approve as the APPROVER. The request is over the limit (check:limit is EXCEEDED).",
      after: "Over the limit, so the check failed, and the request went up to an admin instead of being approved.",
    },
    {
      event: "OVERRIDE", actor: "ADMIN", expect: "approved", awaits: "run_action",
      say: "Override as the ADMIN.",
      after: "Approved. That was phase one. In phase two, the run_action effect waits in the Outbox as AWAIT_CONFIRMATION: press Confirm there to let it run.",
    },
  ],
};

const guardrail = {
  key: "guardrail",
  title: "AI Tool-Calling Guardrail",
  blurb:
    "An AI agent may only propose a tool call. Host policy checks run first; a person approves before the tool runs. Try approving as the AI: the kernel refuses.",
  startEvent: { type: "TASK_RECEIVED", actor: "SYSTEM" },
  flow: {
    id: "example.ai-tool-guardrail",
    version: "1",
    status: "ACTIVE",
    startNode: "waiting",
    startActors: ["SYSTEM"],
    description: "AI proposes a tool call, host policy checks it, a person approves.",
    declaredFacts: {
      "policy:allowlist": ["PASS", "FAIL"],
      "policy:budget": ["PASS", "FAIL"],
    },
    nodes: {
      waiting: {
        id: "waiting", type: "intake", tier: "T1",
        transitions: {
          PROPOSE_TOOL_CALL: {
            to: "proposed",
            allowedActors: ["AI"],
            guard: { op: "none_with_status", prefix: "policy:", status: "FAIL" },
            onGuardFail: "blocked",
          },
        },
      },
      proposed: {
        id: "proposed", type: "approval", tier: "T2",
        transitions: {
          APPROVE_CALL: { to: "executed", allowedActors: ["HUMAN"] },
          REJECT_CALL: { to: "waiting", allowedActors: ["HUMAN"] },
        },
      },
      blocked: {
        id: "blocked", type: "review", tier: "T2",
        onEnter: [{ kind: "flag_for_review", payload: { reason: "policy" } }],
        transitions: { DISMISS: { to: "waiting", allowedActors: ["HUMAN"] } },
      },
      executed: {
        id: "executed", type: "action", tier: "T0",
        onEnter: [{ kind: "call_tool", payload: { tool: "web_search" } }],
        transitions: { NEXT_TASK: { to: "waiting", allowedActors: ["SYSTEM"] } },
      },
    },
    effectiveFrom: 0,
  },
  actors: ["AI", "HUMAN", "SYSTEM"],
  initialFacts: { "policy:allowlist": "PASS", "policy:budget": "FAIL" },
  payloads: {
    PROPOSE_TOOL_CALL: { tool: "web_search", query: "latest release notes" },
  },
  confirm: [],
  demo: [
    {
      event: "PROPOSE_TOOL_CALL", actor: "AI", expect: "blocked",
      say: "As the AI, propose a tool call. The host's budget check says FAIL.",
      after: "A policy check failed, so the proposal went to blocked for a person to look at. The AI cannot talk its way past a fact the host supplies.",
    },
    {
      event: "DISMISS", actor: "HUMAN", facts: { "policy:budget": "PASS" },
      say: "As the HUMAN, set the budget to PASS and dismiss the flag.",
      after: "Back to waiting, with every policy check now passing.",
    },
    {
      event: "PROPOSE_TOOL_CALL", actor: "AI", expect: "proposed",
      say: "Let the AI propose the tool call again.",
      after: "The checks pass, so the call is proposed. Nothing has run yet.",
    },
    {
      event: "APPROVE_CALL", actor: "AI", refused: "UNAUTHORIZED",
      say: "Now try approving the call as the AI itself.",
      after: "Refused: only a HUMAN may approve. That is the guardrail: an agent can propose, never approve.",
    },
    {
      event: "APPROVE_CALL", actor: "HUMAN", expect: "executed",
      say: "Approve the call as the HUMAN.",
      after: "Executed. The call_tool effect is emitted only now, after a person approved.",
    },
  ],
};

export const PRESETS = [coffee, approval, guardrail];

// Shown when a preset's guided path is complete.
export const FINALE =
  "That's the whole path. Now try three things: drag the Time travel slider back and press Tamper, and watch both engines catch it. Press Rewind to branch from any step. Copy the replay link to send this exact run to someone.";
