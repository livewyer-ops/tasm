// Runs the browser build's Rust core and SQL against PGlite in Node, through the
// same SQL bridge as core/browser/runtime.ts, so SQL and row decoding bugs fail
// here in seconds rather than in the browser suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import init, { Tasm } from '../pkg/browser/tasm.js';
import schema from '../core/browser/migrations/001.sql';
import { SqlHost, createSchema, pgliteParsers } from '../core/browser/sql-host';

const backend = '81d13d58-5041-4580-91f9-38ce03daef19';
const origin = 'http://tasm.test';
const videoFlow = { format: 'urn:x-nmos:format:video', codec: 'video/h264', container: 'video/mp2t',
  essence_parameters: { frame_width: 1920, frame_height: 1080, frame_rate: { numerator: 25, denominator: 1 } } };

type Stored = { size: number; contentType: string; checksum: string };
type Response = { status: number; headers: Record<string, string>; body: string };

async function store() {
  const db = new PGlite({ parsers: pgliteParsers });
  await createSchema(db, schema, [{ id: backend, label: 'Browser storage' }]);
  const sql = new SqlHost(db);
  // In-memory stand-in for OPFS: bytes are never read, only their metadata.
  const files = new Map<string, Stored>();
  const key = (b: string, id: string) => `${b}/${id}`;
  const bridge = async (op: string, payload: string): Promise<string> => {
    const p = JSON.parse(payload);
    if (sql.handles(op)) return JSON.stringify(await sql.call(op, p));
    switch (op) {
      case 'url': return JSON.stringify(`${origin}/media/${p.backend}?object_id=${encodeURIComponent(p.id)}`);
      case 'head': {
        const file = files.get(key(p.backend, p.id));
        return JSON.stringify(file ? { size: file.size, contentType: file.contentType, etag: `"${file.checksum}"`, checksum: file.checksum } : null);
      }
      case 'delete':
        for (const { object_id } of p.allocations) files.delete(key(p.backend, object_id));
        return 'null';
      case 'copy': {
        const file = files.get(key(p.source, p.id));
        if (!file) throw new Error('Copy source is missing.');
        files.set(key(p.destination, p.id), file);
        return 'null';
      }
      case 'webhook': return JSON.stringify({ status: 200, reason: 'OK', redirected: false });
      default: throw new Error(`Unknown host operation ${op}`);
    }
  };
  const core = new Tasm(bridge, `${origin}/media/`);
  const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const response = JSON.parse(await core.request(JSON.stringify({ method, url: origin + path,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body) }))) as Response;
    await sql.drained();
    return response;
  };
  const upload = (id: string) => files.set(key(backend, id), { size: 188, contentType: 'video/mp2t', checksum: 'a'.repeat(64) });
  return { db, sql, core, request, upload, files };
}

await init({ module_or_path: readFileSync('pkg/browser/tasm_bg.wasm') });

test('the SQL bridge returns columns by position, keeps exact integers and rolls back', async () => {
  const { db, sql } = await store();
  const duplicate = await sql.call('sql', { sql: 'SELECT MIN(x::numeric), MIN(y) FROM (VALUES (100, $1), (200, $2)) t(x, y)',
    params: [{ type: 'text', value: '[0:100_0:200)' }, { type: 'text', value: '[0:200_0:300)' }] }) as { rows: unknown[][] };
  assert.deepEqual(duplicate.rows, [['100', '[0:100_0:200)']]);
  const empty = await sql.call('sql', { sql: 'SELECT COUNT(*), MIN(timerange_start) FROM tamoss_segments', params: [] }) as { rows: unknown[][] };
  assert.deepEqual(empty.rows, [['0', null]]);
  const big = await sql.call('sql', { sql: "SELECT $1::numeric + 1, '{\"n\":9007199254740993}'::jsonb", params: [{ type: 'numeric', value: '9007199254740992000000000' }] }) as { rows: unknown[][] };
  assert.deepEqual(big.rows, [['9007199254740992000000001', '{"n": 9007199254740993}']]);
  // A failing statement inside a transaction: the host rolls back and stays usable.
  const id = crypto.randomUUID();
  const insert = { sql: "INSERT INTO tamoss_sources(id,format,record,metadata_updated,created) VALUES($1,'urn:x-nmos:format:video','{}',NOW(),NOW())", params: [{ type: 'uuid', value: id }] };
  await sql.call('begin', {});
  await sql.call('sql', insert);
  await assert.rejects(sql.call('sql', insert), /duplicate key/);
  await sql.call('rollback', {});
  assert.equal(sql.inTransaction, false);
  assert.equal((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM tamoss_sources')).rows[0].n, 0);
  assert.deepEqual((await sql.call('sql', { sql: 'SELECT 1', params: [] }) as { rows: unknown[][] }).rows, [[1]]);
});

test('flows, segments, filters and asynchronous deletion work against PGlite', async () => {
  const { request, upload, core, files } = await store();
  const sourceId = crypto.randomUUID(), flowId = crypto.randomUUID(), collectionId = crypto.randomUUID();
  const created = await request('PUT', `/flows/${flowId}`, `{"id":"${flowId}","source_id":"${sourceId}","format":"urn:x-nmos:format:video","codec":"video/h264","container":"video/mp2t","avg_bit_rate":9007199254740993,"essence_parameters":{"frame_width":1920,"frame_height":1080,"frame_rate":{"numerator":25,"denominator":1}}}`);
  assert.equal(created.status, 201, created.body);
  assert.match((await request('GET', `/flows/${flowId}`)).body, /"avg_bit_rate":9007199254740993\b/);

  const allocation = await request('POST', `/flows/${flowId}/storage`, { limit: 3 });
  assert.equal(allocation.status, 201, allocation.body);
  const ids = (JSON.parse(allocation.body).media_objects as { object_id: string }[]).map(o => o.object_id);
  ids.forEach(upload);
  const registered = await request('POST', `/flows/${flowId}/segments`, ids.map((object_id, i) => ({ object_id, timerange: `[${i * 2}:0_${i * 2 + 2}:0)` })));
  assert.equal(registered.status, 201, registered.body);

  // The populated summary is the query whose duplicate MIN() labels broke the browser build.
  const all = await request('GET', `/flows/${flowId}/segments`);
  assert.equal(all.status, 200, all.body);
  assert.equal(JSON.parse(all.body).length, 3);
  assert.equal(all.headers['x-paging-timerange'], '[0:0_6:0)');
  const first = await request('GET', `/flows/${flowId}/segments?limit=2`);
  assert.equal(JSON.parse(first.body).length, 2);
  assert.match(first.headers.link ?? '', /rel="next"/);
  const filtered = await request('GET', `/flows/${flowId}/segments?timerange=[2:0_4:0)`);
  assert.deepEqual(JSON.parse(filtered.body).map((s: { object_id: string }) => s.object_id), [ids[1]]);
  assert.equal(filtered.headers['x-paging-timerange'], '[2:0_4:0)');
  const overlap = await request('POST', `/flows/${flowId}/segments`, { object_id: ids[0], timerange: '[1:0_3:0)' });
  assert.equal(overlap.status, 400, overlap.body);

  assert.equal((await request('PUT', `/flows/${collectionId}`, { ...videoFlow, id: collectionId, source_id: crypto.randomUUID(),
    flow_collection: [{ id: flowId, role: 'video' }] })).status, 201);
  const inRange = await request('GET', '/flows?timerange=[1:0_2:0)');
  assert.ok(JSON.parse(inRange.body).some((f: { id: string }) => f.id === flowId), inRange.body);
  assert.equal(JSON.parse((await request('GET', '/flows?timerange=[10:0_11:0)')).body).some((f: { id: string }) => f.id === flowId), false);
  const collected = await request('GET', `/sources?collected_by_ids=${JSON.parse((await request('GET', `/flows/${collectionId}`)).body).source_id}`);
  assert.equal(collected.status, 200, collected.body);
  assert.deepEqual(JSON.parse(collected.body).map((s: { id: string }) => s.id), [sourceId]);

  assert.equal((await request('DELETE', `/flows/${collectionId}`)).status, 204);
  const deletion = await request('DELETE', `/flows/${flowId}`);
  assert.equal(deletion.status, 202, deletion.body);
  const requestId = JSON.parse(deletion.body).id;
  for (let attempt = 0; attempt < 5 && (await request('GET', `/flows/${flowId}`)).status !== 404; attempt++) await core.poll();
  assert.equal((await request('GET', `/flows/${flowId}`)).status, 404);
  assert.equal(JSON.parse((await request('GET', `/flow-delete-requests/${requestId}`)).body).status, 'done');
  for (let attempt = 0; attempt < 5 && files.size; attempt++) await core.poll();
  assert.equal(files.size, 0, 'cleanup removes the deleted flow\'s objects');
});

test('flow timeranges cover own segments and collection members', async () => {
  const { request, upload } = await store();
  const put = async (extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    assert.equal((await request('PUT', `/flows/${id}`, { ...videoFlow, id, source_id: crypto.randomUUID(), ...extra })).status, 201);
    return id;
  };
  const segments = async (id: string, timeranges: string[]) => {
    const allocated = await request('POST', `/flows/${id}/storage`, { limit: timeranges.length });
    const objects = (JSON.parse(allocated.body).media_objects as { object_id: string }[]).map(o => o.object_id);
    objects.forEach(upload);
    const registered = await request('POST', `/flows/${id}/segments`, objects.map((object_id, i) => ({ object_id, timerange: timeranges[i] })));
    assert.equal(registered.status, 201, registered.body);
  };
  const timerange = async (id: string, query = '') => JSON.parse((await request('GET', `/flows/${id}?include_timerange=true${query}`)).body).timerange;
  const a = await put(), b = await put(), none = await put();
  await segments(a, ['[0:0_2:0)', '[2:0_4:0)']);
  await segments(b, ['[10:0_12:0)']);
  const both = await put({ flow_collection: [{ id: a, role: 'a' }, { id: b, role: 'b' }] });
  const shared = await put({ flow_collection: [{ id: b, role: 'b' }] });
  await segments(both, ['[20:0_21:0)']);
  assert.equal(await timerange(a), '[0:0_4:0)');
  assert.equal(await timerange(both), '[0:0_21:0)');
  assert.equal(await timerange(shared), '[10:0_12:0)');
  assert.equal(await timerange(none), '()');
  // Bounds select whole segments: a partial overlap reports the segment's full range.
  assert.equal(await timerange(a, '&timerange=[3:0_5:0)'), '[2:0_4:0)');
  assert.equal(await timerange(a, '&timerange=[4:0_5:0)'), '()');
  assert.equal(await timerange(a, '&timerange=[1:0_3:0)'), '[0:0_4:0)');
  assert.equal(await timerange(a, '&timerange=[2:0]'), '[2:0_4:0)');
  assert.equal(await timerange(a, '&timerange=[2:0_'), '[2:0_4:0)');
  assert.equal(await timerange(a, '&timerange=_2:0)'), '[0:0_2:0)');
  assert.equal(await timerange(a, '&timerange=()'), '()');
  assert.equal(await timerange(both, '&timerange=[3:0_11:0)'), '[2:0_12:0)');
  const listed = JSON.parse((await request('GET', '/flows?include_timerange=true&limit=1000')).body) as { id: string; timerange: string }[];
  const ranges = Object.fromEntries(listed.map(flow => [flow.id, flow.timerange]));
  assert.deepEqual([a, b, both, shared, none].map(id => ranges[id]), ['[0:0_4:0)', '[10:0_12:0)', '[0:0_21:0)', '[10:0_12:0)', '()']);
});
