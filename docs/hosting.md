# Hosting

Serve `dist/demo/` and `dist/playpen/` at the roots of separate HTTPS origins. Each site includes its own browser runtime and service worker. Serve Wasm as `application/wasm` and MPEG transport streams as `video/mp2t`. Moving a site to another origin gives it a separate browser store.

## Deploy the websites to Cloudflare

Authenticate Wrangler for the account that owns the domains. Set `CLOUDFLARE_ACCOUNT_ID` and the two public URLs. Each deployment command builds its site and binds the supplied hostname.

```sh
export DEMO_URL=https://demo.example.com/
export PLAYPEN_URL=https://playpen.example.com/
TASM_DEPLOY_DOMAIN=demo.example.com npm run deploy:demo
TASM_DEPLOY_DOMAIN=playpen.example.com npm run deploy:playpen
```

To deploy a TAMS **API** backed by Durable Objects and R2, use the [Cloudflare installer](https://github.com/livewyer-ops/cf-tams).

The API Worker keeps completed delete requests, object copies, object cleanups and terminal webhook deliveries for 86400 seconds (one day) by default. Set `WORKER_QUEUE_RETENTION_SECONDS` to a whole number of seconds in the Worker configuration or dashboard. Set it to `0` to keep these records indefinitely.

Both sites serve a same-origin Content Security Policy. The browser runtime uses WebAssembly, blob workers and media URLs. HTTPS and local HTTP connections support configured webhooks. Inline styles position the timeline and player controls. The local preview server applies the same policy as the deployed sites.
