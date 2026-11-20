import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { browserOptions, coreOptions } from '../scripts/bundle-options.mjs';

// Inspect dependencies, including transitive imports, so the core stays UI-free.
for (const [area, entries] of Object.entries({ core: ['core/browser/index.ts', 'core/browser/worker.ts', 'core/browser/service-worker.ts'],
  demo: ['apps/demo/main.ts'], playpen: ['apps/playpen/main.ts'], shared: ['apps/shared/startup.ts', 'apps/shared/workspace-store.ts', 'apps/shared/player.ts'] })) {
  const result = await build({ ...(area === 'core' ? coreOptions : browserOptions), entryPoints: entries,
    outdir: 'unused', write: false, metafile: true, define: { __TASM_ASSETS__: '[]' }, logLevel: 'silent' });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (area === 'core') assert(!input.startsWith('apps/'), `Core imports ${input}`);
    else for (const app of ['demo', 'playpen']) if (app !== area) assert(!input.startsWith(`apps/${app}/`), `${area} imports ${input}`);
  }
}

async function digest(directory) {
  const hash = createHash('sha256');
  for (const path of (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort()) {
    hash.update(path).update(await readFile(join(directory, path)));
  }
  return hash.digest('hex');
}

// Rebuild in a disposable checkout and prove each app can change independently.
await mkdir('.local', { recursive: true });
const source = await mkdtemp(resolve('.local/artifact-check-'));
try {
  for (const path of ['core', 'apps', 'scripts', 'deploy', 'licenses', 'contracts/tams/api', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'tsconfig.json', 'LICENSE', 'NOTICE']) {
    await cp(path, join(source, path), { recursive: true });
  }
  await symlink(resolve('node_modules'), join(source, 'node_modules'));
  const cargoTarget = join(source, 'cargo output');
  const env = { ...process.env, CARGO_TARGET_DIR: cargoTarget, TASM_DIST: join(source, 'dist'), DEMO_URL: 'https://demo.example/', PLAYPEN_URL: 'https://playpen.example/',
    WASM_BINDGEN: process.env.WASM_BINDGEN ?? (existsSync('.local/bin/wasm-bindgen') ? resolve('.local/bin/wasm-bindgen') : 'wasm-bindgen') };
  for (const invalid of ['.', 'apps']) assert.throws(() => execFileSync(process.execPath, ['scripts/build.mjs', 'demo'],
    { cwd: source, env: { ...env, TASM_DIST: invalid }, stdio: 'pipe' }), /Build output must be outside source directories/);
  for (const name of ['core', 'demo', 'playpen']) {
    const dist = join(source, 'foreign-' + name);
    await mkdir(join(dist, name), { recursive: true });
    const keep = join(dist, name, 'keep.txt');
    await writeFile(keep, 'user data');
    assert.throws(() => execFileSync(process.execPath, ['scripts/build.mjs'], {
      cwd: source, env: { ...env, TASM_DIST: dist }, stdio: 'pipe'
    }), /Refusing to replace/);
    assert.equal(await readFile(keep, 'utf8'), 'user data');
    if (name !== 'core') assert(!existsSync(join(dist, 'core')));
  }
  const rebuild = target => execFileSync(process.execPath, ['scripts/build.mjs', target], { cwd: source, env, stdio: 'inherit' });
  rebuild('all');
  // Leave the previous modules in Cargo's default directory while rebuilding elsewhere.
  const release = 'wasm32-unknown-unknown/release';
  await mkdir(join(source, 'target', release), { recursive: true });
  for (const adapter of ['browser', 'cloudflare']) {
    const file = `tasm_${adapter}.wasm`;
    await cp(join(cargoTarget, release, file), join(source, 'target', release, file));
    await appendFile(join(source, 'core', adapter, 'rust/src/lib.rs'),
      '\n#[wasm_bindgen::prelude::wasm_bindgen]\npub fn package_revision_probe() -> u32 { 2 }\n');
  }
  rebuild('all');
  for (const file of ['core/tasm_bg.wasm', 'cloudflare/api/tasm.wasm']) {
    const module = await WebAssembly.compile(await readFile(join(source, 'dist', file)));
    assert(WebAssembly.Module.exports(module).some(entry => entry.name === 'package_revision_probe'), `Stale module in ${file}`);
  }
  const hashes = {};
  for (const target of ['demo', 'playpen']) hashes[target] = await digest(join(source, 'dist', target));
  const core = await readdir(join(source, 'dist/core'));
  assert.match(await readFile(join(source, 'dist/core/THIRD_PARTY.txt'), 'utf8'), /PostgreSQL Global Development Group/);
  assert(!core.includes('PLAYER-LICENSES.txt'));
  for (const forbidden of ['index.html', 'demo.js', 'playpen.js', 'samples', 'branding', 'onboarding.css']) assert(!core.includes(forbidden));
  for (const app of ['demo', 'playpen']) {
    const peer = app === 'demo' ? 'playpen' : 'demo', out = join(source, 'dist', app);
    const html = await readFile(join(out, 'index.html'), 'utf8');
    assert(html.includes(`data-app="${app}"`));
    if (app === 'playpen') assert(html.includes('href="https://demo.example/"'));
    else assert(!html.includes('https://playpen.example/') && !html.includes('Open Playpen'));
    assert(!html.includes('__PEER_URL__'));
    assert(!existsSync(join(out, `${peer}.js`)));
    assert(!existsSync(join(out, 'preview.html')));
    const worker = await readFile(join(out, 'service-worker.js'), 'utf8');
    assert(!worker.includes(`${peer}.js`));
    assert.equal(worker.includes('samples/grid.ts'), app === 'playpen');
    for (const file of ['index.js', 'worker.js', 'tasm_bg.wasm', 'samples/manifest.json', 'branding/tams-favicon.svg']) assert(existsSync(join(out, file)), `${app}/${file}`);
    for (const path of ['LICENSE', 'NOTICE', 'THIRD_PARTY.txt', 'mediabunny-LICENSE', 'branding/HKGrotesk-OFL.txt', 'branding/FiraCode-OFL.txt']) assert(existsSync(join(out, path)), path);
    assert.match(await readFile(join(out, 'PLAYER-LICENSES.txt'), 'utf8'), /Components embedded in @byomakase/);
    const path = join(source, 'apps', app, 'index.html');
    await writeFile(path, (await readFile(path, 'utf8')) + '\n<!-- independent app revision -->');
    rebuild(app);
    assert.notEqual(await digest(out), hashes[app], `${app} must change`);
    assert.equal(await digest(join(source, 'dist', peer)), hashes[peer], `${peer} must remain byte-for-byte unchanged`);
    hashes[app] = await digest(out);
  }
  console.log('Dependency boundaries and independent core, Demo and Playpen builds passed.');
} finally { await rm(source, { recursive: true, force: true }); }
