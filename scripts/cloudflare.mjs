import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { writeCoreNotices } from './notices.mjs';

export function buildWasm(crate, directory, name) {
  execFileSync('cargo', ['build', '-p', crate, '--locked', '--release', '--target', 'wasm32-unknown-unknown'], { stdio: 'inherit' });
  const bindgen = process.env.WASM_BINDGEN ?? (existsSync('.local/bin/wasm-bindgen') ? '.local/bin/wasm-bindgen' : 'wasm-bindgen');
  execFileSync(bindgen, [`target/wasm32-unknown-unknown/release/${crate.replaceAll('-', '_')}.wasm`,
    '--target', 'web', '--out-name', name, '--out-dir', `pkg/${directory}`], { stdio: 'inherit' });
}

export async function buildCloudflare(dist, spec, marker, signature) {
  const src = 'core/cloudflare', out = resolve(dist, 'cloudflare');
  await mkdir('pkg/cloudflare', { recursive: true });
  await writeFile('pkg/cloudflare/openapi.json', JSON.stringify({
    ...spec, info: { ...spec.info, 'x-bbc-tams-api-version': '8.2' },
  }));
  buildWasm('tasm-cloudflare', 'cloudflare', 'tasm_cloudflare');
  await rm(out, { recursive: true, force: true });
  await mkdir(`${out}/api`, { recursive: true });
  await mkdir(`${out}/auth`, { recursive: true });
  await writeFile(`${out}/${marker}`, signature);
  // Keep the compiled module import for workerd. The database schema is bundled as text.
  const api = await build({ entryPoints: [`${src}/worker.ts`], outfile: `${out}/api/worker.mjs`,
    bundle: true, format: 'esm', target: 'es2022', metafile: true, external: ['cloudflare:workers'],
    loader: { '.sql': 'text' }, plugins: [{ name: 'compiled-worker-module', setup(builder) {
      builder.onResolve({ filter: /tasm_cloudflare_bg\.wasm$/ }, () => ({ path: './tasm.wasm', external: true }));
    } }] });
  await cp('pkg/cloudflare/tasm_cloudflare_bg.wasm', `${out}/api/tasm.wasm`);
  const issuer = await build({ entryPoints: [`${src}/auth/worker.ts`], outfile: `${out}/auth/worker.mjs`,
    bundle: true, metafile: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
    conditions: ['workerd','worker','browser'], external: ['node:*', 'cloudflare:*'], target: 'es2022' });
  const operator = await build({ entryPoints: [`${src}/auth/operator.ts`], outfile: `${out}/auth/operator.mjs`,
    bundle: true, metafile: true, format: 'esm', platform: 'node', external: ['wrangler'], target: 'node22',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  for (const dir of ['', '/auth']) {
    const config = JSON.parse(await readFile(`${src}${dir}/wrangler.jsonc`, 'utf8'));
    delete config.$schema;
    config.main = 'worker.mjs';
    config.no_bundle = true;
    if (!dir) config.rules = [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false }];
    await writeFile(`${out}${dir || '/api'}/wrangler.json`, JSON.stringify(config, null, 2) + '\n');
  }
  await cp(`${src}/auth/migrations`, `${out}/auth/migrations`, { recursive: true });
  await cp('LICENSE', `${out}/LICENSE`);
  await cp(`${src}/NOTICE`, `${out}/NOTICE`);
  await writeCoreNotices(out, { inputs: { ...api.metafile.inputs, ...issuer.metafile.inputs, ...operator.metafile.inputs } }, false);
}
