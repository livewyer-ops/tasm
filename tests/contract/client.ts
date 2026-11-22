import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Ajv, { type AnySchema } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

type Contract = { paths: Record<string, Record<string, {
  responses: Record<string, { content?: Record<string, { schema: AnySchema }> }>;
}>> };
type ApiRequest = { path: string; method: string; body?: string };
type MediaRequest = { url: string; method: 'GET' | 'PUT'; headers?: Record<string, string>; bytes?: number[] };
export interface ContractHost {
  /** Absolute URL of the API root, including any host-specific path prefix. */
  apiRoot: string;
  request(input: ApiRequest): Promise<{ status: number; headers: Record<string, string>; text: string }>;
  media(input: MediaRequest): Promise<{ status: number; bytes: number[] }>;
  webhookURL: string;
  observedFlowCreated(flow: string): Promise<boolean>;
  /** Advance host-managed queues or the retention clock during asynchronous assertions. */
  progressQueues?(): Promise<void>;
}

const audio = { format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'video/mp2t',
  essence_parameters: { sample_rate: 48000, channels: 2 } };

export async function runContract(spec: Contract, host: ContractHost) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const covered = new Set<string>();
  const paths = Object.keys(spec.paths).map(path => ({
    path, pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  }));
  async function request(path: string, method: string, body?: string, expected = 200) {
    if (process.env.TASM_TRACE) console.log(method, path);
    const result = await host.request({ path, method, body });
    const template = paths.find(({ pattern }) => pattern.test(path.split('?')[0]))?.path;
    assert.ok(template, `${method} ${path} exists in the TAMS contract`);
    const key = `${method} ${template}`;
    const operation = spec.paths[template][method.toLowerCase()];
    assert.ok(operation, key);
    assert.equal(result.status, expected, `${method} ${path} returned ${result.status}: ${result.text}`);
    const response = operation.responses[result.status];
    assert.ok(response, `${key} response ${result.status}`);
    const schema = response.content?.['application/json']?.schema;
    const context = `${key} ${result.status}`;
    let value;
    if (method === 'HEAD' || result.status === 204) {
      assert.equal(result.text, '', `${context} must have an empty body`);
    } else if (schema !== undefined || result.status >= 400) {
      assert.ok(result.text.length, `${context} requires a response body`);
      assert.match(result.headers['content-type'] ?? '', /^application\/json(?:\s*;|$)/i, context);
      value = JSON.parse(result.text);
      if (schema !== undefined) {
        const validate = ajv.getSchema(context) ?? ajv.addSchema(schema, context).getSchema(context)!;
        assert.ok(validate(value), `${context}: ${ajv.errorsText(validate.errors)}`);
      } else {
        for (const name of ['type', 'summary', 'time']) assert.equal(typeof value?.[name], 'string', `${context} ${name}`);
      }
    } else {
      assert.equal(result.text, '', `${context} has no documented response body`);
    }
    covered.add(key);
    return { ...result, value };
  }
  function call(path: string, method = 'GET', body?: unknown, expected = 200) {
    return request(path, method, JSON.stringify(body), expected);
  }
  async function get(path: string) {
    const result = await call(path);
    await call(path, 'HEAD');
    return result;
  }
  async function until(description: string, condition: () => Promise<boolean>) {
    // Queue processing includes durable writes, especially on WebKit.
    const deadline = Date.now() + 30000;
    do {
      await host.progressQueues?.();
      if (await condition()) return;
      await delay(150);
    } while (Date.now() < deadline);
    assert.fail(`Timed out waiting for ${description}`);
  }
  const apiRoot = host.apiRoot.replace(/\/?$/, '/');
  await get('/'); await get('/service');
  await call('/service', 'POST', { name: 'Contract test', description: 'Contract test store' });
  assert.equal((await get('/service')).value.name, 'Contract test');
  const backends: { id: string; label: string; default_storage?: boolean }[] = (await get('/service/storage-backends')).value;
  assert.equal(backends.length, 2);
  const secondary = backends.find(backend => !backend.default_storage);
  assert.ok(secondary && backends.some(backend => backend.default_storage), 'expected primary and secondary storage');
  const profile = randomUUID();
  await call(`/service/profiles/${profile}`, 'POST', { id: profile, label: 'AAC', flow_metadata: audio }, 201);
  await get('/service/profiles'); await get(`/service/profiles/${profile}`);
  const mappingId = randomUUID();
  const invalidMapping = { mp2ts_container: { pid: '100' } };
  await call(`/service/profiles/${mappingId}`, 'POST', { id: mappingId, flow_metadata: { ...audio, container_mapping: invalidMapping } }, 400);
  await call(`/service/profiles/${mappingId}`, 'GET', undefined, 404);
  await call(`/flows/${mappingId}`, 'PUT', { ...audio, id: mappingId, source_id: randomUUID(),
    container_mapping: { mxf_container: { package_uid: 'not a UMID' } } }, 400);
  await call(`/flows/${mappingId}`, 'GET', undefined, 404);
  const hook = await call('/service/webhooks', 'POST', {
    url: host.webhookURL, events: ['flows/created'] }, 201);
  const webhookId = hook.value.id;
  await get('/service/webhooks'); await get(`/service/webhooks/${webhookId}`);
  const flow = randomUUID(), source = randomUUID(), other = randomUUID();
  await call(`/flows/${flow}`, 'PUT', { id: flow, source_id: source, ...audio }, 201);
  await call(`/flows/${other}`, 'PUT', { id: other, source_id: randomUUID(), ...audio }, 201);
  await get('/flows'); await get(`/flows/${flow}`); await get('/sources'); await get(`/sources/${source}`);
  // These source and flow mutations exercise transaction commit and reuse.
  for (const entity of [`/flows/${flow}`, `/sources/${source}`]) {
    for (const field of ['description', 'label']) {
      await call(`${entity}/${field}`, 'PUT', `A ${field}`, 204);
      assert.equal((await get(`${entity}/${field}`)).value, `A ${field}`);
      await call(`${entity}/${field}`, 'DELETE', undefined, 204);
    }
    const tag = `${entity}/tags/${encodeURIComponent('producer / %2F')}`;
    await call(tag, 'PUT', ['Alice', 'Bob'], 204); await get(`${entity}/tags`); await get(tag);
    await call(tag, 'DELETE', undefined, 204);
  }
  for (const field of ['max_bit_rate', 'avg_bit_rate']) {
    await call(`/flows/${flow}/${field}`, 'PUT', 128, 204); await get(`/flows/${flow}/${field}`);
    const path = `/flows/${flow}/${field}`;
    await request(path, 'PUT', '9007199254740993', 204);
    assert.equal((await call(path)).text, '9007199254740993');
    await call(`/flows/${flow}/${field}`, 'DELETE', undefined, 204);
  }
  await call(`/flows/${flow}/flow_collection`, 'PUT', [{ id: other, role: 'alternative' }], 204);
  await get(`/flows/${flow}/flow_collection`);
  await call(`/flows/${flow}/flow_collection`, 'DELETE', undefined, 204);
  await call(`/flows/${flow}/read_only`, 'PUT', true, 204); await get(`/flows/${flow}/read_only`);
  await call(`/flows/${flow}/label`, 'PUT', 'forbidden', 403);
  await call(`/flows/${flow}/read_only`, 'PUT', false, 204);
  await call(`/flows/${flow}/flow_collection`, 'PUT', [{ id: other,
    container_mapping: { isobmff_container: { track_id: '1' } } }], 400);
  // Rejected transaction must leave the connection usable.
  await call(`/flows/${flow}/flow_collection`, 'PUT', [{ id: flow }], 400);
  await call(`/flows/${flow}/label`, 'PUT', 'still writable', 204);
  const objectId = `contract /${flow}/%2F/media.bin`;
  const objectPath = `/objects/${encodeURIComponent(objectId)}`;
  const allocated = await call(`/flows/${flow}/storage`, 'POST', { object_ids: [objectId] }, 201);
  const put = allocated.value.media_objects[0].put_url;
  const bytes = [0, 97, 128, 255, 13, 10];
  const headers = new Headers(put.headers);
  if (!headers.has('content-type') && put['content-type']) headers.set('content-type', put['content-type']);
  const write = await host.media({ url: put.url, method: 'PUT', headers: Object.fromEntries(headers), bytes });
  assert.equal(write.status, 200, 'upload to the allocated storage URL');
  const timerange = '[281474976710654:0_281474976710655:999999999)';
  await call(`/flows/${flow}/segments`, 'POST', { object_id: objectId, timerange }, 201);
  const segments = await get(`/flows/${flow}/segments`);
  assert.equal(segments.value[0].timerange, timerange);
  const primaryURL = segments.value[0].get_urls[0].url;
  const read = await host.media({ url: primaryURL, method: 'GET' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.bytes, bytes);
  await get(objectPath);
  await call(`/flows/${other}/segments`, 'POST', { object_id: objectId, timerange }, 201);
  const firstPage = await call(`${objectPath}?limit=1`);
  assert.equal(firstPage.value.referenced_by_flows.length, 1);
  const link = /^<([^>]+)>/.exec(firstPage.headers.link);
  assert.ok(link, 'expected a next-page Link');
  const next = new URL(link[1], apiRoot);
  assert.equal(next.origin + next.pathname, new URL(objectPath.slice(1), apiRoot).href);
  const nextPage = await call(objectPath + next.search);
  assert.equal(nextPage.value.referenced_by_flows.length, 1);
  assert.notDeepEqual(nextPage.value.referenced_by_flows, firstPage.value.referenced_by_flows);
  await call(`${objectPath}/instances`, 'POST', { storage_id: secondary.id }, 201);
  // Hosts may return several URLs per instance (Cloudflare adds a presigned one), so wait for the label.
  await until('a secondary storage instance', async () => (await call(objectPath)).value.get_urls
    .some((entry: { label: string }) => entry.label === secondary.label));
  const copied = (await call(objectPath)).value.get_urls.find((entry: { label: string }) => entry.label === secondary.label);
  assert.ok(copied, 'expected a read URL for the secondary');
  const copy = await host.media({ url: copied.url, method: 'GET' });
  assert.equal(copy.status, 200);
  assert.deepEqual(copy.bytes, bytes);
  await call(`${objectPath}/instances?storage_id=${secondary.id}`, 'DELETE', undefined, 204);
  await until('secondary media deletion', async () => (await host.media({ url: copied.url, method: 'GET' })).status === 404);
  await until('flows/created for the test flow', () => host.observedFlowCreated(flow));
  await call(`/service/webhooks/${webhookId}`, 'PUT', { ...hook.value, status: 'disabled' }, 201);
  await call(`/service/webhooks/${webhookId}`, 'DELETE', undefined, 204);
  const deleted = await call(`/flows/${flow}/segments`, 'DELETE', undefined, 202);
  const deletePath = `/flow-delete-requests/${deleted.value.id}`;
  assert.ok(deleted.headers.location, 'expected deletion request Location');
  assert.equal(new URL(deleted.headers.location, apiRoot).href, new URL(deletePath.slice(1), apiRoot).href);
  await get('/flow-delete-requests');
  await get(deletePath);
  await until('segment deletion request', async () => (await call(deletePath)).value.status === 'done');
  assert.deepEqual((await call(`/flows/${flow}/segments`)).value, []);
  await call(`/flows/${flow}`, 'DELETE', undefined, 204);
  await call(`/flows/${other}/segments?object_id=${encodeURIComponent(objectId)}`, 'DELETE', undefined, 204);
  await until('primary media deletion', async () => (await host.media({ url: primaryURL, method: 'GET' })).status === 404);
  const methods = ['get', 'head', 'put', 'post', 'delete', 'patch', 'options', 'trace'];
  const expected = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item).filter(method => methods.includes(method)).map(method => `${method.toUpperCase()} ${path}`));
  const operations = [...covered].sort();
  assert.deepEqual(operations, expected.sort(), 'TAMS operation coverage');
  return { operations, remainingFlow: other };
}
