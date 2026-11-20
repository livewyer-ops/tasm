import { test, expect as browserExpect } from './fixtures';
import { curlCommand, parseCurl } from '../../apps/playpen/terminal';

const expect = browserExpect.configure({ timeout: 30000 });
test.setTimeout(180000);

test('curl preserves quoted URLs, headers and bodies', () => {
  const api = 'https://playpen.example/api/';
  const record = {
    method: 'POST', url: api + 'flows/example/segments?limit=1&offset=2',
    headers: { 'content-type': 'application/json', 'x-label': "director's notes" },
    body: [{ label: "It's called \"News\".", path: 'A\\B' }],
  };
  expect(parseCurl(curlCommand(record), api)).toMatchObject({
    method: record.method, url: record.url, headers: record.headers, data: JSON.stringify(record.body),
  });
  expect(() => parseCurl('curl https://another.example/api/sources', api)).toThrow('Choose a URL');
  expect(() => parseCurl("curl -d 'unfinished", api)).toThrow('quoted');
  expect(() => parseCurl('curl -L /api/sources', api)).toThrow('Unsupported');
});

test('resource clicks, curl completion and live requests use the current workspace', async ({ page }) => {
  await page.goto('/');
  const prompt = page.locator('#terminal-command'), output = page.locator('#terminal-output');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  await expect(page.locator('details.panel[open]')).toHaveCount(5);
  await expect(page.locator('#terminal')).not.toHaveAttribute('open', '');
  await page.locator('.concepts summary').click();
  await page.getByRole('button', { name: 'Close glossary' }).click();
  await expect(page.locator('.concepts summary')).toBeFocused();

  await page.locator('#new-source').click();
  await page.locator('#entity-name').fill('Terminal test');
  await page.locator('#dialog-submit').click();
  await page.locator('#source-details summary').click();
  const source = page.locator('#source-id button');
  await source.click(); await expect(source).toBeFocused();
  await expect(page.locator('#terminal')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(page.getByText('playpen:~$', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'curl command' })).toBeVisible();
  const id = (await source.textContent())!;
  const root = await page.locator('#sources').inputValue();
  await expect(prompt).toHaveValue(new RegExp('/api/sources/' + id));
  await prompt.press('Enter');
  await expect(output).toContainText('HTTP 200');
  await expect(output).toContainText(id);

  await prompt.fill('curl -X P'); await prompt.press('Tab');
  await page.locator('#terminal-options').getByText('PUT', { exact: true }).click();
  await expect(prompt).toHaveValue('curl -X PUT ');
  await prompt.fill('curl --hea'); await prompt.press('Tab');
  await page.locator('#terminal-options').getByText('--header', { exact: true }).click();
  await expect(prompt).toHaveValue('curl --header ');
  await prompt.fill('curl -X GET /api/sources/' + id.slice(0, 6)); await prompt.press('Tab');
  await expect(prompt).toHaveValue('curl -X GET /api/sources/' + id + ' ');

  const label = "Today's edit";
  const cmd = curlCommand({ method: 'PUT', url: new URL('/api/flows/' + root + '/label', page.url()).href, headers: { 'content-type': 'application/json' }, body: label });
  await prompt.fill(cmd); await prompt.press('Enter');
  await expect(page.locator('#source-title')).toHaveText(label);
  await expect(output).toContainText(/HTTP 20\d/);
  await page.locator('#action-history').selectOption({ label: 'Terminal PUT' });
  const row = page.locator('#requests button').first();
  await row.click();
  await expect(prompt).toHaveValue(cmd); await expect(row).toBeFocused();

  await prompt.fill('curl /api/flows/' + root + '/label'); await prompt.press('Enter');
  await expect(output).toContainText(label);
  await prompt.fill('curl /api/sources/00000000-0000-4000-a000-000000000000'); await prompt.press('Enter');
  await expect(output).toContainText('HTTP 404');

  await prompt.fill('curl -X PUT --data-binary @sample.ts /media/example');
  const chooser = page.waitForEvent('filechooser');
  await prompt.press('Enter'); await chooser;
  await page.locator('#terminal-file').dispatchEvent('cancel');
  await expect(output).toHaveText('Upload canceled.');
  await expect(prompt).toHaveValue(/@sample.ts/);

  // A background action must leave an edited command intact.
  await prompt.fill('curl -X ');
  await page.locator('#rename-source').click();
  await page.locator('#entity-name').fill('Renamed from UI'); await page.locator('#dialog-submit').click();
  await expect(page.locator('#source-title')).toHaveText('Renamed from UI');
  await expect(prompt).toHaveValue('curl -X ');

  await page.locator('#add-video').click();
  await page.locator('#entity-name').fill('Unsaved lane'); await page.locator('#dialog-submit').click();
  await prompt.fill(curlCommand({ method: 'PUT', url: new URL('/api/sources/' + id + '/description', page.url()).href, headers: { 'content-type': 'application/json' }, body: 'Edited in Terminal' }));
  await prompt.press('Enter');
  await expect(output).toContainText(/HTTP 20\d/);
  await expect(page.locator('.lane-header')).toContainText('Unsaved lane');
  await expect(page.locator('#draft-status')).toContainText('Unsaved changes');

  await page.locator('.preview-panel > summary').click();
  await page.locator('#tour-playpen').click();
  await expect(page.locator('details.panel[open]')).toHaveCount(0);
  await page.locator('.tour-next').click();
  await expect(page.locator('.tour-result')).toContainText('Your example has its own source');
  await expect(page.locator('.timeline-panel')).toHaveAttribute('open', '');
  await page.locator('.tour-close').click();
  await expect(page.locator('.preview-panel')).not.toHaveAttribute('open', '');
  await expect(page.locator('#terminal')).toHaveAttribute('open', '');
});

test('binary curl uploads use the chosen bytes and support HEAD and range reads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 });
  const flow = await page.evaluate(async () => {
    const id = crypto.randomUUID();
    const response = await fetch('/api/flows/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, source_id: crypto.randomUUID(), format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'video/mp2t', essence_parameters: { sample_rate: 48000, channels: 2 } }) });
    if (!response.ok) throw new Error(await response.text());
    return id;
  });
  await page.locator('#terminal summary').click();
  const prompt = page.locator('#terminal-command'), output = page.locator('#terminal-output');
  await prompt.fill('curl -X POST -H "content-type: application/json" --data \'{"object_ids":["file / test"]}\' /api/flows/' + flow + '/storage');
  await prompt.press('Enter');
  await expect(output).toContainText('HTTP 201');
  const allocation = JSON.parse((await output.textContent())!.split('\n').slice(1).join('\n')).media_objects[0];
  const put = allocation.put_url;
  await prompt.fill(curlCommand({ method: 'PUT', url: put.url, headers: { 'content-type': put['content-type'] }, body: { file: 'audio sample.ts', bytes: 6 } }));
  await page.locator('#storage > summary').click();
  const chooser = page.waitForEvent('filechooser');
  await prompt.press('Enter');
  await (await chooser).setFiles({ name: 'audio sample.ts', mimeType: put['content-type'], buffer: Buffer.from('abcdef') });
  await expect(output).toHaveText('HTTP 200');
  await expect(page.locator('#storage')).toHaveJSProperty('open', true);

  await prompt.fill('curl -I "' + put.url + '"'); await prompt.press('Enter');
  await expect(output).toContainText('"content-length": "6"');
  await prompt.fill('curl -H "range: bytes=1-3" "' + put.url + '"'); await prompt.press('Enter');
  await expect(output).toContainText('HTTP 206');
  await expect(output).toContainText('"bytes": 3');

  await page.locator('#action-history').selectOption({ label: 'Terminal PUT' });
  await page.locator('#review-requests').click();
  await page.locator('#review-requests-list button').first().click();
  await page.locator('#review-close').click();
  await expect(prompt).toHaveValue(/--data-binary '@audio sample\.ts'/);
  await page.locator('#storage > summary').click();
  await prompt.fill(curlCommand({ method: 'POST', url: new URL('/api/flows/' + flow + '/segments', page.url()).href,
    headers: { 'content-type': 'application/json' }, body: { object_id: allocation.object_id, timerange: '[0:0_1:0)' } }));
  await prompt.press('Enter');
  await expect(output).toContainText('HTTP 201');
  await expect(page.locator('#storage')).toHaveJSProperty('open', true);
  await prompt.fill('curl -X DELETE /api/flows/' + flow); await prompt.press('Enter');
  await expect(output).toContainText('HTTP 202');
});
