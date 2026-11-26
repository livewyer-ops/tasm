# Embed the browser SDK

Build the SDK with `npm run build:core`. Serve `dist/core/` at `/tasm/` on HTTPS or localhost. Put the host page under the same path so the service worker can handle its requests.

```js
import { startTasm } from '/tasm/index.js';

const client = await startTasm();
const response = await fetch(`${client.apiUrl}service`);
const service = await response.json();
console.log(service.api_version); // 8.2
```

Run the example in the host page. If the service request returns 404, check the [service worker scope](troubleshooting.md). Call `startTasm()` once per page. For another mount, pass `{ basePath: '/media/' }` and serve the SDK and page there. Each base path has its own store. API and object URLs work inside the participating browser.

To configure storage backends, pass them on first use. The first is the default. Each stores its own object instances in OPFS.

```js
const client = await startTasm({ backends: [
  { id: '81d13d58-5041-4580-91f9-38ce03daef19', label: 'Primary', tags: { tier: 'hot' } },
  { id: 'ddc7c7c6-d1bb-4c3e-856a-03a5cd5dfae1', label: 'Copy' },
] });
```

Backend tags accept strings or arrays of strings. Query `/service/storage-backends?tag.tier=hot` to list matching backends.

Use `client.close()` to disconnect the page. To stop the runtime before clearing its storage, use `await client.shutdown()`. It holds exclusive access until the client closes or the page unloads.
