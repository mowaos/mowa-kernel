/**
 * The kernel's JSON boundary. Every call takes and returns a JSON string, as
 * described in docs/kernel-spec.md and docs/host-contract.md.
 *
 * This is the shape `WasmKernelBridge` in `@mowaos/host-browser` and
 * `verifyBundle` in `@mowaos/verify` accept.
 */
export interface MowaKernel {
  /** `flow` → `{status: "OK", flowHandle, flowHash}` */
  loadFlowJson(input: string): string;
  /** `{sessionId, event, flow, ctx}` → `{status: "OK", commit}` */
  startJson(input: string): string;
  /** `{session, event, flow, facts?, ctx}` → `{status: "OK", commit}` */
  advanceJson(input: string): string;
  /** `{op, sessionId, event}` → `{status: "OK", dedupKey, intentHash}` */
  dedupKeyJson(input: string): string;
  /** The kernel version, e.g. `"0.5.2"`. It is recorded in every audit record. */
  kernelVersion(): string;
}

/** Where the browser entry gets the `.wasm` binary from. */
export type WasmSource =
  | string
  | URL
  | Request
  | Response
  | ArrayBuffer
  | ArrayBufferView
  | WebAssembly.Module
  | Promise<Response>;

export interface LoadKernelOptions {
  /**
   * Browser entry only. Defaults to `mowa_wasm_bg.wasm` next to the package's
   * JavaScript, which bundlers such as Vite and webpack resolve automatically.
   * Pass a URL (e.g. `chrome.runtime.getURL("mowa_wasm_bg.wasm")`) or the bytes
   * when your environment serves it from somewhere else. Ignored in Node.
   */
  wasm?: WasmSource;
}
