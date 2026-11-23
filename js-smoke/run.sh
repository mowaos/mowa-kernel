#!/usr/bin/env bash
# Build mowa-wasm for wasm32, generate Node bindings, and run the smoke test.
set -euo pipefail
cd "$(dirname "$0")/.."

want=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p' | head -n1)
have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [ "$want" != "$have" ]; then
  echo "wasm-bindgen CLI $want required (found: ${have:-none})." >&2
  echo "Install: cargo +stable install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)

# Strip machine-specific absolute paths from the binary so the release build is
# byte-identical wherever it is built (and leaks no local paths).
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rustc_sysroot="$(rustc --print sysroot)"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$PWD=/mowa-kernel --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$rustc_sysroot=/rustc-sysroot"

cargo build -p mowa-wasm --target wasm32-unknown-unknown --release --locked
wasm-bindgen --target nodejs --out-dir pkg \
  target/wasm32-unknown-unknown/release/mowa_wasm.wasm
echo "v${version}" > pkg/.kernel-source-tag

wasm-bindgen --target web --out-dir pkg-web \
  target/wasm32-unknown-unknown/release/mowa_wasm.wasm
echo "v${version}" > pkg-web/.kernel-source-tag

node --test js-smoke/smoke.mjs
