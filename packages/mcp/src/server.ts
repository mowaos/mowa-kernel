// MCP server for the agent side, written against the 2026-07-28 specification, and
// "dual-era": it also answers the `initialize` handshake of earlier clients
// (2025-11-25 and before), as the specification allows. No SDK: JSON-RPC in, JSON-RPC out.
//
// Every request is handled on its own (the protocol is stateless). The only thing kept
// between requests on a stdio process is the legacy handshake, which the specification
// scopes to the process. Cases are explicit ids the model passes back on each call.
import { AGENT_ACTOR_TYPE, type AgentHost, type Committed, type Refusal } from "./agent-host.js";
import type { StepMeta } from "./sqlite-storage.js";

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

const INSTRUCTIONS = `This server runs a workflow on the MO·WA OS kernel. You act as actor type AI.
- Start a case with mowa_start_case, or find one with mowa_list_cases.
- mowa_list_actions shows the moves you may propose now, and what waits for a person.
- mowa_propose proposes a move. The kernel decides; a refusal records nothing.
- Pass the case's "expect" value with mowa_propose, so a move is refused if the case changed since you read it.
- You cannot supply facts, choose your actor, approve, or confirm effects. People do that.`;

type Json = Record<string, unknown>;
interface Request {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Json;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

const NO_ARGS = { type: "object", additionalProperties: false, properties: {} };
const CASE_ID = { type: "string", description: "The case id, as returned by mowa_start_case or mowa_list_cases." };

const TOOLS = [
  {
    name: "mowa_list_cases",
    title: "List cases",
    description: "List recent cases, newest first, with their current state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: "How many cases (default 20)." } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "mowa_start_case",
    title: "Start a case",
    description:
      "Start a new case on this server's workflow. Returns the case id to pass to the other tools. Cases are kept until a person deletes the database.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { payload: { type: "object", description: "Optional data recorded with the start event." } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "mowa_list_actions",
    title: "List actions",
    description:
      "Show a case's current state, the moves you may propose now, the moves that wait for a person, effects awaiting confirmation, and the 'expect' value to pass to mowa_propose.",
    inputSchema: { type: "object", additionalProperties: false, required: ["caseId"], properties: { caseId: CASE_ID } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "mowa_propose",
    title: "Propose a move",
    description:
      "Propose an event on a case. The kernel checks the flow's rules and the host's facts, then either records the step or refuses it (nothing is recorded). Put your work (a draft, a tool call you want to make, extracted values) in payload: it is recorded and hashed with the step.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["caseId", "event"],
      properties: {
        caseId: CASE_ID,
        event: { type: "string", description: "The event name, from mowa_list_actions (for example PROPOSE_TOOL_CALL)." },
        payload: { type: "object", description: "Data recorded with the event. Integers only for numbers." },
        expect: {
          type: "string",
          description: "The case's 'expect' value from your last read. If the case changed since, the move is refused as STALE.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "mowa_get_case",
    title: "Get a case's history",
    description: "Show a case's full history: every step, who made it, where it went, and every effect with its status.",
    inputSchema: { type: "object", additionalProperties: false, required: ["caseId"], properties: { caseId: CASE_ID } },
    annotations: { readOnlyHint: true },
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "mowa://case/{caseId}",
    name: "case",
    title: "Case",
    description: "A case's current state, available moves, and what waits for a person.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "mowa://case/{caseId}/bundle",
    name: "case-bundle",
    title: "Verification bundle",
    description: "The case's full record (mowa.verification-bundle/1), verifiable offline with npx @mowaos/verify.",
    mimeType: "application/json",
    annotations: { audience: ["user"] },
  },
];

export interface ServerInfo {
  name: string;
  version: string;
}

export class McpServer {
  /** Legacy (initialize-based) protocol version negotiated on this process, if any. */
  private legacy: string | null = null;
  private legacyClient = "agent";

  constructor(
    private readonly host: AgentHost,
    private readonly info: ServerInfo
  ) {}

  private capabilities() {
    return { tools: {}, resources: {} };
  }

  /** Handle one parsed JSON-RPC message. Returns the response, or null for notifications. */
  async handle(message: unknown): Promise<Json | null> {
    const req = message as Request;
    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    if (req.id === undefined) return null; // notifications: initialized, cancelled, …
    try {
      const { result, modern } = await this.dispatch(req);
      const body = modern ? { resultType: "complete", ...result, _meta: { [META_SERVER]: this.info } } : result;
      return { jsonrpc: "2.0", id: req.id, result: body };
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(-32603, err instanceof Error ? err.message : String(err));
      return { jsonrpc: "2.0", id: req.id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
    }
  }

  private async dispatch(req: Request): Promise<{ result: Json; modern: boolean }> {
    const params = (req.params ?? {}) as Json;
    if (req.method === "initialize") {
      const requested = params.protocolVersion as string;
      this.legacy = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      const client = params.clientInfo as { name?: string } | undefined;
      if (client?.name) this.legacyClient = client.name;
      return {
        modern: false,
        result: {
          protocolVersion: this.legacy,
          capabilities: this.capabilities(),
          serverInfo: this.info,
          instructions: INSTRUCTIONS,
        },
      };
    }

    const meta = (params._meta ?? {}) as Json;
    const version = meta[META_VERSION];
    let modern: boolean;
    let client = this.legacyClient;
    if (version !== undefined) {
      if (typeof version !== "string" || !MODERN_VERSIONS.includes(version)) {
        throw new RpcError(-32022, "Unsupported protocol version", {
          supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
          requested: version,
        });
      }
      if (typeof meta[META_CAPS] !== "object" || meta[META_CAPS] === null) {
        throw new RpcError(-32602, `Missing required _meta field ${META_CAPS}`);
      }
      modern = true;
      const info = meta[META_CLIENT] as { name?: string } | undefined;
      client = info?.name ?? "agent";
    } else if (this.legacy) {
      modern = false;
    } else {
      throw new RpcError(
        -32602,
        `Missing _meta ${META_VERSION}. This server supports ${MODERN_VERSIONS.join(", ")} (per-request metadata) and ${LEGACY_VERSIONS.join(", ")} (initialize first).`
      );
    }

    const stepMeta: StepMeta = { client };
    if (typeof meta.traceparent === "string") stepMeta.traceparent = meta.traceparent;
    if (typeof meta.tracestate === "string") stepMeta.tracestate = meta.tracestate;
    const cache = modern ? { ttlMs: 0, cacheScope: "private" } : {};

    switch (req.method) {
      case "server/discover":
        if (!modern) throw new RpcError(-32601, "Method not found: server/discover");
        return {
          modern,
          result: { supportedVersions: MODERN_VERSIONS, capabilities: this.capabilities(), instructions: INSTRUCTIONS },
        };
      case "ping":
        return { modern, result: {} };
      case "tools/list":
        return { modern, result: { tools: TOOLS, ...(modern ? { ttlMs: 3600000, cacheScope: "public" } : {}) } };
      case "tools/call":
        return { modern, result: await this.callTool(params, client, stepMeta) };
      case "resources/list":
        return {
          modern,
          result: {
            resources: this.host.listCases(50).map((c) => ({
              uri: `mowa://case/${c.caseId}`,
              name: c.caseId,
              title: `${c.workflow} · ${c.state}`,
              mimeType: "application/json",
            })),
            ...cache,
          },
        };
      case "resources/templates/list":
        return { modern, result: { resourceTemplates: RESOURCE_TEMPLATES, ...(modern ? { ttlMs: 3600000, cacheScope: "public" } : {}) } };
      case "resources/read":
        return { modern, result: { contents: await this.readResource(params.uri), ...cache } };
      default:
        throw new RpcError(-32601, `Method not found: ${req.method}`);
    }
  }

  private async readResource(uri: unknown): Promise<Json[]> {
    const match = typeof uri === "string" ? /^mowa:\/\/case\/([A-Za-z0-9_.:-]{1,64})(\/bundle)?$/.exec(uri) : null;
    const notFound = () => new RpcError(-32602, "Resource not found", { uri });
    if (!match) throw notFound();
    const caseId = match[1];
    if (match[2]) {
      if (!(await this.host.getCase(caseId, AGENT_ACTOR_TYPE))) throw notFound();
      const bundle = await this.host.exportBundle([caseId]);
      return [{ uri, mimeType: "application/json", text: JSON.stringify(bundle) }];
    }
    const view = await this.host.getCase(caseId, AGENT_ACTOR_TYPE);
    if (!view) throw notFound();
    return [{ uri, mimeType: "application/json", text: JSON.stringify(view) }];
  }

  private async callTool(params: Json, client: string, meta: StepMeta): Promise<Json> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Json;
    const actor = { type: AGENT_ACTOR_TYPE, id: `ai:${client}`.slice(0, 64) };
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);

    switch (name) {
      case "mowa_list_cases": {
        const limit = Number.isInteger(args.limit) ? Math.min(200, Math.max(1, args.limit as number)) : 20;
        const cases = this.host.listCases(limit);
        return toolResult(cases.length ? `${cases.length} case(s).` : "No cases yet. Start one with mowa_start_case.", { cases });
      }
      case "mowa_start_case":
        return outcome(await this.host.startCase({ actor, payload: args.payload, meta }));
      case "mowa_list_actions": {
        const caseId = str("caseId");
        const view = caseId ? await this.host.getCase(caseId, AGENT_ACTOR_TYPE) : null;
        if (!view) return toolError("UNKNOWN_CASE", `No case '${String(caseId)}'. Start one, or list cases.`);
        return toolResult(describeView(view), view, view.caseId);
      }
      case "mowa_propose": {
        const caseId = str("caseId");
        const event = str("event");
        if (!caseId || !event) return toolError("BAD_REQUEST", "caseId and event are required strings.");
        return outcome(
          await this.host.propose({ caseId, event, actor, payload: args.payload, expect: str("expect"), meta })
        );
      }
      case "mowa_get_case": {
        const caseId = str("caseId");
        const view = caseId ? await this.host.getCase(caseId, AGENT_ACTOR_TYPE) : null;
        const history = caseId ? await this.host.history(caseId) : null;
        if (!view || !history) return toolError("UNKNOWN_CASE", `No case '${String(caseId)}'.`);
        const lines = history.steps.map(
          (s) => `${s.version}. ${s.event} by ${s.actor}: ${s.from ?? "start"} → ${s.to}${s.guardFailed ? " (conditions failed)" : ""}`
        );
        return toolResult(`${describeView(view)}\n\nHistory:\n${lines.join("\n")}`, { case: view, ...history }, view.caseId);
      }
      default:
        throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
    }
  }
}

function caseLink(caseId: string): Json {
  return {
    type: "resource_link",
    uri: `mowa://case/${caseId}/bundle`,
    name: `${caseId} bundle`,
    description: "Full verification bundle for this case (for people and auditors; large).",
    mimeType: "application/json",
    annotations: { audience: ["user"] },
  };
}

function toolResult(text: string, structured: unknown, caseId?: string): Json {
  return {
    content: [{ type: "text", text }, ...(caseId ? [caseLink(caseId)] : [])],
    structuredContent: structured,
    isError: false,
  };
}

function toolError(code: string, message: string, structured?: unknown): Json {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: structured ?? { ok: false, code, message },
    isError: true,
  };
}

function outcome(r: Committed | Refusal): Json {
  if (!r.ok) {
    const text = r.current ? `${r.code}: ${r.message}\n\n${describeView(r.current)}` : `${r.code}: ${r.message}`;
    return { ...toolError(r.code, r.message, r), content: [{ type: "text", text }] };
  }
  const s = r.step;
  const effects = s.effects.length
    ? ` Effects: ${s.effects.map((e) => `${e.kind} (${e.status === "AWAIT_CONFIRMATION" ? "waiting for a person to confirm" : e.status})`).join(", ")}.`
    : "";
  const text = `Recorded step ${s.version}: ${s.event}, ${s.from ?? "start"} → ${s.to}${s.guardFailed ? " (the conditions failed, so the flow sent it here)" : ""}.${effects}\n\n${describeView(r.case)}`;
  return toolResult(text, r, r.case.caseId);
}

function describeView(v: { caseId: string; state: string; terminal: boolean; expect: string; actions: { event: string; to: string }[]; waitingFor: { event: string; allowedActors: string[] }[]; awaitingConfirmation: { kind: string }[] }): string {
  const lines = [`Case ${v.caseId} is in state ${v.state}${v.terminal ? " (ended)" : ""}. expect: ${v.expect}`];
  lines.push(
    v.actions.length
      ? `You may propose: ${v.actions.map((a) => `${a.event} (→ ${a.to})`).join(", ")}.`
      : "You have no moves here."
  );
  if (v.waitingFor.length) {
    lines.push(`Waiting for others: ${v.waitingFor.map((w) => `${w.event} by ${w.allowedActors.join("/")}`).join(", ")}.`);
  }
  if (v.awaitingConfirmation.length) {
    lines.push(`Effects waiting for a person to confirm: ${v.awaitingConfirmation.map((e) => e.kind).join(", ")}.`);
  }
  return lines.join("\n");
}

/** Serve over stdio: one JSON-RPC message per line on stdin, responses on stdout. */
export function serveStdio(server: McpServer): Promise<void> {
  return new Promise((resolve) => {
    let buffer = "";
    let pending = Promise.resolve();
    const write = (msg: Json | null) => {
      if (msg) process.stdout.write(JSON.stringify(msg) + "\n");
    };
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      // Answer each request as soon as it is done; the host serialises work per case.
      const job = server.handle(parsed).then(write, (err) =>
        process.stderr.write(`mowa-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
      );
      pending = Promise.all([pending, job]).then(() => undefined);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    process.stdin.on("end", () => {
      onLine(buffer);
      void pending.then(resolve);
    });
  });
}
