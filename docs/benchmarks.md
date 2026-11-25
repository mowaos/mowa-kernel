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

## Results

Measured 2026-11-25 on one machine: Intel Core i7-6700HQ (2015 laptop CPU, 2.6 GHz),
Linux 6.8. Node 22.22.2; Google Chrome 158 (headless, cross-origin isolated); native
Rust from `--release`.

### Kernel 0.5.1

WASM binary sha256 `c73aaf17…6d2b`. Median µs per call (p95 in brackets):

| Scenario | Flow nodes | Native Rust | Node (WASM) | Chrome (WASM) |
| --- | ---: | ---: | ---: | ---: |
| advance · handle · kernel only | 3 | 40 (61) | 71 (80) | 68 (91) |
| advance · handle · with JSON round-trip | 3 | | 88 (102) | 69 (79) |
| advance · full flow · kernel only | 3 | 85 (102) | 138 (161) | 121 (146) |
| start · handle · kernel only | 3 | 42 (66) | 64 (81) | 54 (60) |
| advance · handle · kernel only | 50 | 43 (51) | 68 (82) | 59 (69) |
| advance · full flow · kernel only | 50 | 702 (765) | 848 (960) | 771 (837) |
| advance · handle · kernel only | 200 | 45 (53) | 67 (94) | 62 (67) |
| advance · full flow · kernel only | 200 | 2471 (2626) | 3158 (3497) | 2820 (3001) |
| host advanceSession (in-memory storage) | 3 | | 419 (558) | 329 (459) |

What this shows:

- **About 60–70 µs per decision in WASM** (Node and Chrome) and about 40 µs native,
  on a 2015 laptop CPU.
- **Flow size does not matter when you use a handle:** 3, 50 and 200 nodes cost the
  same.
- **A full host step is about 0.3–0.4 ms**, including the host's own checks and
  storage.
- **Use a flow handle.** Sending the whole flow with every call costs 2× for a small
  flow and over 40× for a 200-node one, because it is parsed, validated and hashed
  each time.

### Kernel 0.5.0, for comparison

WASM binary sha256 `99b4e2bb…e979`. Median µs per call:

| Scenario | Flow nodes | Native Rust | Node (WASM) | Chrome (WASM) |
| --- | ---: | ---: | ---: | ---: |
| advance · handle · kernel only | 3 | 62 | 119 | 111 |
| advance · handle · kernel only | 50 | 134 | 175 | 155 |
| advance · handle · kernel only | 200 | 306 | 356 | 298 |
| advance · full flow · kernel only | 200 | 3228 | 5243 | 4564 |
| host advanceSession (in-memory storage) | 3 | | 595 | 394 |

Two changes in 0.5.1 account for the difference:

- **Cached flows are shared, not copied.** In 0.5.0, every call with a handle copied
  the whole cached flow, so cost grew with flow size.
- **The release build is optimised for speed** (`opt-level = 3`, was `"s"`). In WASM
  that measured 41% faster. Against the 0.5.0 binary, the 0.5.1 one is 8% smaller
  raw and 4% larger gzipped (182 kB).

Note on outliers: in one 0.5.0 browser run the host row's p95 reached 57 ms against a
394 µs median. A few batches stalled, most likely during garbage collection as
thousands of benchmark sessions built up in memory. Medians are the meaningful
figures.
