import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

if (resolve(process.env.TASM_DIST ?? 'dist') !== resolve('dist')) throw new Error('Cloudflare asset configuration serves dist/. Unset TASM_DIST.');
const policies = [...readFileSync('deploy/_headers', 'utf8').matchAll(/^  Content-Security-Policy: (.+)$/gm)].map(match => match[1]);
assert.equal(policies.length, 2);
assert.match(policies[0], /(?:^|; )connect-src 'self' blob:(?:;|$)/);
assert.match(policies[0], /(?:^|; )font-src 'self' data:(?:;|$)/);
assert.match(policies[1], /(?:^|; )connect-src 'self' blob: https:/);
for (const policy of policies) assert.match(policy, /(?:^|; )frame-ancestors 'none'(?:;|$)/);

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
    assert.equal(home.headers.get('content-security-policy'), policies[0]);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.equal(home.status, 200); assert((await home.text()).includes(`data-app="${app}"`));
    for (const [path, type] of [['worker.js', 'javascript'], ['service-worker.js', 'javascript'], [`${app}.js`, 'javascript'], [`${app}.css`, 'text/css'], ['tasm_bg.wasm', 'application/wasm'], ['samples/black.ts', 'video/mp2t'], ['branding/tams-favicon.svg', 'image/svg+xml']]) {
      const response = await fetch(base + '/' + path);
      assert.equal(response.status, 200, path);
      assert(response.headers.get('content-type').includes(type), `${path}: ${response.headers.get('content-type')}`);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('content-security-policy'), policies[path === 'worker.js' ? 1 : 0]);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
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
