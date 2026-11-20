import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

await mkdir('.local', { recursive: true });
const source = await mkdtemp(resolve('.local/ui-preview-check-')), runtime = join(source, 'runtime');
const children = [];
async function start(app, preview = true) {
  const child = spawn(process.execPath, [resolve('scripts/serve.mjs'), `--app=${app}`, ...(preview ? ['--ui-preview'] : [])], {
    cwd: source, env: { ...process.env, PORT: '0', TASM_BIND_ADDRESS: '127.0.0.1', TASM_DIST: runtime,
      DEMO_URL: 'https://demo.example/', PLAYPEN_URL: 'https://playpen.example/' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Preview startup timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
    child.stdout.on('data', data => { const url = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) { clearTimeout(timer); resolve(url); } });
  });
}
async function get(url, status = 200) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, url); return response;
}
try {
  await cp('apps', join(source, 'apps'), { recursive: true });
  await cp('core/browser', join(source, 'core/browser'), { recursive: true });
  await mkdir(join(source, 'pkg'));
  await cp('pkg/operations.json', join(source, 'pkg/operations.json'));
  await cp('tsconfig.json', join(source, 'tsconfig.json'));
  for (const app of ['demo', 'playpen']) {
    await mkdir(join(runtime, app), { recursive: true });
    await writeFile(join(runtime, app, 'service-worker.js'), '/* unchanged runtime */');
    await writeFile(join(runtime, app, 'index.html'), `<title>Compiled ${app}</title>`);
    const base = await start(app);
    const html = await get(base + '/preview.html'), text = await html.text();
    assert.equal(html.headers.get('cache-control'), 'no-store');
    for (const link of ['href="./preview.html"', './preview.css', './preview-bootstrap.js']) assert(text.includes(link), link);
    if (app === 'playpen') assert(text.includes('href="https://demo.example/"'));
    else assert(!text.includes('https://playpen.example/') && !text.includes('Open Playpen'));
    assert(!text.includes('__PEER_URL__'));
    const cssPath = join(source, 'apps', app, 'style.css');
    await writeFile(cssPath, (await readFile(cssPath, 'utf8')) + '\n/* refreshed copy */');
    const css = await get(base + '/preview.css'); assert.equal(css.headers.get('cache-control'), 'no-store');
    assert((await css.text()).includes('/* refreshed copy */'));
    const welcome = await get(base + '/preview-onboarding.css'); assert.equal(welcome.headers.get('cache-control'), 'no-store');
    assert((await welcome.text()).includes('.welcome-dialog'));
    assert((await (await get(base + '/preview-bootstrap.js')).text()).includes('./preview.js'));
    const js = await get(base + '/preview.js'); assert.equal(js.headers.get('cache-control'), 'no-store'); assert((await js.text()).length > 0);
    const jsPath = join(source, 'apps', app, 'main.ts'), script = await readFile(jsPath, 'utf8');
    await writeFile(jsPath, script + '\nconst = ;'); await get(base + '/preview.js', 500);
    await writeFile(jsPath, script + '\nconsole.debug("refreshed script");');
    assert((await (await get(base + '/preview.js')).text()).includes('refreshed script'));
    assert.equal(await (await get(base + '/service-worker.js')).text(), '/* unchanged runtime */');
    for (const path of ['/package.json', '/apps/playpen/main.ts', '/.git/config', '/preview.js.map', '/_headers']) await get(base + path, 404);
    const production = await start(app, false);
    for (const file of ['preview.html', 'preview.css', 'preview.js', 'preview-onboarding.css']) await get(production + '/' + file, 404);
    assert.equal(await (await get(production + '/')).text(), `<title>Compiled ${app}</title>`);
  }
  console.log('Independent previews passed: root pages, peer links, refresh, build recovery and production isolation.');
} finally {
  for (const child of children) if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  await rm(source, { recursive: true, force: true });
}
