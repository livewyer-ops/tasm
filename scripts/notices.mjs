import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

async function licenceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && /^(licen[cs]e|copying|copyright|notice)([.-]|$)/i.test(entry.name));
  return Promise.all(files.sort((a, b) => a.name.localeCompare(b.name)).map(entry => readFile(resolve(directory, entry.name), 'utf8')));
}

async function jsNotices(metafile) {
  const directories = new Set();
  for (const path of Object.keys(metafile.inputs)) {
    if (path.startsWith('(disabled):')) continue;
    const match = path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) directories.add(match[1]);
  }
  const packages = [];
  for (const directory of [...directories].sort()) {
    const { name, version } = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    const files = await licenceFiles(directory);
    if (!files.length && name === '@better-auth/utils' && ['0.4.2', '0.5.0'].includes(version)) {
      files.push(await readFile('licenses/better-auth-utils-0.4.2.txt', 'utf8'));
    }
    packages.push([name + ' ' + version, files]);
  }
  return packages;
}

function render(packages) {
  const notices = new Map();
  for (const [name, files] of packages) {
    if (!files.length) throw new Error('Missing dependency licence for ' + name);
    for (const file of files) {
      const text = file.trim();
      if (!notices.has(text)) notices.set(text, new Set());
      notices.get(text).add(name);
    }
  }
  return [...notices].map(([text, names]) => [...names].sort().join(', ') + '\n\n' + text + '\n').join('\n');
}

export async function writeCoreNotices(directory, metafile, pglite = true) {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown'], { encoding: 'utf8' }));
  const packages = await jsNotices(metafile);
  for (const crate of metadata.packages.filter(crate => crate.source).sort((a, b) => a.id.localeCompare(b.id))) {
    packages.push([crate.name + ' ' + crate.version, await licenceFiles(dirname(crate.manifest_path))]);
  }
  if (pglite) packages.push(['PostgreSQL (PGlite)', [await readFile('licenses/PostgreSQL.txt', 'utf8')]]);
  await writeFile(resolve(directory, 'THIRD_PARTY.txt'), render(packages));
}
export async function writeAppNotices(directory, metafile) {
  const packages = await jsNotices(metafile);
  const embedded = await readFile('licenses/Omakase-components.txt', 'utf8');
  await writeFile(resolve(directory, 'PLAYER-LICENSES.txt'), render(packages) + '\n' + embedded);
}
