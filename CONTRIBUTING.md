# Contributing

Bug reports, questions and pull requests are welcome.

## Sign your commits (DCO)

Contributions are accepted under the project's licence (Apache-2.0) using the
[Developer Certificate of Origin](https://developercertificate.org/) (DCO). By adding a
`Signed-off-by` line to a commit, you certify that you wrote the change, or otherwise
have the right to submit it under this licence.

Add the line automatically with `-s`:

```bash
git commit -s -m "fix(core): describe the change"
```

The line must use your real name and an email address you can be reached at. CI
rejects pull requests containing commits without it.

## Before opening a pull request

Run the full checks locally:

```bash
npm test
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
bash scripts/check-public.sh
```

## Changes that need extra care

- **Hash or identifier formulas, or the JSON contract.** Any change here is breaking.
  Update [docs/hashing-spec.md](docs/hashing-spec.md) and the test vectors in the same
  pull request, and say so in the description.
- **Determinism.** No wall-clock time, randomness, floats or hash maps in the kernel
  crates; the lint rules enforce this.

## Security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
