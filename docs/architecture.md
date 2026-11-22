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

The browser's generated OpenAPI document declares an empty security requirement for this local deployment. The browser API has no authentication. Same-origin scripts can access the store. Local object URLs are unsigned. A request for a presigned allocation returns HTTP 400.

Webhook destinations must allow browser requests from the app's origin, including OPTIONS for JSON and the `X-Tasm-Delivery-Id` header. Delivery can repeat. Use the delivery ID to deduplicate events.

## Cloudflare access policy

Cloudflare authenticates API clients with HTTP Basic or OAuth Bearer credentials, according to the deployment configuration. Its OAuth policy reserves changing a Flow's `read_only` flag for administrators, including changes through whole-Flow PUT. Creating, replacing or deleting a webhook requires `tams-api/write` or `tams-api/admin`. Reading a webhook requires `tams-api/read` or `tams-api/admin`. Deployments may choose their own policy under [BBC application note 0016](https://github.com/bbc/tams/blob/34fb31b80cb8afb3194f28c8b787301379caacf8/docs/appnotes/0016-authorisation-in-tams-workflows.md).

## BBC 8.2 wire conventions

| Operation | Client convention |
|---|---|
| Allocate Object storage | Put `presigned` and the optional init Object `content_type` in the JSON request body. The released request schema uses the underscore spelling. Cloudflare defaults to signed URLs. |
| Create or read a Profile | Use `/service/profiles` and `/service/profiles/{profileId}`. |
| Register an external Object | Set its sample timing on first registration. When reusing an Object, the new Segment must fit inside the stored Object time range after applying `ts_offset`. |
| Write a Flow collection | Each child Flow ID occurs once in the ordered collection. Use its optional `role` for a human-readable label. |
| Query a Flow time range | A filter selects overlapping Segments. The reported extent covers the full matching Segments. |
| Select Object URLs | An explicit empty `accept_storage_ids` applies no storage-ID filter. |
| Create a Source through a Flow | The first Flow supplies the initial Source label, description and tags. Subsequent Source edits use the Source endpoints. |

The store treats a planar video layout on its own as insufficient to require chroma subsampling fields. For planar YCbCr, supply the horizontal and vertical factors when known. Webhook timestamps identify service events. Delivery time depends on the host and its retries.
