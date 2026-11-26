# Build and test

Follow the [local setup](../README.md#run-locally). `npm run build` builds all four targets. Use an individual command for a single target.

| Command | Output |
| --- | --- |
| `npm run build:core` | Embeddable browser SDK in `dist/core/` |
| `npm run build:demo` | Static Demo in `dist/demo/` |
| `npm run build:playpen` | Static Playpen in `dist/playpen/` |
| `npm run build:cloudflare` | API Worker, OAuth issuer and operator CLI in `dist/cloudflare/` |

Set `TASM_DIST` to build or serve from a different output directory. Use a new directory or a previous TASM build. For HTML, CSS and TypeScript changes, run `npm run demo:preview` or `npm run playpen:preview` after building, then open the printed preview URL.

## Checks

Build the affected targets before running their checks.

| Change | Checks |
| --- | --- |
| Rust | `cargo fmt --all -- --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings` |
| Apps and TypeScript | `npm run check`, `npm run test:logic`, `npm run test:preview` |
| Media timing and segmentation | `npm run test:segments` |
| Browser storage | `npm run test:pglite` |
| Worker and Cloudflare configuration | `npm run test:worker`, `npm run check:cloudflare`, `npm run test:cloudflare` |
| Distribution | `npm run test:artifacts` and the [release package checks](releases.md) |

For browser tests on Linux, install FFmpeg and PulseAudio, build both sites and leave ports 5173 and 5174 available. The test script creates an isolated audio monitor.

```sh
npx playwright install --with-deps chromium firefox webkit
sh scripts/test-browser.sh --smoke --project=chromium
```

Run `sh scripts/test-browser.sh` for the full suite. Pull requests run Chromium smoke tests. Main runs the full Chromium suite. Nightly and manual validation also run Firefox and WebKit.

## Test schema upgrades

Add schema changes as numbered migrations for the affected host. After building, run `npm run test:pglite` and `npm run test:worker` to check that an interrupted migration rolls back and succeeds on retry.

To test an upgrade between builds, build the new version into `dist/` and set `TASM_PREVIOUS_DIST` to the absolute path of the earlier build's `dist/` directory. The browser test reads media offline after the upgrade. The Worker test opens the same Durable Object with both installations and checks its media and queued work. Scheduled and manual validation run these checks against the latest published stable release when one is available.

```sh
export TASM_PREVIOUS_DIST=/path/to/previous/dist
npm run test:browser -- tests/browser/startup.spec.ts --grep 'ready updates' --project=chromium
npm run test:worker
```
