import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { createTestHarness } from 'wrangler';
import type { Bindings } from './worker.ts';

export const distribution = resolve(process.env.TASM_DIST ?? 'dist', 'cloudflare');
export const apiConfigPath = resolve(distribution, 'api/wrangler.json');
export const issuerConfigPath = resolve(distribution, 'auth/wrangler.json');
export const apiConfig = JSON.parse(readFileSync(apiConfigPath, 'utf8'));
apiConfig.main = resolve(distribution, "api", apiConfig.main);
apiConfig.base_dir = resolve(distribution, "api");
export const verifier = { binding: 'AUTH', service: 'cf-tams-auth', entrypoint: 'TokenVerifier' };

type Harness = ReturnType<typeof createTestHarness>;
type Api = Pick<ReturnType<Harness['getWorker']>, 'fetch'> & { getEnv(): Promise<Bindings> };
export async function checkMedia(api: Api, authorization: string) {
  const id = crypto.randomUUID(), object = `checks/${id}/literal%2F.ts`;
  const path = `/flows/${id}`;
  const request = (route: string, method = 'GET', data?: unknown) => api.fetch('https://store.example' + route, {
    method, headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  const fixture = JSON.parse(readFileSync(new URL('./video-flow.test.json', import.meta.url), 'utf8'));
  assert.equal((await request(path, 'PUT', { ...fixture, id, source_id: crypto.randomUUID() })).status, 201);
  const allocation = await (await request(path + '/storage', 'POST', { object_ids: [object] })).json() as { media_objects: { put_url: { url: string } }[] };
  const key = new URL(allocation.media_objects[0].put_url.url).pathname.split('/').slice(2).join('/');
  const segment = { object_id: object, timerange: '[10000000000:1_10000000000:2)' };
  assert.equal((await request(path + '/segments', 'POST', segment)).status, 400);
  const { MEDIA } = await api.getEnv();
  const bytes = new Uint8Array(2_000_000).fill(57);
  await MEDIA.put(key, bytes, { httpMetadata: { contentType: 'video/mp2t' } });
  const results = await Promise.all([request(path + '/segments', 'POST', segment), request(path + '/segments', 'POST', segment)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
  const list = await (await request(path + '/segments?presigned=true&timerange=' + encodeURIComponent(segment.timerange))).json() as { object_id: string; get_urls: { url: string }[] }[];
  assert.equal(list.length, 1);
  assert.equal(list[0].object_id, object);
  const readKey = new URL(list[0].get_urls[0].url).pathname.split('/').slice(2).join('/');
  assert.deepEqual(new Uint8Array(await (await MEDIA.get(readKey))!.arrayBuffer()), bytes);
  assert.equal((await request('/objects/' + encodeURIComponent(object))).status, 200);
  assert.equal((await request('/objects/' + encodeURIComponent(object.replace('%2F', '/')))).status, 404);
  assert.equal((await request(path, 'DELETE')).status, 202);
}
