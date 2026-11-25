// Timing harness shared by the Node and browser runners.
//
// Browsers coarsen performance.now() (to 5 µs with cross-origin isolation, 100 µs
// without), so every runtime times *batches* of calls and reports the per-call
// mean of each batch. The median of those batch means is the headline figure;
// p95 shows how noisy the run was.

import { FLOW_SIZES, buildRequests } from "./fixtures.mjs";

export const DEFAULTS = { warmupBatches: 20, batches: 60, batchSize: 100 };

function summarise(perCall) {
  const s = [...perCall].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { medianUs: at(0.5), p95Us: at(0.95), minUs: s[0] };
}

/** Time `fn` (one call) in batches; returns µs per call. */
export function measure(now, fn, opts = DEFAULTS) {
  const { warmupBatches, batches, batchSize } = opts;
  for (let b = 0; b < warmupBatches; b += 1) for (let i = 0; i < batchSize; i += 1) fn();
  const perCall = [];
  for (let b = 0; b < batches; b += 1) {
    const t0 = now();
    for (let i = 0; i < batchSize; i += 1) fn();
    perCall.push(((now() - t0) * 1000) / batchSize);
  }
  return summarise(perCall);
}

/** Async variant for host calls, which return promises. `setup` runs untimed per call. */
export async function measureAsync(now, setup, fn, opts = DEFAULTS) {
  const { warmupBatches, batches, batchSize } = opts;
  const perCall = [];
  for (let b = 0; b < warmupBatches + batches; b += 1) {
    const inputs = [];
    for (let i = 0; i < batchSize; i += 1) inputs.push(await setup());
    const t0 = now();
    for (let i = 0; i < batchSize; i += 1) await fn(inputs[i]);
    if (b >= warmupBatches) perCall.push(((now() - t0) * 1000) / batchSize);
  }
  return summarise(perCall);
}

function check(raw) {
  const res = JSON.parse(raw);
  if (res.status !== "OK") throw new Error(`kernel returned ${res.status}`);
}

/**
 * Run the kernel scenarios. `now()` returns milliseconds (performance.now).
 * Returns rows: { scenario, size, medianUs, p95Us, minUs }.
 */
export function runKernelScenarios(kernel, now, opts = DEFAULTS) {
  const rows = [];
  for (const size of FLOW_SIZES) {
    const r = buildRequests(kernel, size);
    check(kernel.advanceJson(r.advanceHandle));
    check(kernel.advanceJson(r.advanceFull));

    const add = (scenario, fn) => rows.push({ scenario, size, ...measure(now, fn, opts) });
    add("advance · handle · kernel only", () => kernel.advanceJson(r.advanceHandle));
    add("advance · handle · with JSON round-trip", () =>
      JSON.parse(kernel.advanceJson(JSON.stringify(r.advanceHandleObj)))
    );
    add("advance · full flow · kernel only", () => kernel.advanceJson(r.advanceFull));
    add("start · handle · kernel only", () => kernel.startJson(r.startHandle));
  }
  return rows;
}

/**
 * One host step end to end: @mowaos/host-browser advanceSession with in-memory
 * storage (validation, dedup, kernel call, step record, outbox). Each timed call
 * advances a fresh session started untimed beforehand.
 */
export async function runHostScenario(hostLib, kernel, now, opts = DEFAULTS) {
  const { MowaBrowserHost, WasmKernelBridge, MemoryStorage } = hostLib;
  const { chainFlow, event, CTX, FACTS } = await import("./fixtures.mjs");
  const host = new MowaBrowserHost(new WasmKernelBridge(kernel), { storage: new MemoryStorage() });
  const { flowHash } = await host.installFlow(chainFlow(3));
  let n = 0;
  const setup = async () => {
    n += 1;
    const sessionId = `S_HOST_${n}`;
    await host.startSession({ sessionId, event: event(`H0_${n}`, "OPEN", 1000), flowHash, ctx: CTX });
    return sessionId;
  };
  const step = (sessionId) =>
    host.advanceSession({ sessionId, event: event(`H1_${sessionId}`, "STEP", 2000), facts: FACTS, ctx: CTX });
  return [{ scenario: "host advanceSession (in-memory storage)", size: 3, ...(await measureAsync(now, setup, step, opts)) }];
}

export function formatTable(rows) {
  const lines = ["| Scenario | Flow nodes | Median µs/call | p95 µs/call |", "| --- | ---: | ---: | ---: |"];
  for (const r of rows) {
    lines.push(`| ${r.scenario} | ${r.size} | ${r.medianUs.toFixed(1)} | ${r.p95Us.toFixed(1)} |`);
  }
  return lines.join("\n");
}
