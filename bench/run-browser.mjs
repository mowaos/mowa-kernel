// Browser benchmark: serves the repo locally with cross-origin isolation (so
// performance.now() has 5 µs resolution), opens bench/browser.html in headless
// Chrome, and waits for the page to post its results. Real time, not virtual time.
//
//   npm run bench:browser                      # finds google-chrome / chromium
//   CHROME=/path/to/chrome npm run bench:browser
//   npm run bench:browser -- --serve           # serve only; open the URL yourself
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { formatTable } from "./core.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serveOnly = process.argv.includes("--serve");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

let resolveResult;
const result = new Promise((r) => (resolveResult = r));

const server = createServer((req, res) => {
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      res.writeHead(204, headers).end();
      resolveResult(JSON.parse(body));
    });
    return;
  }
  // Serve only the files the page needs, from inside the repo.
  const path = normalize(join(repo, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  const allowed = ["bench", "packages/kernel/dist", "packages/kernel/wasm", "packages/host-browser/dist"].some((d) =>
    path.startsWith(join(repo, d) + sep)
  );
  try {
    if (!allowed) throw new Error("not served");
    const data = readFileSync(path);
    res.writeHead(200, { ...headers, "content-type": types[extname(path)] ?? "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404, headers).end();
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/bench/browser.html`;

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    if (spawnSync("which", [c]).status === 0) return c;
  }
  return null;
}

let chrome;
if (serveOnly) {
  console.log(`Open ${url} in a browser; results print here.`);
} else {
  const bin = findChrome();
  if (!bin) {
    console.error("No Chrome found. Set CHROME=/path/to/chrome, or use --serve and open the page yourself.");
    process.exit(1);
  }
  // Headless Chrome leaves helper processes behind, so a temporary profile cannot be
  // removed reliably. Reuse one under target/ (ignored by git) instead.
  const profile = resolve(repo, "target", "bench", "chrome-profile");
  mkdirSync(profile, { recursive: true });
  chrome = spawn(bin, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
}

const timer = setTimeout(() => resolveResult({ error: "timed out after 5 minutes" }), 300_000);
const out = await result;
clearTimeout(timer);
if (chrome && chrome.exitCode === null) {
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await exited;
}
server.close();

if (out.error) {
  console.error(`Browser benchmark failed: ${out.error}`);
  process.exit(1);
}
mkdirSync(resolve(repo, "target", "bench"), { recursive: true });
writeFileSync(resolve(repo, "target", "bench", "browser.json"), JSON.stringify(out, null, 2));
console.log(`${out.env.runtime}\ncrossOriginIsolated: ${out.env.crossOriginIsolated} · kernel ${out.env.kernelVersion}\n`);
console.log(formatTable(out.rows));
