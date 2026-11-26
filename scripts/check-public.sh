#!/usr/bin/env bash
# Public-release gate. Fails if anything that must not be published is tracked,
# or if versions disagree. Runs in CI on every push and before every release.
#
# Optional: MOWA_PRIVATE_TERMS=/path/to/file adds terms (one per line) that must not
# appear. Keep that file outside this repository, so the terms themselves stay private.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
err() { echo "FAIL: $*" >&2; fail=1; }

files=$(git ls-files)

# 1. Required files.
for f in LICENSE NOTICE README.md SECURITY.md TRADEMARKS.md CHANGELOG.md docs/hashing-spec.md \
  docs/flow-spec.md docs/kernel-spec.md docs/host-contract.md docs/schemas/flow.schema.json; do
  [ -f "$f" ] || err "missing $f"
done

# Every published package (each crate, each npm package) ships LICENSE and NOTICE,
# identical to the ones at the root (Apache-2.0, section 4).
for d in crates/* packages/*; do
  for f in LICENSE NOTICE; do
    cmp -s "$f" "$d/$f" || err "$d/$f is missing or differs from ./$f"
  done
done
for pkgjson in packages/*/package.json; do
  grep -q '"NOTICE"' "$pkgjson" || err "$pkgjson files must list NOTICE"
done

# 2. Build outputs and secrets must not be tracked.
echo "$files" | grep -E '(^|/)(target|pkg|pkg-web|dist|node_modules)/' && err "build output is tracked"
echo "$files" | grep -E '\.(wasm|tgz|tar\.gz|pem|key|p12)$|(^|/)\.env' && err "binary, archive, key or .env file is tracked"

# 3. Contents: absolute local paths, secrets, contradictory licence wording.
scan() { echo "$files" | grep -vE '^(Cargo\.lock|(.*/)?LICENSE|scripts/check-public\.sh)$' | xargs -d '\n' grep -nIE "$1" -- 2>/dev/null || true; }
hits=$(scan '(/home/[a-z]|/media/[a-z]|/Users/[A-Za-z]|[A-Z]:\\\\Users)'); [ -n "$hits" ] && { echo "$hits"; err "absolute local path found"; }
hits=$(scan '(-----BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-)'); [ -n "$hits" ] && { echo "$hits"; err "possible secret found"; }
hits=$(scan '[Aa]ll rights reserved'); [ -n "$hits" ] && { echo "$hits"; err "'All rights reserved' contradicts Apache-2.0"; }
if [ -n "${MOWA_PRIVATE_TERMS:-}" ]; then
  while IFS= read -r term; do
    [ -z "$term" ] && continue
    hits=$(echo "$files" | xargs -d '\n' grep -nIiF -- "$term" 2>/dev/null || true)
    [ -n "$hits" ] && { echo "$hits"; err "private term found"; }
  done < "$MOWA_PRIVATE_TERMS"
fi

# 4. Versions agree (and match the tag, when given one: check-public.sh v0.5.0).
cargo_v=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)
root_v=$(node -p 'require("./package.json").version')
host_v=$(node -p 'require("./packages/host-browser/package.json").version')
verify_v=$(node -p 'require("./packages/verify/package.json").version')
kernel_v=$(node -p 'require("./packages/kernel/package.json").version')
mcp_v=$(node -p 'require("./packages/mcp/package.json").version')
[ "$cargo_v" = "$root_v" ] && [ "$cargo_v" = "$host_v" ] && [ "$cargo_v" = "$verify_v" ] && [ "$cargo_v" = "$kernel_v" ] && [ "$cargo_v" = "$mcp_v" ] || err "versions differ: Cargo $cargo_v, root $root_v, host $host_v, verify $verify_v, kernel $kernel_v, mcp $mcp_v"
bad_npm=$(node -e '
  const v = process.argv[1];
  for (const p of require("fs").readdirSync("packages")) {
    const deps = require(`./packages/${p}/package.json`).dependencies ?? {};
    for (const [name, want] of Object.entries(deps)) if (name.startsWith("@mowaos/") && want !== v) console.log(`${p}: ${name}@${want}`);
  }' "$cargo_v")
[ -z "$bad_npm" ] || err "npm packages must pin @mowaos/* to exactly $cargo_v: $bad_npm"
bad_pins=$(grep -E '^mowa-[a-z]+ = \{ path = ' Cargo.toml | grep -v "version = \"=$cargo_v\"" || true)
[ -z "$bad_pins" ] || err "workspace crate pins do not match $cargo_v: $bad_pins"
if [ -n "${1:-}" ] && [ "$1" != "v$cargo_v" ]; then err "tag $1 does not match version v$cargo_v"; fi

[ "$fail" -eq 0 ] && echo "Public gate passed (version $cargo_v)."
exit "$fail"
