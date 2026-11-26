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
    { event: "INSERT_COIN", actor: "CUSTOMER" },
    { event: "BREW", actor: "CUSTOMER", expect: "needs_service" },
    { event: "REFILLED", actor: "CUSTOMER", refused: "UNAUTHORIZED" },
    { event: "REFILLED", actor: "TECHNICIAN", facts: { "machine:water": "OK" } },
    { event: "BREW", actor: "CUSTOMER", expect: "brewing" },
    { event: "CUP_TAKEN", actor: "SYSTEM", expect: "idle" },
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
    { event: "SUBMIT", actor: "REQUESTER" },
    { event: "APPROVE", actor: "REQUESTER", refused: "UNAUTHORIZED" },
    { event: "APPROVE", actor: "APPROVER", expect: "escalated" },
    { event: "OVERRIDE", actor: "ADMIN", expect: "approved", awaits: "run_action" },
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
    { event: "PROPOSE_TOOL_CALL", actor: "AI", expect: "blocked" },
    { event: "DISMISS", actor: "HUMAN", facts: { "policy:budget": "PASS" } },
    { event: "PROPOSE_TOOL_CALL", actor: "AI", expect: "proposed" },
    { event: "APPROVE_CALL", actor: "AI", refused: "UNAUTHORIZED" },
    { event: "APPROVE_CALL", actor: "HUMAN", expect: "executed" },
  ],
};

export const PRESETS = [coffee, approval, guardrail];
