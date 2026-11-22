# Release checks and packaging

Run **Validate TASM and websites** on the release commit. It builds the SDK, websites and Cloudflare modules, then tests Chromium, Firefox and WebKit.

## Check store persistence

Create a Flow in an empty browser store and another in a new Cloudflare Durable Object. Reopen the browser store and reactivate the same Durable Object. Read each Flow by ID to verify it was saved.

For upgrades from a released version, run the [schema upgrade tests](development.md#test-schema-upgrades) against that version. Record the supported versions and any steps operators must take in the [changelog](../CHANGELOG.md).

## Package the Cloudflare runtime

On Linux, use the [build toolchain](../README.md#run-locally) and GNU tar.

```sh
npm run package:cloudflare
npm run test:worker
```

The build writes `dist/tasm-cloudflare-<version>.tar.gz` and its `.sha256` file. Test the Free and Paid installations with that archive. Attach those same files to the release tagged `v<version>` from `package.json`. A rebuild can produce a different Wasm binary.

Pin the published archive's SHA-256 and byte length in the [installer](https://github.com/livewyer-ops/cf-tams).
