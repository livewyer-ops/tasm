import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

// Exercise Cloudflare's asset routing and headers without credentials or deployment.
for (const app of ['demo', 'playpen']) {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--config', `apps/${app}/wrangler.jsonc`],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(log);
      try { ready = (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Wait for local workerd. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(ready, log);
    const home = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(home.status, 200); assert((await home.text()).includes(`data-app="${app}"`));
    for (const [path, type] of [['service-worker.js', 'javascript'], [`${app}.js`, 'javascript'], [`${app}.css`, 'text/css'], ['tasm_bg.wasm', 'application/wasm'], ['samples/black.ts', 'video/mp2t'], ['branding/tams-favicon.svg', 'image/svg+xml']]) {
      const response = await fetch(base + '/' + path);
      assert.equal(response.status, 200, path);
      assert(response.headers.get('content-type').includes(type), `${path}: ${response.headers.get('content-type')}`);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      await response.arrayBuffer();
    }
    for (const path of ['api/service', 'media/missing', 'missing.js', 'preview.html', '_headers', '.git/config', `${app === 'demo' ? 'playpen' : 'demo'}.js`]) {
      assert.equal((await fetch(base + '/' + path)).status, 404, path);
    }
    console.log(`${app}: Cloudflare root, MIME types, cache headers and 404 routing passed.`);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
}
