# Benchmarks

How fast the kernel decides, measured the same way in native Rust, Node and a real
browser, on the same requests. Run it yourself; your hardware will give different
numbers.

## Run it

From the repo root, after `npm test` (which builds the kernel and the packages):

```bash
npm run bench           # Node, then native Rust (writes target/bench/*.json)
npm run bench:browser   # headless Chrome; or add -- --serve and open the URL yourself
```

## What is measured

The inputs come from [`bench/fixtures.mjs`](../bench/fixtures.mjs): a chain flow with
3, 50 or 200 nodes, where every step is guarded by one declared fact, and each node
emits one effect. Every runtime times identical request strings.

| Scenario | What one call covers |
| --- | --- |
| `advance · handle · kernel only` | One `advanceJson` call with a cached flow handle (`loadFlowJson` once, then pass the handle). This is the normal way to run a flow. |
| `advance · handle · with JSON round-trip` | The same, plus `JSON.stringify` of the request and `JSON.parse` of the reply, as a JavaScript host does. |
| `advance · full flow · kernel only` | `advanceJson` with the whole flow in the request, so it is parsed, validated and hashed every time. |
| `start · handle · kernel only` | One `startJson` call with a handle. |
| `host advanceSession (in-memory storage)` | One step through `@mowaos/host-browser`: input checks, the dedup check, the kernel call, the step record and the outbox, with in-memory storage and lock. |

**Method.** 20 warm-up batches, then 60 timed batches of 100 calls. Each figure is
the per-call mean of a batch; the tables show the median batch and the 95th
percentile. Batches are used because browsers make `performance.now()` coarse; the
browser runner serves the page with cross-origin isolation, so the timer has 5 µs
resolution there. Timing uses real time, not virtual time.

## Results: kernel 0.5.0

Measured 2026-11-25 on one machine: Intel Core i7-6700HQ (2015 laptop CPU, 2.6 GHz),
Linux 6.8. Node 22.22.2; Google Chrome 158 (headless); native Rust from
`--release`. WASM binary sha256 `99b4e2bb…e979`, the v0.5.0 release asset.

Median µs per call (p95 in brackets):

| Scenario | Flow nodes | Native Rust | Node (WASM) | Chrome (WASM) |
| --- | ---: | ---: | ---: | ---: |
| advance · handle · kernel only | 3 | 62 (75) | 119 (145) | 111 (128) |
| advance · handle · with JSON round-trip | 3 | | 136 (155) | 113 (132) |
| advance · full flow · kernel only | 3 | 111 (131) | 214 (280) | 203 (231) |
| start · handle · kernel only | 3 | 56 (75) | 102 (130) | 87 (113) |
| advance · handle · kernel only | 50 | 134 (167) | 175 (197) | 155 (195) |
| advance · full flow · kernel only | 50 | 834 (910) | 1370 (1462) | 1335 (1488) |
| advance · handle · kernel only | 200 | 306 (342) | 356 (430) | 298 (347) |
| advance · full flow · kernel only | 200 | 3228 (3748) | 5243 (5854) | 4564 (5211) |
| host advanceSession (in-memory storage) | 3 | | 595 (753) | 394 (see note) |

What this shows:

- **About 110–120 µs per decision in WASM** for a small flow with a handle, and about
  60 µs native, on a 2015 laptop CPU.
- **A full host step is about 0.4–0.6 ms**, including the host's own checks and
  storage.
- **Use a flow handle.** Sending the whole flow with every call costs 2× for a small
  flow and over 10× for a large one.
- **In 0.5.0, calls with a handle still grow with flow size.** The kernel copies the
  cached flow on each call. Holding the cached flow behind a shared pointer removes
  that cost. A test build measured `advance` with a handle at about 54 µs native for
  3, 50 and 200 nodes alike. This needs a kernel release, which changes `kernelVersion`.

Note on the browser host row: its p95 was 57 ms, against a 394 µs median. A few
batches stalled, most likely during garbage collection as thousands of benchmark
sessions accumulated in memory. The median is the meaningful figure.
