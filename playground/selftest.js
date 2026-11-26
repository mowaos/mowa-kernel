// Loaded only with ?selftest (scripts/playground.mjs --test). Drives the real page
// through its controls: each preset's demo path, a tamper and its undo, and a rewind.
// Posts the result to /result for the test runner.
import { PRESETS } from "./presets.js";

const $ = (id) => document.getElementById(id);
let stepName = "start";
// Every wait has its own deadline, so a stall names the step it happened in.
const idle = () =>
  Promise.race([
    window.__busy,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`stalled waiting at: ${stepName}`)), 20_000)),
  ]);
function progress(name) {
  stepName = name;
  fetch("/progress", { method: "POST", body: name }).catch(() => {});
}

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
    // A newcomer's path: only the guide's "Do it for me" button, start to finish.
    progress("guide walk");
    for (const preset of PRESETS) {
      progress(`guide walk: ${preset.key}`);
      set($("preset"), preset.key);
      await idle();
      if (!document.querySelector('[data-guide="do"]')) {
        $("guide").querySelector("button").click(); // "Show the guide" if it was hidden
        await idle();
      }
      for (let n = 0; n < preset.demo.length; n++) {
        const doIt = document.querySelector('[data-guide="do"]');
        check(doIt, `${preset.key}: guide stopped at step ${n + 1}: ${$("guide").textContent}`);
        doIt.click();
        await idle();
        check($("guide").textContent.includes(preset.demo[n].after), `${preset.key}: guide step ${n + 1} not explained`);
      }
      check($("guide").textContent.includes("That's the whole path"), `${preset.key}: no finale`);
      check($("badge").textContent.startsWith("PASS"), `${preset.key}: guide run ${$("badge").textContent}`);
    }
    log.push("guide: every preset walked with Do it for me");

    progress("off-path");
    // Going off the path is detected.
    set($("preset"), "coffee");
    await idle();
    set($("actor"), "TECHNICIAN");
    await idle();
    document.querySelector('#events [data-event="INSERT_COIN"]').click();
    await idle();
    check($("guide").textContent.includes("left the guided path"), "off-path not detected");
    log.push("guide: off-path detected");

    for (const preset of PRESETS) {
      set($("preset"), preset.key);
      await idle();
      for (const step of preset.demo) {
        progress(`${preset.key}: ${step.event} as ${step.actor}`);
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
      progress(`${preset.key}: tamper and rewind`);
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

    progress("approval: confirm");
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

    progress("replay link");
    // The address bar is a replay link: open another preset, then come back through it.
    const link = location.hash;
    const final = $("final-hash").textContent;
    const steps = $("scrub").max;
    check(link.startsWith("#r="), `address is not a replay link: ${link}`);
    await navigate("#guardrail");
    check($("preset").value === "guardrail", "#guardrail did not open the preset");
    await navigate(link);
    check($("preset").value === "approval", "link did not reopen its preset");
    check($("scrub").max === steps, `link replayed ${$("scrub").max} steps, not ${steps}`);
    check($("final-hash").textContent === final, "link replayed to a different final resultHash");
    check($("badge").textContent.startsWith("PASS"), `link replay: ${$("badge").textContent}`);
    check($("guide").textContent.includes("shared run"), "shared run not announced");
    log.push(`replay link (${link.length} chars): same steps, same final resultHash`);

    await navigate("#r=not-a-real-link");
    check($("last").textContent.includes("could not be read"), "bad link not reported");
    check($("badge").textContent.startsWith("PASS"), "bad link left the page broken");
    log.push("bad replay link rejected cleanly");

    await post({ ok: true, log, kernel: $("version").textContent });
  } catch (err) {
    await post({ ok: false, log, error: err.message });
  }
}

// Changing the hash fires hashchange, which queues the page's work; wait for both.
async function navigate(hash) {
  const changed = new Promise((r) => window.addEventListener("hashchange", r, { once: true }));
  location.hash = hash;
  await changed;
  await idle();
}

function post(body) {
  return fetch("/result", { method: "POST", body: JSON.stringify(body) });
}
