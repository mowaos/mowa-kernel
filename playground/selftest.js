// Loaded only with ?selftest (scripts/playground.mjs --test). Drives the real page
// through its controls: each preset's demo path, a tamper and its undo, and a rewind.
// Posts the result to /result for the test runner.
import { PRESETS } from "./presets.js";

const $ = (id) => document.getElementById(id);
const idle = () => window.__busy;

function set(el, value, type = "change") {
  el.value = value;
  el.dispatchEvent(new Event(type));
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function selftest() {
  const log = [];
  try {
    for (const preset of PRESETS) {
      set($("preset"), preset.key);
      await idle();
      for (const step of preset.demo) {
        for (const [name, status] of Object.entries(step.facts ?? {})) {
          set(document.querySelector(`[data-fact="${name}"]`), status);
        }
        set($("actor"), step.actor);
        await idle();
        const button = document.querySelector(`#events [data-event="${step.event}"]`);
        check(button, `${preset.key}: no button for ${step.event}`);
        button.click();
        await idle();
        const last = $("last").textContent;
        if (step.refused) check(last.includes(`Refused: ${step.refused}`), `${preset.key}: ${step.event} → ${last}`);
        else check(last.startsWith("Committed"), `${preset.key}: ${step.event} → ${last}`);
        check($("badge").textContent.startsWith("PASS"), `${preset.key}: badge ${$("badge").textContent}`);
      }
      const steps = Number($("scrub").max) + 1;

      // Tamper with step 1, see both the badge and the matrix turn, then undo.
      set($("scrub"), "1", "input");
      await idle();
      $("tamper").click();
      await idle();
      check($("badge").textContent.startsWith("HASH MISMATCH"), `${preset.key}: tamper not detected`);
      check(document.querySelector("#hashes tr.mismatch"), `${preset.key}: matrix shows no mismatch`);
      $("tamper").click();
      await idle();
      check($("badge").textContent.startsWith("PASS"), `${preset.key}: undo tamper`);

      // Rewind to step 1: history shrinks, still passes.
      $("rewind").click();
      await idle();
      check($("scrub").max === "1", `${preset.key}: rewind left ${$("scrub").max}`);
      check($("badge").textContent.startsWith("PASS · 2 steps"), `${preset.key}: after rewind ${$("badge").textContent}`);

      log.push(`${preset.key}: ${steps} steps, tamper caught, rewind ok`);
    }

    // The approval preset leaves its action waiting for a person.
    set($("preset"), "approval");
    await idle();
    for (const step of PRESETS.find((p) => p.key === "approval").demo) {
      for (const [name, status] of Object.entries(step.facts ?? {})) {
        set(document.querySelector(`[data-fact="${name}"]`), status);
      }
      set($("actor"), step.actor);
      await idle();
      document.querySelector(`#events [data-event="${step.event}"]`).click();
      await idle();
    }
    const confirm = document.querySelector("#outbox [data-confirm]");
    check(confirm, "approval: no effect awaiting confirmation");
    confirm.click();
    await idle();
    const action = [...document.querySelectorAll("#outbox li")].find((li) => li.textContent.includes("run_action"));
    check(action?.querySelector(".status.DISPATCHED"), "approval: confirm did not dispatch run_action");
    check(!document.querySelector("#outbox [data-confirm]"), "approval: still awaiting confirmation");
    log.push("approval: AWAIT_CONFIRMATION confirmed");

    await post({ ok: true, log, kernel: $("version").textContent });
  } catch (err) {
    await post({ ok: false, log, error: err.message });
  }
}

function post(body) {
  return fetch("/result", { method: "POST", body: JSON.stringify(body) });
}
