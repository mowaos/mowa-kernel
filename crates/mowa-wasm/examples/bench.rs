//! Native benchmark of the kernel's JSON boundary, on the same requests the Node and
//! browser benchmarks use. Generate the fixtures first, then run:
//!
//! ```text
//! node bench/run-node.mjs
//! cargo run --release -p mowa-wasm --example bench -- target/bench/fixtures.json
//! ```
//!
//! Method (same as bench/core.mjs): 20 warm-up batches, then 60 timed batches of 100
//! calls; reports the median and p95 of the per-call mean of each batch.

// A benchmark has to read the clock and do float maths, which the kernel itself is
// forbidden to do. This example is a separate program, never part of the kernel.
#![allow(
    clippy::disallowed_methods,
    clippy::float_arithmetic,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::type_complexity
)]

use std::time::Instant;

use mowa_wasm::{advance_json_impl, load_flow_json_impl, start_json_impl};
use serde_json::Value;

const WARMUP_BATCHES: usize = 20;
const BATCHES: usize = 60;
const BATCH_SIZE: usize = 100;

fn measure(mut f: impl FnMut() -> String) -> (f64, f64) {
    for _ in 0..WARMUP_BATCHES * BATCH_SIZE {
        std::hint::black_box(f());
    }
    let mut per_call: Vec<f64> = (0..BATCHES)
        .map(|_| {
            let t0 = Instant::now();
            for _ in 0..BATCH_SIZE {
                std::hint::black_box(f());
            }
            t0.elapsed().as_secs_f64() * 1e6 / BATCH_SIZE as f64
        })
        .collect();
    per_call.sort_by(f64::total_cmp);
    let at = |q: f64| per_call[((q * per_call.len() as f64) as usize).min(per_call.len() - 1)];
    (at(0.5), at(0.95))
}

fn with_handle(request: &str, handle: &str) -> String {
    let mut v: Value = serde_json::from_str(request).expect("fixture request is JSON");
    v["flow"] = Value::String(handle.to_owned());
    v.to_string()
}

fn ok(raw: &str) {
    let v: Value = serde_json::from_str(raw).expect("kernel returns JSON");
    assert_eq!(v["status"], "OK", "kernel returned {raw}");
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "target/bench/fixtures.json".to_owned());
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {path}: {e} (run `node bench/run-node.mjs` first)"));
    let fixtures: Vec<Value> = serde_json::from_str(&raw).expect("fixtures are JSON");

    println!(
        "native {} · kernel {}\n",
        std::env::consts::ARCH,
        mowa_wasm::kernel_version()
    );
    println!("| Scenario | Flow nodes | Median µs/call | p95 µs/call |");
    println!("| --- | ---: | ---: | ---: |");

    for fx in &fixtures {
        let size = fx["size"].as_u64().expect("size");
        let loaded: Value = serde_json::from_str(&load_flow_json_impl(&fx["flow"].to_string()))
            .expect("load response");
        let handle = loaded["flowHandle"]
            .as_str()
            .expect("flowHandle")
            .to_owned();
        let advance_full = fx["advanceFull"].as_str().expect("advanceFull").to_owned();
        let start_full = fx["startFull"].as_str().expect("startFull").to_owned();
        let advance_handle = with_handle(&advance_full, &handle);
        let start_handle = with_handle(&start_full, &handle);
        ok(&advance_json_impl(&advance_handle));
        ok(&advance_json_impl(&advance_full));

        let rows: [(&str, &str, fn(&str) -> String); 3] = [
            (
                "advance · handle · kernel only",
                &advance_handle,
                advance_json_impl,
            ),
            (
                "advance · full flow · kernel only",
                &advance_full,
                advance_json_impl,
            ),
            (
                "start · handle · kernel only",
                &start_handle,
                start_json_impl,
            ),
        ];
        for (name, req, call) in rows {
            let (median, p95) = measure(|| call(req));
            println!("| {name} | {size} | {median:.1} | {p95:.1} |");
        }
    }
}
