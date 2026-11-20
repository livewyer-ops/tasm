# TASM

TASM runs the BBC Time-addressable Media Store (TAMS) 8.2 API in a browser or on Cloudflare Workers.

- [Demo](https://demo.tams.lwy.sh/) follows a media object from upload to playback. [Walkthrough](docs/demo.md)
- [Playpen](https://playpen.tams.lwy.sh/) lets you arrange clips and inspect the API requests behind each edit. [Playpen guide](docs/playpen.md)
- [Browser SDK](docs/embedding.md) adds a local store to a web app. The [Cloudflare installer](https://github.com/livewyer-ops/cf-tams) deploys a hosted store with Durable Objects and R2.

## Run locally

Install Node.js 22.19 or later, npm and rustup. Run these commands from the repository root.

```sh
rustup toolchain install 1.99.1 --profile minimal --target wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.104 --locked
npm ci
DEMO_URL=http://127.0.0.1:4174/ PLAYPEN_URL=http://127.0.0.1:4173/ npm run build
npm run serve:demo
```

Open `http://127.0.0.1:4174/`. For the Playpen, run `npm run serve:playpen` in a second terminal and open `http://127.0.0.1:4173/`. Each site stores its media in your browser. Clearing site data deletes that store.

[Architecture](docs/architecture.md) · [Build and test](docs/development.md) · [Hosting](docs/hosting.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

TASM is licensed under Apache-2.0. See the [licence](LICENSE), [notices](NOTICE) and [asset credits](docs/credits.md).
