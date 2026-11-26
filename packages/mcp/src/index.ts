// @mowaos/mcp as a library: embed the agent host and the MCP server in your own Node
// process, with your own effect handlers. The CLI (mowa-mcp) is a thin wrapper over this.
export {
  AGENT_ACTOR_TYPE,
  AgentHost,
  type Action,
  type AgentHostOptions,
  type CaseView,
  type Committed,
  type EffectHandler,
  type EffectReceipt,
  type EffectSummary,
  type Refusal,
  type StepSummary,
} from "./agent-host.js";
export { LEGACY_VERSIONS, MODERN_VERSIONS, McpServer, serveStdio, type ServerInfo } from "./server.js";
export { SqliteStorage, type StepMeta } from "./sqlite-storage.js";
