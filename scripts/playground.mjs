// Builds the playground into target/playground/site: the page, plus the built dist
// folders of @mowaos/kernel, @mowaos/host-browser and @mowaos/verify. No bundler and no
// dependencies; the page resolves the packages with an import map.
//
//   npm run playground            # build and serve on http://127.0.0.1:8080
//   node scripts/playground.mjs --build-only
//   node scripts/playground.mjs --test   # build, then drive the page in headless Chrome
//
// Build the packages first: bash js-smoke/run.sh, then npm run build:kernel,
// build:host and build:verify (npm test does all of this).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(repo, "target", "playground", "site");
const args = new Set(process.argv.slice(2));

// ---- build -------------------------------------------------------------------------

const page = ["index.html", "style.css", "app.js", "engine.js", "link.js", "presets.js", "selftest.js", "og.png"];
const libs = {
  "lib/kernel/dist": "packages/kernel/dist",
  "lib/kernel/wasm": "packages/kernel/wasm",
  "lib/host-browser/dist": "packages/host-browser/dist",
  "lib/verify/dist": "packages/verify/dist",
};

for (const from of Object.values(libs)) {
  if (!existsSync(join(repo, from))) {
    console.error(`Missing ${from}. Build the packages first (see the top of this script).`);
    process.exit(1);
  }
}

rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
for (const f of page) cpSync(join(repo, "playground", f), join(site, f));
for (const f of ["LICENSE", "NOTICE"]) cpSync(join(repo, f), join(site, f));
// Only what runs: no source maps, type declarations or the Node-only entries' extras.
const keep = (src) => !/\.(map|d\.ts)$/.test(src) && !src.endsWith(".kernel-version");
for (const [to, from] of Object.entries(libs)) {
  cpSync(join(repo, from), join(site, to), { recursive: true, filter: keep });
}
console.log(`Built ${site}`);
if (args.has("--build-only")) process.exit(0);

// ---- serve -------------------------------------------------------------------------

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".cjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

let resolveResult;
const result = new Promise((r) => (resolveResult = r));
// What the test runner can report if the page never answers.
const served = new Set();
let progress = "none";

const server = createServer((req, res) => {
  if (args.has("--test") && req.method === "POST" && req.url === "/progress") {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      progress = body.slice(0, 300);
      res.writeHead(204).end();
    });
    return;
  }
  if (args.has("--test") && req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      res.writeHead(204).end();
      resolveResult(JSON.parse(body));
    });
    return;
  }
  served.add(new URL(req.url, "http://x").pathname);
  let path = normalize(join(site, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (path === site || path === site + sep) path = join(site, "index.html");
  try {
    if (!path.startsWith(site + sep)) throw new Error("outside the site");
    const data = readFileSync(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end();
  }
});

const port = args.has("--test") ? 0 : Number(process.env.PORT ?? 8080);
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

if (!args.has("--test")) {
  console.log(`Playground at ${url}  (Ctrl+C to stop)`);
} else {
  const bin =
    process.env.CHROME ??
    ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find(
      (c) => spawnSync("which", [c]).status === 0
    );
  if (!bin) {
    console.error("No Chrome found. Set CHROME=/path/to/chrome.");
    process.exit(1);
  }
  // Reuse one profile under target/: headless Chrome leaves helpers that block removal.
  const profile = join(repo, "target", "playground", "chrome-profile");
  mkdirSync(profile, { recursive: true });
  let chromeErr = "";
  let chrome;
  const launch = () => {
    chrome = spawn(
      bin,
      ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, `${url}?selftest`],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    chrome.stderr.on("data", (d) => (chromeErr = (chromeErr + d).slice(-2000)));
    chrome.once("exit", (code) => {
      if (code !== null && code !== 0) resolveResult({ ok: false, error: `Chrome exited with code ${code}` });
    });
  };
  launch();
  // Chrome occasionally fails to open the page on a cold CI runner: retry the launch once.
  const retry = setTimeout(() => {
    if (served.size > 0) return;
    console.error("Chrome did not request the page within 20 s; relaunching once.");
    chrome.removeAllListeners("exit");
    chrome.kill();
    launch();
  }, 20_000);
  const timer = setTimeout(() => resolveResult({ ok: false, error: "timed out after 120 s" }), 120_000);
  const out = await result;
  clearTimeout(timer);
  clearTimeout(retry);
  chrome.removeAllListeners("exit");
  if (chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await exited;
  }
  server.close();
  for (const line of out.log ?? []) console.log(`ok  ${line}`);
  if (!out.ok) {
    console.error(`Playground self-test failed: ${out.error}`);
    console.error(`  last step reported: ${progress}`);
    console.error(`  files served: ${served.size ? [...served].join(" ") : "none (the page never loaded)"}`);
    if (chromeErr.trim()) console.error(`  Chrome said:\n${chromeErr.trim()}`);
    process.exit(1);
  }
  console.log(`Playground self-test passed in headless Chrome (${out.kernel}).`);
}
