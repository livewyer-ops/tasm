# Architecture

Both runtimes compile the same Rust handlers, domain rules and background jobs against the [BBC TAMS 8.2 specification](../contracts/tams/). The build generates route metadata, validators and OpenAPI from that copy.

| | Browser | Cloudflare |
| --- | --- | --- |
| Requests | A service worker handles `fetch()` within the app's scope | An API Worker routes requests to a SQLite Durable Object |
| Metadata | PostgreSQL through PGlite, persisted in IndexedDB | Durable Object SQLite |
| Media | Origin-private file system (OPFS) | Private R2 buckets with signed object URLs |
| Jobs | A shared worker runs queued work while a client is open | Durable Object alarms |

Shared Rust code lives in `core/rust/`. The host implementations live in `core/browser/` and `core/cloudflare/`. Demo and Playpen are separate static sites in `apps/` and use the browser SDK.

## Browser access and storage

Use HTTPS or localhost with service workers, SharedWorker, Web Locks, IndexedDB and writable OPFS. Tabs on the same origin and base path share a store. Clearing site data removes its metadata and media. Jobs resume when a client reopens the store.

The browser API has no authentication. Same-origin scripts can access the store. Local object URLs are unsigned. A request for a presigned allocation returns HTTP 400.

Webhook destinations must allow browser requests from the app's origin, including OPTIONS for JSON and the `X-Tasm-Delivery-Id` header. Delivery can repeat. Use the delivery ID to deduplicate events.
