// Replay links: a run's inputs in the URL (#r=…), so anyone can open it and get the
// same session, with the same hashes, in their own browser. A link is a recipe, not a
// proof: the page replays it on the kernel, and the bundle download is the proof.
//
// Format (version 1): base64url(deflate-raw(JSON))
//   { v: 1, p: presetKey, s: [[event, actor, [factStatus…]], …], t?: tamperStep, a?: selectedStep }
// Every attempt is kept, refused ones included, so the replay tells the whole story.
// Fact statuses are listed in the flow's declaredFacts key order.

const MAX_ATTEMPTS = 200;
const MAX_JSON_BYTES = 64 * 1024;
const NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

export class LinkError extends Error {
  constructor(message) {
    super(message);
    this.name = "LinkError";
  }
}

function toBase64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new LinkError("not base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function pipe(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new LinkError("link too large");
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

/** `{ preset, attempts: [{event, actor, facts}], tamper, at }` → link fragment (no "#r="). */
export async function encodeLink({ preset, attempts, tamper = null, at = null }) {
  const names = Object.keys(preset.flow.declaredFacts);
  const data = {
    v: 1,
    p: preset.key,
    s: attempts.map((x) => [x.event, x.actor, names.map((n) => x.facts[n])]),
  };
  if (tamper !== null) data.t = tamper;
  if (at !== null) data.a = at;
  const json = new TextEncoder().encode(JSON.stringify(data));
  return toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

/** Link fragment → `{ preset, attempts, tamper, at }`. Throws LinkError on anything unexpected. */
export async function decodeLink(fragment, presets) {
  let data;
  try {
    const json = await pipe(fromBase64Url(fragment), new DecompressionStream("deflate-raw"), MAX_JSON_BYTES);
    data = JSON.parse(new TextDecoder().decode(json));
  } catch (err) {
    throw err instanceof LinkError ? err : new LinkError("unreadable link");
  }
  if (!data || typeof data !== "object" || data.v !== 1) throw new LinkError("unknown link version");
  const preset = presets.find((p) => p.key === data.p);
  if (!preset) throw new LinkError("unknown preset");
  if (!Array.isArray(data.s) || data.s.length > MAX_ATTEMPTS) throw new LinkError("bad steps");

  const declared = Object.entries(preset.flow.declaredFacts);
  const attempts = data.s.map((x) => {
    if (!Array.isArray(x) || x.length !== 3) throw new LinkError("bad step");
    const [event, actor, statuses] = x;
    if (typeof event !== "string" || !NAME.test(event)) throw new LinkError("bad event");
    if (!preset.actors.includes(actor)) throw new LinkError("bad actor");
    if (!Array.isArray(statuses) || statuses.length !== declared.length) throw new LinkError("bad facts");
    const facts = {};
    declared.forEach(([name, allowed], i) => {
      if (!allowed.includes(statuses[i])) throw new LinkError("bad fact status");
      facts[name] = statuses[i];
    });
    return { event, actor, facts };
  });

  const index = (v) => (v === undefined ? null : Number.isInteger(v) && v >= 0 && v <= MAX_ATTEMPTS ? v : NaN);
  const tamper = index(data.t);
  const at = index(data.a);
  if (Number.isNaN(tamper) || Number.isNaN(at)) throw new LinkError("bad step index");
  return { preset, attempts, tamper, at };
}
