export interface WasmBindings {
  startJson(reqJson: string): string;
  advanceJson(reqJson: string): string;
  loadFlowJson(reqJson: string): string;
  kernelVersion(): string;
}

export interface BundleStep {
  call: "start" | "advance";
  event: Record<string, unknown>;
  facts?: Record<string, unknown>;
  ctx: Record<string, unknown>;
  commit: {
    newSession: {
      sessionId: string;
      caseId: string;
      flowId: string;
      flowVersion: string;
      flowHash: string;
      currentNode: string;
      version: number;
      terminal: boolean;
      lastResultHash?: string | null;
      [key: string]: unknown;
    };
    audit: {
      transitionId: string;
      decisionHash: string;
      resultHash: string;
      prevResultHash: string | null;
      flowHash: string;
      factsHash: string;
      kernelVersion: string;
      [key: string]: unknown;
    };
    outbox: Array<{
      id: string;
      kind: string;
      payload: unknown;
      [key: string]: unknown;
    }>;
    dedupKey: string;
    expectedSessionVersion: number | null;
    [key: string]: unknown;
  };
}

export interface VerificationBundle {
  format: "mowa.verification-bundle/1";
  kernelVersion: string;
  flows: Record<string, Record<string, unknown>>;
  sessions: Array<{
    sessionId: string;
    steps: BundleStep[];
  }>;
  contextData?: Record<string, unknown>;
}

export interface VerifyOptions {
  /** Optional pre-loaded WASM module; if omitted, loads bundled wasm or `wasmPath`. */
  wasm?: WasmBindings;
  /** Optional path to a custom `mowa_wasm.js` CommonJS/ESM module. */
  wasmPath?: string;
}

export interface VerificationFailure {
  scope: "bundle" | "flow" | "session" | "step";
  sessionId?: string;
  flowHash?: string;
  stepIndex?: number;
  version?: number;
  field?: string;
  message: string;
}

export interface SessionVerificationResult {
  sessionId: string;
  stepsVerified: number;
  finalVersion: number | null;
  finalResultHash: string | null;
  ok: boolean;
}

export interface VerifyReport {
  ok: boolean;
  bundleFormat: string | null;
  bundleKernelVersion: string | null;
  verifierKernelVersion: string;
  flowsChecked: number;
  sessionsChecked: number;
  totalStepsVerified: number;
  sessions: SessionVerificationResult[];
  errors: VerificationFailure[];
}
