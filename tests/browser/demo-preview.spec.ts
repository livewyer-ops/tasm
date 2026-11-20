import { test, expect } from './fixtures';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
test.use({ app: 'demo', showOnboarding: true });

test('private preview refreshes copy and styles without changing the runtime or saved source', async ({ page, request }) => {
  test.setTimeout(180000);
  for (const file of ['preview.html', 'preview.css', 'preview.js']) {
    expect((await request.get('/' + file)).status()).toBe(404);
  }
  await mkdir('.local', { recursive: true });
  const source = await mkdtemp(resolve('.local/demo-preview-test-'));
  const runtime = resolve(process.env.TASM_DIST ?? 'dist');
  let server: ReturnType<typeof spawn> | undefined;
  try {
    // Edit a disposable source copy, never the developer's checkout.
    await cp('apps', join(source, 'apps'), { recursive: true });
    await cp('core/browser', join(source, 'core/browser'), { recursive: true });
    await cp('tsconfig.json', join(source, 'tsconfig.json'));
    server = spawn(process.execPath, [resolve('scripts/serve.mjs'), '--app=demo', '--ui-preview'], {
      cwd: source, env: { ...process.env, PORT: '0', TASM_DIST: runtime }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview server did not start')), 30000);
      server!.once('error', error => { clearTimeout(timer); reject(error); });
      server!.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview server exited: ${code}`)); });
      server!.stdout!.on('data', data => {
        const url = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) { clearTimeout(timer); resolve(url); }
      });
    });
    const entry = base + '/preview.html';
    const html = await request.get(entry);
    expect(html.headers()['cache-control']).toBe('no-store');
    expect(await html.text()).toContain('href="./preview.html"');
    for (const file of ['preview.css', 'preview.js']) {
      const response = await request.get(base + '/' + file);
      expect(response.status()).toBe(200);
      expect(response.headers()['cache-control']).toBe('no-store');
    }
    for (const file of ['service-worker.js', 'worker.js', 'tasm_bg.wasm']) {
      expect(await (await request.get(base + '/' + file)).body()).toEqual(await readFile(join(runtime, 'demo', file)));
    }
    for (const path of ['/package.json', '/apps/demo/main.ts', '/.git/config', '/preview.js.map']) {
      expect((await request.get(base + path)).status()).toBe(404);
    }
    await page.addInitScript(() => {
      const show = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () {
        if (this.id === 'demo-about') sessionStorage.setItem('test-about-count', String(Number(sessionStorage.getItem('test-about-count')) + 1));
        show.call(this);
      };
      // Startup can reload for an application-worker update before the app is ready.
      window.addEventListener('tasm-startup', event => {
        if ((event as CustomEvent<string>).detail === 'Installing application worker' && !sessionStorage.getItem('test-startup-reloaded')) {
          sessionStorage.setItem('test-startup-reloaded', 'true'); location.reload();
        }
      });
    });
    await page.goto(entry);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
    await expect(page.locator('#demo-about')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('test-about-count'))).toBe('1');
    expect(await page.locator('.steps span').allTextContents()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    const fonts = await page.evaluate(() => ['[data-step="1"]', '[data-step="5"]'].map(selector => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return [style.fontFamily, style.fontSize, style.fontWeight];
    }));
    expect(fonts[1]).toEqual(fonts[0]);
    await expect(page.locator('#demo-about')).toContainText('store and retrieve media by time via an API');
    await page.locator('#demo-about').getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#about-demo').click(); await expect(page.locator('#demo-about')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('test-about-count'))).toBe('2');
    await page.keyboard.press('Escape');
    await page.locator('#primary').click();
    await expect(page.locator('#step-title')).toHaveText('Step 2. Add a video flow', { timeout: 60000 });
    const saved = await page.evaluate(async () => (await (await fetch('/api/flows')).json()));
    expect(saved.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    const htmlPath = join(source, 'apps/demo/index.html'), cssPath = join(source, 'apps/demo/style.css'), jsPath = join(source, 'apps/demo/main.ts');
    await writeFile(htmlPath, (await readFile(htmlPath, 'utf8')).replace('Explore media by time', 'Preview copy changed'));
    await writeFile(cssPath, (await readFile(cssPath, 'utf8')) + '\n.intro h1{color:rgb(11,22,33)}\n');
    const script = (await readFile(jsPath, 'utf8')).replace('Saved demo loaded.', 'Preview dynamic copy changed.');
    await writeFile(jsPath, script);
    await page.reload();
    await expect(page.locator('#status')).toHaveText('Preview dynamic copy changed.', { timeout: 90000 });
    await expect(page.locator('#demo-about')).not.toBeVisible();
    await expect(page.locator('h1')).toHaveText('Preview copy changed');
    await expect(page.locator('h1')).toHaveCSS('color', 'rgb(11, 22, 33)');
    expect(await page.evaluate(async () => (await (await fetch('/api/flows')).json()))).toEqual(saved);
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key =>
      (await (await caches.open(key)).keys()).map(r => new URL(r.url).pathname)))).flat());
    expect(cached).not.toContain('/preview.html');
    expect(cached).not.toContain('/preview.css');
    expect(cached).not.toContain('/preview.js');
    expect(cached).toContain('/tasm_bg.wasm');

    await writeFile(jsPath, script + '\nconst = ;');
    expect((await request.get(base + '/preview.js')).status()).toBe(500);
    await writeFile(jsPath, script);
    expect((await request.get(base + '/preview.js')).status()).toBe(200);
    expect(await (await request.get(base + '/service-worker.js')).body()).toEqual(await readFile(join(runtime, 'demo/service-worker.js')));
  } finally {
    await page.goto('about:blank');
    if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
    await rm(source, { recursive: true, force: true });
  }
});
