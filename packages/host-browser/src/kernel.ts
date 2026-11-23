/**
 * WASM Kernel Bridge for MO·WA OS Browser Host.
 * Bridges JavaScript calls to the Rust mowa-wasm module via JSON boundary.
 */

import {
  FlowHandleNotFoundError,
  type CanonicalEvent,
  type Commit,
  type DecisionContext,
  type DecisionFacts,
  type DedupResponse,
  type FlowDefinition,
  type KernelResponse,
  type LoadFlowResponse,
  type WorkflowSession,
} from "./types.js";

export interface WasmKernelModule {
  startJson(req: string): string;
  advanceJson(req: string): string;
  dedupKeyJson(req: string): string;
  loadFlowJson(flow: string): string;
  kernelVersion(): string;
}

export class KernelExecutionError extends Error {
  constructor(
    public readonly status: string,
    public readonly details: unknown
  ) {
    super(`Kernel execution failed with status '${status}': ${JSON.stringify(details)}`);
    this.name = "KernelExecutionError";
  }
}

export class WasmKernelBridge {
  constructor(private readonly wasm: WasmKernelModule) {}

  getVersion(): string {
    return this.wasm.kernelVersion();
  }

  loadFlow(flow: FlowDefinition): { flowHandle: string; flowHash: string } {
    const raw = this.wasm.loadFlowJson(JSON.stringify(flow));
    const res = JSON.parse(raw) as LoadFlowResponse;

    if (res.status !== "OK") {
      throw new KernelExecutionError(res.status, res);
    }
    return { flowHandle: res.flowHandle, flowHash: res.flowHash };
  }

  dedupKey(
    op: "START" | "ADVANCE",
    sessionId: string,
    event: CanonicalEvent
  ): { dedupKey: string; intentHash: string } {
    const raw = this.wasm.dedupKeyJson(
      JSON.stringify({ op, sessionId, event })
    );
    const res = JSON.parse(raw) as DedupResponse;

    if (res.status !== "OK") {
      throw new KernelExecutionError(res.status, res);
    }
    return { dedupKey: res.dedupKey, intentHash: res.intentHash };
  }

  start(
    sessionId: string,
    event: CanonicalEvent,
    flow: string | FlowDefinition,
    ctx: DecisionContext
  ): Commit {
    const raw = this.wasm.startJson(
      JSON.stringify({ sessionId, event, flow, ctx })
    );
    const res = JSON.parse(raw) as KernelResponse;

    if (res.status === "FLOW_HANDLE_NOT_FOUND") {
      throw new FlowHandleNotFoundError(res.handle);
    }
    if (res.status !== "OK") {
      throw new KernelExecutionError(res.status, res);
    }
    return res.commit;
  }

  advance(
    session: WorkflowSession,
    event: CanonicalEvent,
    flow: string | FlowDefinition,
    facts: DecisionFacts,
    ctx: DecisionContext
  ): Commit {
    const raw = this.wasm.advanceJson(
      JSON.stringify({ session, event, flow, facts, ctx })
    );
    const res = JSON.parse(raw) as KernelResponse;

    if (res.status === "FLOW_HANDLE_NOT_FOUND") {
      throw new FlowHandleNotFoundError(res.handle);
    }
    if (res.status !== "OK") {
      throw new KernelExecutionError(res.status, res);
    }
    return res.commit;
  }
}
