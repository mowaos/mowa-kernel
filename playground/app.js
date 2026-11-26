// Playground page: wires the engine (engine.js) to the DOM. Everything runs locally:
// the kernel is WebAssembly, storage is in memory, and the verifier is the same code
// as `npx @mowaos/verify`.
import { loadKernel } from "@mowaos/kernel";
import * as host from "@mowaos/host-browser";
import * as verify from "@mowaos/verify";

import { createEngine } from "./engine.js";
import { decodeLink, encodeLink } from "./link.js";
import { FINALE, PRESETS } from "./presets.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

// Build elements with textContent only, never innerHTML.
function h(tag, attrs = {}, ...children) {
  const el = tag.startsWith("svg:") ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : String(c));
  return el;
}

const kernel = await loadKernel();
let engine;
let sel = 0; // selected step
let follow = true; // keep the newest step selected
let shareUrl = location.href;
let lastReport = null;

// Every action runs in order, one at a time; window.__busy lets the self-test wait.
let busy = Promise.resolve();
function run(fn) {
  busy = busy.then(fn).then(render).catch((err) => {
    $("last").textContent = `Error: ${err.message}`;
    $("last").style.color = "var(--bad)";
  });
  window.__busy = busy;
  return busy;
}

async function act(event, actor) {
  follow = true;
  const facts = { ...engine.facts };
  const r = await engine.fire(event, actor);
  $("last").style.color = "";
  $("last").textContent = r.ok
    ? `Committed in ${engine.lastMs.toFixed(2)} ms (kernel decision and host storage).`
    : `Refused: ${r.code}. Nothing was committed.`;
  guideAfterFire(event, actor, facts, r);
}

async function loadPreset(key) {
  const preset = PRESETS.find((p) => p.key === key);
  guide.i = 0;
  guide.off = false;
  guide.shared = false;
  guide.after = "";
  engine = await createEngine({ host, verify, kernel, preset });
  $("preset").value = key;
  sel = 0;
  follow = true;
  $("blurb").textContent = preset.blurb;
  $("actor").replaceChildren(...preset.actors.map((a) => h("option", { value: a }, a)));
  $("actor").value = preset.demo[0]?.actor ?? preset.actors[0];
  $("facts").replaceChildren(
    ...Object.entries(preset.flow.declaredFacts).map(([name, statuses]) =>
      h("label", {}, name,
        h("select", {
          "data-fact": name,
          onchange: (e) => (engine.facts[name] = e.target.value),
        }, statuses.map((s) => h("option", { value: s, selected: engine.facts[name] === s }, s))))
    )
  );
}

// ---- graph -------------------------------------------------------------------------

function layout(flow) {
  const depth = { [flow.startNode]: 0 };
  const order = [flow.startNode];
  for (let i = 0; i < order.length; i++) {
    const node = flow.nodes[order[i]];
    for (const t of Object.values(node.transitions ?? {})) {
      for (const next of [t.to, t.onGuardFail]) {
        if (next && !(next in depth)) {
          depth[next] = depth[order[i]] + 1;
          order.push(next);
        }
      }
    }
  }
  const rows = {};
  const pos = {};
  for (const id of order) {
    const d = depth[id];
    rows[d] = (rows[d] ?? 0) + 1;
    pos[id] = { x: 20 + d * 270, y: 30 + (rows[d] - 1) * 84, d };
  }
  return pos;
}

const W = 140;
const H = 34;

function drawGraph(flow, state, audit) {
  const pos = layout(flow);
  const svg = $("graph");
  const edges = [];
  for (const [from, node] of Object.entries(flow.nodes)) {
    for (const [event, t] of Object.entries(node.transitions ?? {})) {
      edges.push({ from, to: t.to, event, fail: false });
      if (t.onGuardFail) edges.push({ from, to: t.onGuardFail, event: `${event} ✗`, fail: true });
    }
  }
  const maxY = Math.max(...Object.values(pos).map((p) => p.y)) + H;
  let back = 0;
  const arcs = [];
  const parts = edges.map((e) => {
    const a = pos[e.from];
    const b = pos[e.to];
    let d;
    let mid;
    if (b.d > a.d) {
      const p0 = [a.x + W, a.y + H / 2];
      const p3 = [b.x, b.y + H / 2];
      const c1 = [p0[0] + 50, p0[1]];
      const c2 = [p3[0] - 50, p3[1]];
      d = `M${p0} C${c1} ${c2} ${p3}`;
      mid = [(p0[0] + 3 * c1[0] + 3 * c2[0] + p3[0]) / 8, (p0[1] + 3 * c1[1] + 3 * c2[1] + p3[1]) / 8 - 6];
    } else {
      // Backward or sideways: an arc under every node it spans, deeper the further it
      // reaches.
      const p0 = [a.x + W / 2 + 14, a.y + H];
      const p3 = [b.x + W / 2 - 14, b.y + H];
      const [lo, hi] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const floor = Math.max(...Object.values(pos).filter((p) => p.x >= lo && p.x <= hi).map((p) => p.y));
      let y = floor + H + 24 + (hi - lo) * 0.13;
      // Keep overlapping arcs (and their labels) apart.
      while (arcs.some((r) => r.lo < hi + W && lo < r.hi + W && Math.abs(r.y - y) < 18)) y += 18;
      arcs.push({ lo, hi, y });
      back = Math.max(back, y);
      d = `M${p0} C${p0[0]},${y} ${p3[0]},${y} ${p3}`;
      mid = [(p0[0] + p3[0]) / 2, (p0[1] + 6 * y + p3[1]) / 8 + 12];
    }
    const taken =
      audit && audit.fromState === e.from && audit.toState === e.to && audit.guardFailed === e.fail &&
      e.event.split(" ")[0] === audit.eventType;
    return h("svg:g", { class: `edge${e.fail ? " fail" : ""}${taken ? " taken" : ""}` },
      h("svg:path", { d, "marker-end": "url(#arrow)" }),
      h("svg:text", { x: mid[0], y: mid[1], "text-anchor": "middle" }, e.event));
  });
  const nodes = Object.entries(pos).map(([id, p]) => {
    const node = flow.nodes[id];
    return h("svg:g", { class: `node${id === state ? " now" : ""}${node.terminal ? " terminal" : ""}` },
      h("svg:rect", { x: p.x, y: p.y, width: W, height: H, rx: 8 }),
      h("svg:text", { x: p.x + W / 2, y: p.y + H / 2 + 4, "text-anchor": "middle" }, id));
  });
  const width = Math.max(...Object.values(pos).map((p) => p.x)) + W + 20;
  const height = Math.max(maxY + 20, back + 10);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.replaceChildren(
    h("svg:defs", {}, h("svg:marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" },
      h("svg:path", { d: "M0,0 L10,5 L0,10 z" }))),
    ...parts,
    ...nodes
  );
  // On narrow screens the graph scrolls; keep the current state in view.
  const wrap = svg.parentElement;
  if (pos[state] && wrap.scrollWidth > wrap.clientWidth) {
    wrap.scrollLeft = pos[state].x + W / 2 - wrap.clientWidth / 2;
  }
}

// ---- render ------------------------------------------------------------------------

const short = (s) => (typeof s === "string" && s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : String(s));

async function render() {
  const steps = await engine.steps();
  const last = steps.length - 1;
  if (follow || sel > last) sel = last;
  const step = steps[sel];
  const { audit, newSession } = step.commit;
  const flow = engine.preset.flow;

  drawGraph(flow, newSession.state, sel > 0 ? audit : null);

  // Time travel
  $("scrub").max = String(last);
  $("scrub").value = String(sel);
  $("step-label").textContent =
    `Step ${sel} of ${last}: ${audit.eventType} by ${audit.actor.type} → ${audit.toState}` +
    (audit.guardFailed ? " (guard failed)" : "");
  $("rewind").disabled = sel === last;
  $("tamper").textContent = engine.tamperAt === sel ? "Undo tampering" : "Tamper with this step";
  $("tamper").disabled = engine.tamperAt !== null && engine.tamperAt !== sel;

  // Act
  const atEnd = sel === last;
  const actor = $("actor").value;
  const available = await engine.available();
  const terminal = flow.nodes[newSession.state].terminal;
  $("events").replaceChildren(
    ...(terminal && atEnd ? [h("p", { class: "muted" }, "The session has ended. Rewind to try another path.")] : []),
    ...available.map((t) =>
      h("button", {
        type: "button",
        "data-event": t.event,
        class: t.allowedActors.includes(actor) ? false : "not-allowed",
        disabled: !atEnd,
        title: atEnd ? false : "Rewind to this step to act from here",
        onclick: () => run(() => act(t.event, $("actor").value)),
      }, t.event, h("span", { class: "hint" }, `→ ${t.to} · ${t.allowedActors.join(", ")}`))
    )
  );
  $("refusals").replaceChildren(
    ...engine.refusals.slice(-4).reverse().map((r) => h("li", {}, `${r.event} by ${r.actor}: ${r.code}`))
  );

  // Hash audit for the selected step, then both engines over the whole bundle
  const rows = await engine.hashMatrix(sel);
  $("hashes").tBodies[0].replaceChildren(
    ...rows.map((r) =>
      h("tr", { class: r.match ? false : "mismatch" },
        h("td", {}, r.field),
        h("td", { title: r.wasm }, short(r.wasm)),
        h("td", { title: r.spec }, short(r.spec)),
        h("td", { class: r.match ? "ok" : "bad" }, r.match ? "✓" : "✗"))
    )
  );
  const report = await engine.check();
  const badge = $("badge");
  badge.className = `badge ${report.ok ? "pass" : "fail"}`;
  badge.textContent = report.ok
    ? `PASS · ${report.totalStepsVerified} step${report.totalStepsVerified === 1 ? "" : "s"} · 2 engines`
    : `HASH MISMATCH · ${report.errors.length} errors`;
  $("errors").replaceChildren(
    ...report.errors.slice(0, 6).map((e) => h("li", {}, `step ${e.stepIndex ?? "?"}: ${e.message}`))
  );
  lastReport = report;
  $("explain").hidden = report.ok;
  $("explain").textContent = explain(rows, report);
  $("final-hash").textContent = steps[last].commit.audit.resultHash;
  for (const el of document.querySelectorAll("[data-fact]")) el.value = engine.facts[el.dataset.fact];

  // Outbox
  const stepOf = new Map(steps.map((s, i) => [s.commit.audit.transitionId, i]));
  const records = await engine.outbox();
  $("outbox").replaceChildren(
    ...(records.length === 0 ? [h("li", { class: "muted" }, "No effects yet.")] : []),
    ...records.map((r) =>
      h("li", {},
        h("span", { class: "muted" }, `step ${stepOf.get(r.transitionId) ?? "?"}`),
        h("strong", {}, r.effect.kind),
        h("span", { class: "muted" }, JSON.stringify(r.effect.payload)),
        h("span", { class: `status ${r.status}` }, r.status),
        ...(r.status === "AWAIT_CONFIRMATION"
          ? [
              h("button", { type: "button", "data-confirm": r.outboxId, onclick: () => run(() => engine.confirmEffect(r.outboxId)) }, "Confirm"),
              h("button", { type: "button", class: "ghost", onclick: () => run(() => engine.rejectEffect(r.outboxId)) }, "Reject"),
            ]
          : []))
    )
  );
  renderGuide();
  await syncUrl();
}

// What the hash table means when something does not match.
function explain(rows, report) {
  if (report.ok) return "";
  const broken = rows.filter((r) => !r.match).map((r) => r.field);
  if (broken.includes("resultHash")) {
    return "This step's recorded output was changed after it was written: its resultHash no longer matches its contents.";
  }
  if (broken.length > 0) {
    return `The recorded outputs are untouched, but the recorded inputs no longer produce them (${broken.join(", ")}). An input was edited after the decision was made, and replay on the kernel disagrees too.`;
  }
  const first = report.errors.find((e) => Number.isInteger(e.stepIndex));
  return first
    ? `This step's own hashes match. The history breaks at step ${first.stepIndex}; everything after it no longer replays.`
    : "The bundle does not verify; see the errors below.";
}

// Keep the address bar a replay link for the current run.
async function syncUrl() {
  const fresh = engine.attempts.length === 0 && engine.tamperAt === null;
  const fragment = fresh
    ? engine.preset.key
    : `r=${await encodeLink({ preset: engine.preset, attempts: engine.attempts, tamper: engine.tamperAt, at: follow ? null : sel })}`;
  shareUrl = `${location.origin}${location.pathname}#${fragment}`;
  history.replaceState(null, "", `${location.pathname}${location.search}#${fragment}`);
}

// Open whatever the address asks for: a replay link (#r=…), a preset (#guardrail or
// ?preset=guardrail), or the first preset.
async function openFromLocation() {
  const hash = location.hash.slice(1);
  if (hash.startsWith("r=")) {
    try {
      const link = await decodeLink(hash.slice(2), PRESETS);
      await loadPreset(link.preset.key);
      await engine.replay(link.attempts);
      if (link.tamper !== null && link.tamper < engine.stepCount) engine.setTamper(link.tamper);
      if (link.at !== null && link.at < engine.stepCount - 1) {
        sel = link.at;
        follow = false;
      }
      $("last").textContent = "";
      guide.shared = true;
      return;
    } catch (err) {
      $("last").style.color = "var(--bad)";
      $("last").textContent = `This replay link could not be read (${err.message}). Showing a fresh preset instead.`;
    }
  }
  const wanted = [hash, new URLSearchParams(location.search).get("preset")];
  await loadPreset(wanted.find((k) => PRESETS.some((p) => p.key === k)) ?? PRESETS[0].key);
}

async function copy(text, what) {
  const fallback = $("share-fallback");
  try {
    await navigator.clipboard.writeText(text);
    fallback.hidden = true;
    $("share-note").textContent = `${what} copied to the clipboard.`;
  } catch {
    fallback.value = text;
    fallback.hidden = false;
    fallback.select();
    $("share-note").textContent = `Copy the ${what.toLowerCase()} below.`;
  }
}

function receipt() {
  const n = lastReport?.totalStepsVerified ?? engine.stepCount;
  const verdict = lastReport?.ok ? "PASS (WASM replay and pure-JS spec hashes)" : "HASH MISMATCH";
  return [
    `MO·WA OS Playground · ${engine.preset.title}`,
    `${n} step${n === 1 ? "" : "s"} · ${verdict}`,
    `Final resultHash ${$("final-hash").textContent}`,
    `Replay it: ${shareUrl}`,
  ].join("\n");
}

// ---- guide -------------------------------------------------------------------------
// Walks a newcomer through the preset's demo path, one step at a time. It follows what
// they actually do: any step that differs from the path (event, actor, facts or outcome)
// leaves the guide, which then offers a restart.

const GUIDE_OFF_KEY = "mowa-playground-guide-off";
const guide = { on: true, i: 0, off: false, shared: false, after: "" };
try {
  guide.on = localStorage.getItem(GUIDE_OFF_KEY) !== "1";
} catch {
  // Storage can be unavailable (private windows, blocked site data); keep the default.
}

function rememberGuide(on) {
  guide.on = on;
  try {
    if (on) localStorage.removeItem(GUIDE_OFF_KEY);
    else localStorage.setItem(GUIDE_OFF_KEY, "1");
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}

// Facts the path expects when step i fires: the preset's initial facts plus every
// change made by steps up to and including i.
function pathFacts(i) {
  const facts = { ...engine.preset.initialFacts };
  for (const s of engine.preset.demo.slice(0, i + 1)) Object.assign(facts, s.facts ?? {});
  return facts;
}

function guideAfterFire(event, actor, facts, r) {
  const step = engine.preset.demo[guide.i];
  if (guide.shared || guide.off || !step) return;
  const want = pathFacts(guide.i);
  const sameFacts = Object.keys(want).every((k) => want[k] === facts[k]);
  const sameOutcome = step.refused ? !r.ok && r.code === step.refused : r.ok;
  if (step.event === event && step.actor === actor && sameFacts && sameOutcome) {
    guide.after = step.after;
    guide.i += 1;
  } else {
    guide.off = true;
  }
}

async function doGuideStep() {
  const step = engine.preset.demo[guide.i];
  Object.assign(engine.facts, step.facts ?? {});
  $("actor").value = step.actor;
  await act(step.event, step.actor);
}

function restartGuide() {
  rememberGuide(true);
  return loadPreset(engine.preset.key);
}

function renderGuide() {
  const box = $("guide");
  const demo = engine.preset.demo;
  const button = (label, onclick, ghost) =>
    h("button", { type: "button", class: ghost ? "ghost" : false, onclick: () => run(onclick) }, label);
  let content = [];
  if (guide.shared) {
    content = [
      h("p", {}, `You're viewing a shared run: ${engine.stepCount} steps, replayed here in your browser. The hashes were computed on your machine, not copied from the link.`),
      h("div", { class: "row" }, button("Start this preset from scratch with the guide", restartGuide, true)),
    ];
  } else if (!guide.on) {
    content = [h("div", { class: "row" }, button("Show the guide (restarts this preset)", restartGuide, true))];
  } else if (guide.off) {
    content = [
      h("p", {}, "You've left the guided path. Explore freely: you can't break anything."),
      h("div", { class: "row" },
        button("Restart the guide", restartGuide),
        button("Hide the guide", () => rememberGuide(false), true)),
    ];
  } else if (guide.i < demo.length) {
    const step = demo[guide.i];
    content = [
      guide.after ? h("p", { class: "after" }, guide.after) : null,
      h("p", { class: "next" }, h("span", { class: "count" }, `Step ${guide.i + 1} of ${demo.length}: `), step.say),
      h("div", { class: "row" },
        h("button", { type: "button", "data-guide": "do", onclick: () => run(doGuideStep) }, "Do it for me"),
        button("Skip the guide", () => rememberGuide(false), true)),
    ];
  } else {
    content = [
      h("p", { class: "after" }, guide.after),
      h("p", { class: "next" }, FINALE),
      h("div", { class: "row" },
        button("Restart the guide", restartGuide, true),
        button("Hide the guide", () => rememberGuide(false), true)),
    ];
  }
  box.replaceChildren(...content.filter(Boolean));
}

// ---- wiring ------------------------------------------------------------------------

for (const btn of document.querySelectorAll(".help-btn")) {
  btn.addEventListener("click", () => {
    const panel = $(btn.getAttribute("aria-controls"));
    panel.hidden = !panel.hidden;
    btn.setAttribute("aria-expanded", String(!panel.hidden));
  });
}

$("preset").replaceChildren(...PRESETS.map((p) => h("option", { value: p.key }, p.title)));
$("preset").addEventListener("change", (e) => run(() => loadPreset(e.target.value)));
window.addEventListener("hashchange", () => run(openFromLocation));
$("copy-link").addEventListener("click", () => run(() => copy(shareUrl, "Replay link")));
$("copy-receipt").addEventListener("click", () => run(() => copy(receipt(), "Receipt")));
$("actor").addEventListener("change", () => run(() => {}));
$("scrub").addEventListener("input", (e) =>
  run(async () => {
    sel = Number(e.target.value);
    follow = sel === engine.stepCount - 1;
  })
);
$("rewind").addEventListener("click", () =>
  run(async () => {
    await engine.rewind(sel);
    follow = true;
    guide.off = true;
    $("last").style.color = "";
    $("last").textContent = `Rewound to step ${sel}. Replayed on a fresh host with identical hashes.`;
  })
);
$("tamper").addEventListener("click", () =>
  run(async () => engine.setTamper(engine.tamperAt === sel ? null : sel))
);
$("export").addEventListener("click", () =>
  run(async () => {
    const bundle = await engine.bundle();
    const blob = new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `mowa-${engine.preset.key}-bundle.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  })
);
$("version").textContent = `Kernel ${kernel.kernelVersion()}`;

await run(openFromLocation);

if (new URLSearchParams(location.search).has("selftest")) {
  const { selftest } = await import("./selftest.js");
  selftest();
}
