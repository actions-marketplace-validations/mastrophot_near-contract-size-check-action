# NEAR Contract Size Check (GitHub Action)

GitHub Action to:

1. Build a NEAR contract WASM in CI
2. Check size against configurable limits
3. Compare size with a baseline ref (for regression tracking)
4. Emit clear warnings/errors and optimization suggestions

## Why use it

NEAR contract deployments fail when WASM exceeds size limits. This action catches regressions earlier in CI and provides immediate optimization guidance.

## Inputs

| Input | Default | Description |
|---|---:|---|
| `build-command` | `cargo build --target wasm32-unknown-unknown --release` | Build command for current revision |
| `working-directory` | `.` | Build/project directory |
| `wasm-path` | _auto_ | Explicit current WASM path (optional) |
| `size-limit-bytes` | `4194304` | Hard limit in bytes (4 MiB default) |
| `warning-threshold-pct` | `85` | Warn when usage reaches this percent |
| `fail-if-over-limit` | `true` | Fail workflow when over hard limit |
| `fail-on-warning` | `false` | Fail workflow on warning threshold |
| `enable-compare` | `true` | Build baseline from `compare-ref` and compute delta |
| `compare-ref` | `HEAD~1` | Git ref for baseline build |
| `baseline-build-command` | _same as `build-command`_ | Optional baseline build command |
| `baseline-wasm-path` | _auto_ | Explicit baseline WASM path (optional) |
| `write-summary` | `true` | Write markdown summary to step summary |

## Outputs

| Output | Description |
|---|---|
| `wasm-path` | Resolved current WASM path |
| `current-size-bytes` | Current WASM size |
| `size-limit-bytes` | Configured limit |
| `usage-percent` | Current usage vs limit |
| `warning-triggered` | Whether warning threshold was reached |
| `over-limit` | Whether hard limit was exceeded |
| `baseline-wasm-path` | Baseline WASM path if comparison succeeded |
| `baseline-size-bytes` | Baseline size if comparison succeeded |
| `delta-bytes` | Current minus baseline bytes |
| `delta-percent` | Current vs baseline percent growth |
| `optimization-suggestions` | Markdown bullet list of suggestions |

## Example workflow

```yaml
name: NEAR contract size

on:
  pull_request:
  push:
    branches: [main]

jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Rust target
        run: rustup target add wasm32-unknown-unknown

      - name: Check WASM size
        id: size
        uses: mastrophot/near-contract-size-check-action@v1
        with:
          working-directory: .
          build-command: cargo build --target wasm32-unknown-unknown --release
          compare-ref: origin/main
          size-limit-bytes: 4194304
          warning-threshold-pct: 85
          fail-if-over-limit: true

      - name: Print result
        run: |
          echo "WASM size: ${{ steps.size.outputs.current-size-bytes }}"
          echo "Usage: ${{ steps.size.outputs.usage-percent }}%"
          echo "Delta bytes: ${{ steps.size.outputs.delta-bytes }}"
```

## Optimization suggestions emitted by action

When contract is close to or above limit, the action suggests practical fixes such as:

- release profile tuning (`lto`, `opt-level=z`, `codegen-units=1`, `panic=abort`)
- stripping symbols (`RUSTFLAGS='-C link-arg=-s'`)
- dependency and feature pruning
- reducing large in-contract constants/blobs

## Local development

```bash
npm install
npm test
```

## Notes

- Auto-detection prefers `target/wasm32-unknown-unknown/release/*.wasm`.
- Baseline comparison uses `git worktree`, so checkout must include history (`fetch-depth: 0`).
