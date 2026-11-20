import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const dist = resolve(process.env.TASM_DIST ?? 'dist');
const name = `tasm-cloudflare-${version}.tar.gz`;
const archive = join(dist, name);
// An explicit list also excludes Wrangler state left by a local test run.
const files = ['api/worker.mjs', 'api/tasm.wasm', 'api/wrangler.json', 'auth/worker.mjs', 'auth/operator.mjs',
  'auth/wrangler.json', 'auth/migrations', 'LICENSE', 'NOTICE', 'THIRD_PARTY.txt'];
execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=u=rwX,go=rX',
  '-czf', archive, '-C', join(dist, 'cloudflare'), ...files], { stdio: 'inherit' });
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', `${digest}  ${name}\n`);
console.log(archive);
