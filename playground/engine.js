// Playground engine: one session on one preset, with no DOM, so the same code runs in
// the page and in the Node tests. Libraries are passed in, because the page loads them
// through an import map and Node loads them from the packages' dist folders.
//
//   const engine = await createEngine({ host, verify, kernel, preset });
//   await engine.fire("BREW", "CUSTOMER");   // -> { ok, commit } or { ok: false, code }
//   await engine.rewind(2);                  // keep steps 0..2, replayed on a fresh host
//   engine.hashMatrix(1);                    // WASM vs. pure-JS hashes for step 1
//   await engine.check();                    // replay + spec hashes over the whole bundle

const SESSION_ID = "playground-1";
const CASE_ID = "case-1";
// A fixed clock: the same clicks give the same hashes on every machine.
const T0 = Date.UTC(2026, 0, 1);

export async function createEngine({ host: hostLib, verify, kernel, preset }) {
  const facts = { ...preset.initialFacts };
  let host;
  let steps = []; // { call, event, facts?, ctx } as fired, in order
  let refusals = [];
  let attempts = []; // every fire, refused or not: { event, actor, facts, at }
  let tamperAt = null;
  let lastMs = null;

  function newHost() {
    const storage = new hostLib.MemoryStorage();
    const outbox = new hostLib.OutboxDispatcher(storage);
    const kinds = new Set(
      Object.values(preset.flow.nodes).flatMap((n) => (n.onEnter ?? []).map((e) => e.kind))
    );
    for (const kind of kinds) {
      const result = preset.confirm.includes(kind) ? "AWAIT_CONFIRMATION" : "SUCCESS";
      outbox.registerHandler(kind, async () => result);
    }
    return new hostLib.MowaBrowserHost(new hostLib.WasmKernelBridge(kernel), {
      storage,
      outboxDispatcher: outbox,
    });
  }

  function makeEvent(n, type, actorType) {
    return {
      id: `e${n}`,
      type,
      source: "playground",
      caseId: CASE_ID,
      timestamp: T0 + n * 1000,
      idempotencyKey: `idem-${n}`,
      actor: { type: actorType, id: `${actorType.toLowerCase()}-1` },
      payload: preset.payloads[type] ?? {},
    };
  }

  // The host dispatches the outbox in the background after each commit; let it finish,
  // then drain anything it left, so the page shows settled effect statuses.
  async function settle() {
    await new Promise((r) => setTimeout(r, 0));
    await host.getOutbox().dispatchPending();
  }

  async function apply(step) {
    const t = performance.now();
    const commit =
      step.call === "start"
        ? await host.startSession({ sessionId: SESSION_ID, event: step.event, flowHash, ctx: step.ctx })
        : await host.advanceSession({ sessionId: SESSION_ID, event: step.event, facts: step.facts, ctx: step.ctx });
    lastMs = performance.now() - t;
    await settle();
    return commit;
  }

  let flowHash;
  async function boot() {
    host = newHost();
    ({ flowHash } = await host.installFlow(preset.flow));
  }

  await boot();
  const startEvent = makeEvent(0, preset.startEvent.type, preset.startEvent.actor);
  const start = { call: "start", event: startEvent, ctx: { asOf: startEvent.timestamp, contextRefs: {} } };
  await apply(start);
  steps.push(start);

  async function bundle({ tampered = true } = {}) {
    const b = await host.exportVerificationBundle([SESSION_ID]);
    if (tampered && tamperAt !== null) tamper(b.sessions[0].steps[tamperAt]);
    return b;
  }

  // Change one recorded input, the way someone rewriting history would: flip a fact,
  // or, on a step without facts, claim a different actor.
  function tamper(step) {
    const declared = preset.flow.declaredFacts;
    const name = Object.keys(step.facts?.facts ?? {}).find((k) => declared[k]?.length > 1);
    if (name) {
      const statuses = declared[name];
      const now = step.facts.facts[name];
      step.facts.facts[name] = statuses[(statuses.indexOf(now) + 1) % statuses.length];
    } else {
      step.event.actor.id = "someone-else";
    }
  }

  let cached = null; // bundle for the current history, untampered
  async function current() {
    cached ??= await bundle({ tampered: false });
    return cached;
  }

  return {
    preset,
    facts,
    get stepCount() {
      return steps.length;
    },
    get refusals() {
      return refusals;
    },
    /** Every event fired, refused ones included, with the facts it carried. */
    get attempts() {
      return attempts;
    },
    get lastMs() {
      return lastMs;
    },
    get tamperAt() {
      return tamperAt;
    },

    /** Session after step `i` (default: the latest). */
    async sessionAt(i = steps.length - 1) {
      return (await current()).sessions[0].steps[i].commit.newSession;
    },

    async steps() {
      return (await current()).sessions[0].steps;
    },

    /** Transitions out of the node the session is on now. */
    async available() {
      const { state } = await this.sessionAt();
      const node = preset.flow.nodes[state];
      return Object.entries(node.transitions ?? {}).map(([event, t]) => ({ event, ...t }));
    },

    /** Fire an event with the current facts. Refusals are recorded, never committed. */
    async fire(type, actorType) {
      const n = steps.length;
      attempts.push({ event: type, actor: actorType, facts: { ...facts }, at: n });
      const event = makeEvent(n, type, actorType);
      const step = {
        call: "advance",
        event,
        facts: { facts: { ...facts } },
        ctx: { asOf: event.timestamp, contextRefs: {} },
      };
      try {
        const commit = await apply(step);
        steps.push(step);
        cached = null;
        return { ok: true, commit };
      } catch (err) {
        // KERNEL_ERROR carries the kernel's own code (UNAUTHORIZED, NO_TRANSITION, …).
        const code =
          err instanceof hostLib.KernelExecutionError
            ? (err.details?.error?.code ?? err.status)
            : err.name || "ERROR";
        const refusal = { at: n, event: type, actor: actorType, code, message: err.message };
        refusals.push(refusal);
        return { ok: false, ...refusal };
      }
    },

    /** Time travel: keep steps 0..i, replayed on a fresh host, and drop the rest. */
    async rewind(i) {
      const keep = steps.slice(0, i + 1);
      await boot();
      for (const step of keep) await apply(step);
      steps = keep;
      refusals = refusals.filter((r) => r.at <= i);
      attempts = attempts.filter((a) => a.at <= i);
      if (tamperAt !== null && tamperAt > i) tamperAt = null;
      cached = null;
    },

    /** Fire a list of attempts (from a replay link) with the facts each one carried. */
    async replay(list) {
      for (const a of list) {
        Object.assign(facts, a.facts);
        await this.fire(a.event, a.actor);
      }
    },

    setTamper(i) {
      tamperAt = i;
    },

    /** Recorded hashes for step `i` next to the ones the pure-JS spec hasher computes. */
    async hashMatrix(i) {
      const b = await bundle();
      const step = b.sessions[0].steps[i];
      const { commit } = step;
      const flow = b.flows[commit.newSession.flowHash];
      const from = i === 0 ? null : b.sessions[0].steps[i - 1].commit.newSession.version;
      const js = verify.expectedHashes(step.call, SESSION_ID, from, step.event, step.facts, step.ctx, flow);
      const rows = [
        ["flowHash", commit.audit.flowHash, js.flowHash],
        ["factsHash", commit.audit.factsHash, js.factsHash],
        ["decisionHash", commit.audit.decisionHash, js.decisionHash],
        ["transitionId", commit.audit.transitionId, js.transitionId],
        ["dedupKey", commit.dedupKey, js.dedupKey],
        ["resultHash", commit.audit.resultHash, verify.resultHashOf(commit)],
      ];
      return rows.map(([field, wasm, spec]) => ({ field, wasm, spec, match: wasm === spec }));
    },

    /** Both engines over the whole bundle: WASM replay and the pure-JS spec hashes. */
    async check() {
      return verify.verifyBundleWith(await bundle(), kernel);
    },

    bundle,

    async outbox() {
      const statuses = ["PENDING", "AWAIT_CONFIRMATION", "DISPATCHED", "FAILED_DLQ", "REJECTED"];
      const all = (await Promise.all(statuses.map((s) => host.getOutboxByStatus(s, 1000)))).flat();
      return all.sort((a, b) => a.createdAt - b.createdAt || a.outboxId.localeCompare(b.outboxId));
    },

    async confirmEffect(id) {
      await host.confirmEffect(id);
    },

    async rejectEffect(id) {
      await host.rejectEffect(id, "Rejected in the playground");
    },
  };
}
