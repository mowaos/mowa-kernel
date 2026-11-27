# Releasing

How a version of the kernel and its packages is released. Maintainers follow it in order, and a release is not finished until step 6 passes for every registry.

## What gets released

| Where | What |
|---|---|
| GitHub Release | Built by `.github/workflows/release.yml` from a `v*` tag: the source archive, the WASM builds for web and Node, the `.wasm` file, and `SHA256SUMS` |
| crates.io | `mowa-canon`, `mowa-flow`, `mowa-core`, `mowa-wasm`, `mowa-kernel` |
| npm | `@mowaos/kernel`, `@mowaos/host-browser`, `@mowaos/verify`, `@mowaos/mcp` |

All crates and npm packages share one version. Crates pin each other exactly (`=X.Y.Z`), and npm packages pin `@mowaos/*` dependencies exactly. `scripts/check-public.sh` enforces this.

## Why every release changes result hashes

`kernelVersion` is part of the audit record, so `resultHash` changes with every version, even when no decision changes (see [hashing-spec.md](hashing-spec.md)). Bundles verify with the verifier of the version that recorded them: `npx @mowaos/verify@<that version> bundle.json`. A newer verifier refuses them with a version message.

The spec vectors in `docs/vectors/` carry the version too. On a version bump, `npm test` fails until their `kernelVersion` and the hashes that depend on it are updated. The regression test checks that the built kernel still reproduces every version-independent hash in the vectors. When it passes, no decision changed. If a decision did change, that is a contract change: see [hashing-spec.md](hashing-spec.md) and CONTRIBUTING.

## Steps

1. **Versions.** Set the new version in `Cargo.toml`, the workspace crate pins, the root `package.json`, every `packages/*/package.json`, and their `@mowaos/*` dependencies. Update the version-dependent fields of the spec vectors (above). Add a CHANGELOG entry.
2. **Checks.** Run `npm test`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo fmt --all -- --check` and `bash scripts/check-public.sh`. Push, and wait for CI to pass on that commit.
3. **Tag.** Create a signed, annotated tag `vX.Y.Z` on that commit and push it. The Release workflow re-runs the gate, which checks the tag against the version. It then runs the full test suite and publishes the GitHub Release. Nothing is packaged by hand.
4. **crates.io.** Publish in dependency order:
   1. `mowa-canon`
   2. `mowa-flow`
   3. `mowa-core`
   4. `mowa-wasm`
   5. `mowa-kernel`

   Use `cargo publish --locked -p <crate>`. Only the first can be dry-run before the others exist.
5. **npm.** In each package folder, run `npm test`, which builds the package first. Then run `npm publish --access public`. Publishing does not build anything itself, so publish only what the tests just built. Order: `@mowaos/kernel`, `@mowaos/host-browser`, `@mowaos/verify`, `@mowaos/mcp`. A version can never be published twice. If one is wrong, release a new version.
6. **Verify from the registries, not from the local tree:**
   - crates.io and npm both report `X.Y.Z` for every package.
   - The `.wasm` in the npm tarballs, in `SHA256SUMS` and in a local build have the same SHA-256. The build is reproducible, and CI checks this.
   - In an empty folder, a bundle made with `npx @mowaos/mcp@X.Y.Z` passes `npx @mowaos/verify@X.Y.Z`. The previous version's verifier refuses it.
7. **Close.** Date the CHANGELOG heading.

## Releasing one npm package without a kernel release

Bumping the kernel only to ship a package fix would change every `resultHash`. Instead:

- Publish the package at its current version, if that version has never been published, and record it in the CHANGELOG with its own dated heading.
- Mark the commit it was published from with a signed annotated tag `<package>-vX.Y.Z`, for example `verify-v0.5.0`. Tags that don't start with `v` don't trigger the Release workflow.

## Tags are permanent

A repository ruleset protects `v*` and `*-v*` tags against deletion, force-push and updates. Check the commit before you push a tag.
