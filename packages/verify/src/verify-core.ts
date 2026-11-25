import {
  effectIdOf,
  expectedHashes,
  flowHashOf,
  resultHashOf,
} from "./spec-hash.js";
import type {
  BundleStep,
  SessionVerificationResult,
  VerificationBundle,
  VerificationFailure,
  VerifyReport,
  WasmBindings,
} from "./types.js";

/** Structural equality of JSON values (object key order does not matter). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const kx = Object.keys(x).filter((k) => x[k] !== undefined);
  const ky = Object.keys(y).filter((k) => y[k] !== undefined);
  return kx.length === ky.length && kx.every((k) => Object.hasOwn(y, k) && jsonEqual(x[k], y[k]));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The flow as it was when the recorded decision was made. Lifecycle fields
 * (`status`, `effectiveFrom`, `effectiveTo`) are excluded from `flowHash`
 * (flow-spec.md section 8), so a host may export a flow that has since been
 * deprecated or had its window changed. The recorded commit proves the kernel
 * accepted the flow at the time; replay must still reproduce that commit exactly.
 */
function asReplayable(flow: Record<string, unknown>): Record<string, unknown> {
  return {
    ...flow,
    status: "ACTIVE",
    effectiveFrom: Number.MIN_SAFE_INTEGER,
    effectiveTo: null,
  };
}

function checkPureJsHashes(
  sessionId: string,
  fromVersion: number | null,
  step: BundleStep,
  flow: Record<string, unknown>,
  stepIndex: number,
  errors: VerificationFailure[]
): void {
  const op = step.call === "start" ? "start" : "advance";
  const expected = expectedHashes(
    op,
    sessionId,
    fromVersion,
    step.event,
    step.facts,
    step.ctx,
    flow
  );
  const { commit } = step;

  const checkField = (field: string, actual: unknown, want: unknown) => {
    if (actual !== want) {
      errors.push({
        scope: "step",
        sessionId,
        stepIndex,
        version: commit.newSession.version,
        field,
        message: `Pure-JS spec hash mismatch for '${field}': expected '${String(want)}', got '${String(actual)}'.`,
      });
    }
  };

  checkField("audit.flowHash", commit.audit.flowHash, expected.flowHash);
  checkField("audit.factsHash", commit.audit.factsHash, expected.factsHash);
  checkField("audit.decisionHash", commit.audit.decisionHash, expected.decisionHash);
  checkField("audit.transitionId", commit.audit.transitionId, expected.transitionId);
  checkField("dedupKey", commit.dedupKey, expected.dedupKey);

  if (Array.isArray(commit.outbox)) {
    commit.outbox.forEach((effect, i) => {
      const wantId = effectIdOf(expected.transitionId, i);
      if (effect.id !== wantId) {
        errors.push({
          scope: "step",
          sessionId,
          stepIndex,
          version: commit.newSession.version,
          field: `outbox[${i}].id`,
          message: `Pure-JS effect ID mismatch at outbox[${i}]: expected '${wantId}', got '${String(effect.id)}'.`,
        });
      }
    });
  }

  const expectedResult = resultHashOf(commit);
  checkField("audit.resultHash", commit.audit.resultHash, expectedResult);
}

/**
 * Verify a `mowa.verification-bundle/1` with a given kernel, using both:
 * 1. WASM kernel replay (`startJson` / `advanceJson` / `loadFlowJson`), and
 * 2. Pure-JS independent canonical hashing (`docs/hashing-spec.md`).
 * Runs anywhere: no Node APIs.
 */
export async function verifyBundleWith(
  bundleInput: unknown,
  wasm: WasmBindings
): Promise<VerifyReport> {
  const verifierKernelVersion = wasm.kernelVersion();
  const errors: VerificationFailure[] = [];

  if (!isPlainObject(bundleInput)) {
    errors.push({
      scope: "bundle",
      message: "Bundle must be a JSON object.",
    });
    return {
      ok: false,
      bundleFormat: null,
      bundleKernelVersion: null,
      verifierKernelVersion,
      flowsChecked: 0,
      sessionsChecked: 0,
      totalStepsVerified: 0,
      sessions: [],
      errors,
    };
  }

  const bundleFormat =
    typeof bundleInput.format === "string" ? bundleInput.format : null;
  const bundleKernelVersion =
    typeof bundleInput.kernelVersion === "string"
      ? bundleInput.kernelVersion
      : null;

  if (bundleFormat !== "mowa.verification-bundle/1") {
    errors.push({
      scope: "bundle",
      field: "format",
      message: `Unsupported bundle format '${String(bundleFormat)}'; expected 'mowa.verification-bundle/1'.`,
    });
  }

  if (!isPlainObject(bundleInput.flows)) {
    errors.push({
      scope: "bundle",
      field: "flows",
      message: "Bundle 'flows' must be an object keyed by flowHash.",
    });
  }

  if (!Array.isArray(bundleInput.sessions) || bundleInput.sessions.length === 0) {
    errors.push({
      scope: "bundle",
      field: "sessions",
      message: "Bundle 'sessions' must be a non-empty array.",
    });
  }

  if (bundleKernelVersion !== verifierKernelVersion) {
    errors.push({
      scope: "bundle",
      field: "kernelVersion",
      message: `Bundle was recorded with kernel '${String(bundleKernelVersion)}' but this verifier runs kernel '${verifierKernelVersion}'. Replay needs the same kernel version; use a matching @mowaos/verify release or pass --wasm.`,
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      bundleFormat,
      bundleKernelVersion,
      verifierKernelVersion,
      flowsChecked: 0,
      sessionsChecked: 0,
      totalStepsVerified: 0,
      sessions: [],
      errors,
    };
  }

  const bundle = bundleInput as unknown as VerificationBundle;

  // 1. Validate all flows via both WASM loadFlowJson and pure-JS flowHashOf.
  let flowsChecked = 0;
  for (const [flowHash, flowDef] of Object.entries(bundle.flows)) {
    flowsChecked += 1;
    if (!isPlainObject(flowDef)) {
      errors.push({
        scope: "flow",
        flowHash,
        message: `Flow '${flowHash}' is not a JSON object.`,
      });
      continue;
    }

    const loadRes = JSON.parse(wasm.loadFlowJson(JSON.stringify(flowDef))) as {
      status: string;
      flowHash?: string;
      errors?: unknown[];
      reason?: string;
    };
    if (loadRes.status !== "OK") {
      errors.push({
        scope: "flow",
        flowHash,
        message: `WASM rejected flow '${flowHash}' with status '${loadRes.status}'.`,
      });
    } else if (loadRes.flowHash !== flowHash) {
      errors.push({
        scope: "flow",
        flowHash,
        field: "flowHash",
        message: `Flow key '${flowHash}' does not match WASM computed flowHash '${String(loadRes.flowHash)}'.`,
      });
    }

    const jsFlowHash = flowHashOf(flowDef);
    if (jsFlowHash !== flowHash) {
      errors.push({
        scope: "flow",
        flowHash,
        field: "flowHash",
        message: `Flow key '${flowHash}' does not match pure-JS computed flowHash '${jsFlowHash}'.`,
      });
    }
  }

  // 2. Replay every session step-by-step.
  const sessionResults: SessionVerificationResult[] = [];
  const seenSessionIds = new Set<string>();
  let totalStepsVerified = 0;

  for (const entry of bundle.sessions) {
    if (isPlainObject(entry) && typeof entry.sessionId === "string") {
      if (seenSessionIds.has(entry.sessionId)) {
        errors.push({
          scope: "session",
          sessionId: entry.sessionId,
          message: `Session '${entry.sessionId}' appears more than once in the bundle.`,
        });
        continue;
      }
      seenSessionIds.add(entry.sessionId);
    }

    if (
      !isPlainObject(entry) ||
      typeof entry.sessionId !== "string" ||
      entry.sessionId.length === 0 ||
      !Array.isArray(entry.steps) ||
      entry.steps.length === 0
    ) {
      errors.push({
        scope: "session",
        sessionId: isPlainObject(entry) && typeof entry.sessionId === "string" ? entry.sessionId : undefined,
        message: "Each session entry must have a non-empty 'sessionId' and non-empty 'steps' array.",
      });
      continue;
    }

    const { sessionId, steps } = entry;
    const sessionErrorsBefore = errors.length;
    let prevSession: Record<string, unknown> | null = null;
    let stepsVerified = 0;

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (
        !isPlainObject(step) ||
        !isPlainObject(step.commit) ||
        !isPlainObject(step.commit.newSession) ||
        !isPlainObject(step.commit.audit)
      ) {
        errors.push({
          scope: "step",
          sessionId,
          stepIndex: i,
          message: `Step ${i} is missing required commit structure.`,
        });
        break;
      }

      const expectedCall = i === 0 ? "start" : "advance";
      if (step.call !== expectedCall) {
        errors.push({
          scope: "step",
          sessionId,
          stepIndex: i,
          version: step.commit.newSession.version,
          field: "call",
          message: `Expected step ${i} call to be '${expectedCall}', got '${String(step.call)}'.`,
        });
        break;
      }

      if (step.commit.newSession.version !== i) {
        errors.push({
          scope: "step",
          sessionId,
          stepIndex: i,
          version: step.commit.newSession.version,
          field: "newSession.version",
          message: `Expected contiguous version ${i}, got ${String(step.commit.newSession.version)}.`,
        });
        break;
      }

      const expectedPrevHash =
        prevSession === null ? null : (prevSession.lastResultHash ?? null);
      if (step.commit.audit.prevResultHash !== expectedPrevHash) {
        errors.push({
          scope: "step",
          sessionId,
          stepIndex: i,
          version: i,
          field: "audit.prevResultHash",
          message: `Chain link broken at version ${i}: expected prevResultHash '${String(expectedPrevHash)}', got '${String(step.commit.audit.prevResultHash)}'.`,
        });
      }

      const flowHash = step.commit.newSession.flowHash;
      const flow = bundle.flows[flowHash];
      if (!flow) {
        errors.push({
          scope: "step",
          sessionId,
          stepIndex: i,
          version: i,
          field: "newSession.flowHash",
          message: `Flow '${String(flowHash)}' referenced by step ${i} is missing from bundle.flows.`,
        });
        break;
      }

      // Engine 1: WASM replay
      const replayFlow = asReplayable(flow);
      const reqJson =
        step.call === "start"
          ? JSON.stringify({
              sessionId,
              event: step.event,
              flow: replayFlow,
              ctx: step.ctx,
            })
          : JSON.stringify({
              session: prevSession,
              event: step.event,
              flow: replayFlow,
              facts: step.facts ?? { facts: {} },
              ctx: step.ctx,
            });

      const wasmRaw =
        step.call === "start"
          ? wasm.startJson(reqJson)
          : wasm.advanceJson(reqJson);
      const wasmOut = JSON.parse(wasmRaw) as {
        status: string;
        commit?: BundleStep["commit"];
        error?: unknown;
        reason?: string;
      };

      if (wasmOut.status !== "OK" || !wasmOut.commit) {
        errors.push({
          scope: "step",
          sessionId,
          stepIndex: i,
          version: i,
          message: `WASM replay failed at step ${i} (version ${i}): status '${wasmOut.status}'.`,
        });
        break;
      }

      if (!jsonEqual(wasmOut.commit, step.commit)) {
        errors.push({
          scope: "step",
          sessionId,
          stepIndex: i,
          version: i,
          field: "commit",
          message: `WASM replay commit differs from recorded commit at step ${i} (version ${i}).`,
        });
      }

      // Engine 2: Pure-JS canonical hash verification
      const fromVersion = prevSession === null ? null : i - 1;
      checkPureJsHashes(sessionId, fromVersion, step, flow, i, errors);

      prevSession = wasmOut.commit.newSession;
      stepsVerified += 1;
      totalStepsVerified += 1;
    }

    const sessionOk = errors.length === sessionErrorsBefore;
    const lastStep = steps[steps.length - 1];
    sessionResults.push({
      sessionId,
      stepsVerified,
      finalVersion:
        isPlainObject(lastStep) && isPlainObject(lastStep.commit?.newSession)
          ? lastStep.commit.newSession.version
          : null,
      finalResultHash:
        isPlainObject(lastStep) && isPlainObject(lastStep.commit?.audit)
          ? lastStep.commit.audit.resultHash
          : null,
      ok: sessionOk,
    });
  }

  return {
    ok: errors.length === 0,
    bundleFormat,
    bundleKernelVersion,
    verifierKernelVersion,
    flowsChecked,
    sessionsChecked: bundle.sessions.length,
    totalStepsVerified,
    sessions: sessionResults,
    errors,
  };
}
