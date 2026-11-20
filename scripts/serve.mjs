import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { appName, appHTML } from './apps.mjs';

const app = appName(process.argv.find(arg => arg.startsWith('--app='))?.slice(6));
const root = resolve(process.env.TASM_DIST ?? 'dist', app);
const preview = process.argv.includes('--ui-preview');
const port = Number(process.env.PORT ?? (app === 'demo' ? 4174 : 4173));
const address = process.env.TASM_BIND_ADDRESS ?? '127.0.0.1';
let bundle;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.ttf': 'font/ttf', '.ts': 'video/mp2t', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  // Live UI bypasses the worker cache; all runtime files still use the built release.
  const live = url.pathname.match(/^\/preview\.(html|css|js)$/);
  if (live || url.pathname === '/preview-onboarding.css' || (preview && url.pathname === '/startup.js')) {
    if (!preview) { res.writeHead(404).end(); return; }
    try {
      let bytes;
      if (url.pathname === '/preview-onboarding.css') bytes = await readFile('apps/shared/onboarding.css');
      else if (url.pathname === '/startup.js') {
        const { build } = await import('esbuild');
        bytes = (await build({ entryPoints: ['apps/shared/startup.ts'], bundle: true, format: 'iife', target: 'es2022', write: false })).outputFiles[0].contents;
      } else if (live[1] === 'html') {
        bytes = appHTML(await readFile(`apps/${app}/index.html`, 'utf8'), app)
          .replace('href="./"', 'href="./preview.html"').replaceAll(`./${app}.css`, './preview.css')
          .replaceAll('./onboarding.css', './preview-onboarding.css').replaceAll(`./${app}.js`, './preview.js');
      } else if (live[1] === 'css') bytes = await readFile(`apps/${app}/style.css`);
      else {
        bundle ??= import('esbuild').then(({ context }) => context({ entryPoints: [`apps/${app}/main.ts`], bundle: true, format: 'esm', target: 'es2022', sourcemap: 'inline', write: false }));
        bytes = (await (await bundle).rebuild()).outputFiles[0].contents;
      }
      res.writeHead(200, { 'content-type': types[extname(url.pathname)], 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      console.error(error);
      res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('UI preview could not build. Correct the error, then refresh.');
    }
    return;
  }
  const path = resolve(root, '.' + url.pathname, url.pathname.endsWith('/') ? 'index.html' : '');
  if (!path.startsWith(root + '/') || url.pathname.split('/').some(part => part.startsWith('.')) || url.pathname.startsWith('/_')) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404).end(); }
}).listen(port, address, () => console.log(`Serving ${app} http://${address}:${server.address().port}/${preview ? 'preview.html' : ''}`));
