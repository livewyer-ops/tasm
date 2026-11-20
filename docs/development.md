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

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
npm run build
npm run check
npm run test:worker
npm run test:segments
npm run test:artifacts
npm run test:preview
npm run check:cloudflare
npm run test:cloudflare
```

For the browser suite on Linux, install FFmpeg and PulseAudio. The test script sets up a dedicated audio monitor. Run it with both sites built and ports 5173 and 5174 available.

```sh
npx playwright install --with-deps chromium firefox webkit
sh scripts/test-browser.sh
```

[Release checks and packaging](releases.md)
