// Runs the browser build's Rust core and SQL against PGlite in Node, through the
// same SQL bridge as core/browser/runtime.ts, so SQL and row decoding bugs fail
// here in seconds rather than in the browser suite.
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { checkLegacyRanges } from './contract/legacy-ranges';
import { checkUuidFilters } from './contract/uuid-filters';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import init, { Tasm } from '../pkg/browser/tasm.js';
import schema from '../core/browser/migrations/001.sql';
import { migrateSchema } from '../core/browser/migrations';
import { SqlHost, pgliteParsers } from '../core/browser/sql-host';

const backend = '81d13d58-5041-4580-91f9-38ce03daef19';
const origin = 'http://tasm.test';
const videoFlow = { format: 'urn:x-nmos:format:video', codec: 'video/h264', container: 'video/mp2t',
  essence_parameters: { frame_width: 1920, frame_height: 1080, frame_rate: { numerator: 25, denominator: 1 } } };

type Stored = { size: number; contentType: string; checksum: string };
type Response = { status: number; headers: Record<string, string>; body: string };

async function store() {
  const db = new PGlite({ parsers: pgliteParsers });
  await migrateSchema(db, [{ id: backend, label: 'Browser storage' }]);
  const sql = new SqlHost(db);
  // In-memory stand-in for OPFS: bytes are never read, only their metadata.
  const files = new Map<string, Stored>();
  const deliveries: { url: string; event: string }[] = [];
  const key = (b: string, id: string) => `${b}/${id}`;
  // Counts the queries the core runs and the rows the database returns to it.
  const returned = { queries: 0, rows: 0 };
  const bridge = async (op: string, payload: string): Promise<string> => {
    const p = JSON.parse(payload);
    if (sql.handles(op)) {
      const result = await sql.call(op, p) as { rows?: unknown[] } | undefined;
      if (op === 'sql') returned.queries++;
      returned.rows += result?.rows?.length ?? 0;
      return JSON.stringify(result);
    }
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
      case 'webhook':
        deliveries.push({ url: p.webhook.url, event: JSON.parse(p.payload_json).event_type });
        return JSON.stringify({ status: 200, reason: 'OK', redirected: false });
      default: throw new Error(`Unknown host operation ${op}`);
    }
  };
  const restart = () => new Tasm(bridge, `${origin}/media/`);
  const core = restart();
  const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const response = JSON.parse(await core.request(JSON.stringify({ method, url: origin + path,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body) }))) as Response;
    await sql.drained();
    return response;
  };
  const upload = (id: string) => files.set(key(backend, id), { size: 188, contentType: 'video/mp2t', checksum: 'a'.repeat(64) });
  return { db, sql, core, restart, request, upload, files, deliveries, returned };
}

await init({ module_or_path: readFileSync('pkg/browser/tasm_bg.wasm') });

test('a populated browser v1 store upgrades atomically and rejects newer versions', async t => {
  const original = new PGlite();
  await original.exec(schema);
  await original.query(`INSERT INTO tamoss_storage_backends(id,label,provider,region,store_product,default_storage,record)
    VALUES ($1,'Original backend','browser','local','tasm-opfs',true,'{}')`, [backend]);
  const flow = crypto.randomUUID(), job = crypto.randomUUID();
  await original.query("INSERT INTO tamoss_flows(id,record,metadata_updated,created) VALUES($1,'{}',NOW(),NOW())", [flow]);
  await original.query("INSERT INTO tamoss_segments(flow_id,object_id,timerange,timerange_start,timerange_end,record,created) VALUES($1,'clip','[0:0_1:0)',0,1000000000,'{}',NOW())", [flow]);
  await original.query("INSERT INTO tamoss_media_objects(id,first_referenced_by_flow,referenced_by_flows,record) VALUES('clip',$1,ARRAY[($1::uuid)::text],'{}')", [flow]);
  await original.query("INSERT INTO tasm_files VALUES($1,'clip','clip.bin','original',188,'video/mp2t','sha256','md5')", [backend]);
  await original.query("INSERT INTO tamoss_object_cleanups(id,object_id,storage_backend_id,status,record,updated) VALUES($1,'clip',$2,'pending','{}',NOW())", [job, backend]);
  const snapshot = await original.dumpDataDir();
  await original.close();

  const db = new PGlite({ loadDataDir: snapshot });
  t.after(() => db.close());
  const open = () => migrateSchema(db, [{ id: backend, label: 'Changed default' }]);
  // Fail the version write after the DDL so both must roll back together.
  await db.exec(`CREATE FUNCTION fail_version() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'interrupted migration'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER interrupt BEFORE UPDATE ON tasm_schema FOR EACH ROW EXECUTE FUNCTION fail_version()`);
  await assert.rejects(open(), /interrupted migration/);
  const state = () => db.query("SELECT version,to_regclass('idx_tamoss_unfinished_cleanup') IS NOT NULL AS indexed FROM tasm_schema").then(r => r.rows);
  assert.deepEqual(await state(), [{ version: 1, indexed: false }]);
  await db.exec("DROP TRIGGER interrupt ON tasm_schema");
  await open();
  await open();
  assert.deepEqual(await state(), [{ version: 2, indexed: true }]);
  const saved = await db.query(`SELECT s.flow_id, s.object_id, s.timerange, f.name, b.label, q.id, q.status
    FROM tamoss_segments s JOIN tamoss_media_objects m ON m.id=s.object_id AND m.first_referenced_by_flow=s.flow_id
    JOIN tasm_files f ON f.object_id=m.id JOIN tamoss_storage_backends b ON b.id=f.backend
    JOIN tamoss_object_cleanups q ON q.object_id=m.id`);
  assert.deepEqual(saved.rows, [{ flow_id: flow, object_id: 'clip', timerange: '[0:0_1:0)', name: 'clip.bin', label: 'Original backend', id: job, status: 'pending' }]);

  await db.exec("UPDATE tasm_schema SET version=99");
  await assert.rejects(open(), /Unsupported TASM database version/);
  assert.deepEqual(await state(), [{ version: 99, indexed: true }]);
  await db.exec('DROP TABLE tasm_schema');
  await assert.rejects(open(), /existing tables have no revision/);
});

test('one poll shares its child cleanup budget across parents and resumes after restart', async () => {
  const { db, core, restart, returned } = await store();
  await core.poll();
  assert.ok(returned.queries <= 9, `idle poll issued ${returned.queries} queries`);
  const flow = crypto.randomUUID();
  for (const size of [12, 33]) {
    const parent = crypto.randomUUID();
    await db.query("INSERT INTO tamoss_delete_requests(id,flow_id,status,record,updated) VALUES($1,$2,'created',$3,NOW())",
      [parent, flow, JSON.stringify({ timerange_remaining: '()', delete_flow: false })]);
    for (let i = 0; i < size; i++) {
      const id = crypto.randomUUID();
      await db.query("INSERT INTO tamoss_object_cleanups(id,delete_request_id,object_id,storage_backend_id,status,record,updated) VALUES($1,$2,$5,$3,'pending',$4,NOW())",
        [id, parent, backend, JSON.stringify({ object_id: id, storage_backend_id: backend }), id]);
    }
  }
  const resumed = restart();
  for (const [poller, expected] of [[core, 20], [resumed, 40], [resumed, 45]] as const) {
    await poller.poll();
    const done = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM tamoss_object_cleanups WHERE status='done'");
    assert.equal(done.rows[0].n, expected);
    const parents = await db.query<{ status: string }>('SELECT status FROM tamoss_delete_requests ORDER BY created_at,id');
    assert.deepEqual(parents.rows.map(row => row.status), ['done', expected === 45 ? 'done' : 'started']);
  }
  await db.close();
});

test('a restarted delete request waits for its earliest unfinished child', async () => {
  const { db, restart } = await store();
  const parent = crypto.randomUUID(), failed = crypto.randomUUID(), leased = crypto.randomUUID();
  await db.query("INSERT INTO tamoss_delete_requests(id,flow_id,status,record,updated) VALUES($1,$2,'started',$3,NOW())",
    [parent, crypto.randomUUID(), JSON.stringify({ timerange_remaining: '()', attempt_count: 6 })]);
  for (const [id, status, delay, owner] of [[failed, 'error', 120, null], [leased, 'started', 600, 'other-worker']] as const) {
    await db.query(`INSERT INTO tamoss_object_cleanups(id,delete_request_id,object_id,storage_backend_id,status,record,updated,claim_expires_at,claimed_by)
      VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW()+$7*interval '1 second'+interval '123 microseconds',$8)`,
      [id, parent, id, backend, status, JSON.stringify({ attempt_count: 1 }), delay, owner]);
  }
  await restart().poll();
  const state = await db.query<{ aligned: boolean; owner: string; attempts: number }>(`
    SELECT parent.claim_expires_at=failed.claim_expires_at AS aligned, leased.claimed_by AS owner,
      (failed.record->>'attempt_count')::int AS attempts
    FROM tamoss_delete_requests parent, tamoss_object_cleanups failed, tamoss_object_cleanups leased
    WHERE parent.id=$1 AND failed.id=$2 AND leased.id=$3`, [parent, failed, leased]);
  assert.deepEqual(state.rows[0], { aligned: true, owner: 'other-worker', attempts: 1 });
  await db.close();
});

test('stored ranges and queued deletes retain their original endpoints', async () => {
  const { request, db, core } = await store();
  await checkLegacyRanges(request, (sql, ...params) => db.query(sql, params), () => core.poll(), videoFlow);
});

test('UUID filters follow the TAMS wire format', async () => {
  const { request } = await store();
  await checkUuidFilters(request, videoFlow);
});

test('the Wasm bridge distinguishes JSON null from a missing JavaScript response', async () => {
  for (const response of ['null', null, undefined]) {
    const core = new Tasm((op: string) => op === 'sql' ? '{"rows":[],"affectedRows":0}' : response, origin);
    if (response === 'null') assert.equal(await core.poll(), 0n);
    else await assert.rejects(core.poll(), /Host response must be a JSON string/);
  }
});

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

  for (const path of ['/flows', '/sources', '/service/storage-backends', '/service/webhooks']) {
    assert.equal((await request('GET', path + '?page=&limit=0&limit=1')).status, 200);
    assert.equal((await request('GET', path + '?limit=1&limit=0')).status, 400);
    assert.equal((await request('GET', path + '?tag_exists.test=invalid')).status, 400);
  }
  assert.equal((await request('GET', '/flows?frame_width=0')).status, 400);
  assert.equal((await request('GET', '/flows/' + flowId + '?timerange=invalid')).status, 400);

  const allocation = await request('POST', `/flows/${flowId}/storage`, { limit: 3 });
  assert.equal(allocation.status, 201, allocation.body);
  const ids = (JSON.parse(allocation.body).media_objects as { object_id: string }[]).map(o => o.object_id);
  ids.forEach(upload);
  const registered = await request('POST', `/flows/${flowId}/segments`, ids.map((object_id, i) => ({ object_id, timerange: `[${i * 2}:0_${i * 2 + 2}:0)` })));
  assert.equal(registered.status, 201, registered.body);

  const all = await request('GET', `/flows/${flowId}/segments`);
  assert.equal(all.status, 200, all.body);
  assert.equal(JSON.parse(all.body).length, 3);
  assert.equal(all.headers['x-paging-timerange'], '[0:0_6:0)');
  const first = await request('GET', `/flows/${flowId}/segments?limit=2`);
  assert.equal(JSON.parse(first.body).length, 2);
  assert.equal(first.headers['x-paging-timerange'], '[0:0_4:0)');
  assert.match(first.headers.link ?? '', /rel="next"/);
  const filtered = await request('GET', `/flows/${flowId}/segments?timerange=[2:0_4:0)`);
  assert.deepEqual(JSON.parse(filtered.body).map((s: { object_id: string }) => s.object_id), [ids[1]]);
  assert.equal(filtered.headers['x-paging-timerange'], '[2:0_4:0)');
  const object = await request('GET', `/objects/${ids[0]}`);
  assert.equal(object.status, 200, object.body);
  assert.deepEqual(JSON.parse(object.body).referenced_by_flows, [flowId]);
  const overlap = await request('POST', `/flows/${flowId}/segments`, { object_id: ids[0], timerange: '[1:0_3:0)' });
  assert.equal(overlap.status, 400, overlap.body);

  assert.equal((await request('PUT', `/flows/${collectionId}`, { ...videoFlow, id: collectionId, source_id: crypto.randomUUID(),
    flow_collection: [{ id: flowId, role: 'video' }] })).status, 201);
  const matching = async (query: string) => JSON.parse((await request('GET', `/flows?${query}`)).body).some((f: { id: string }) => f.id === flowId);
  assert.equal(await matching('codec=video/h264&frame_width=1920&frame_height=1080'), true);
  assert.equal(await matching('frame_width=1280'), false);
  assert.equal(await matching('codec=video/h265'), false);
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

test('profiles page in id order, filter, reject duplicates and lock for flows', async () => {
  const { request } = await store();
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const metadata = { format: videoFlow.format, codec: videoFlow.codec, container: videoFlow.container, essence_parameters: videoFlow.essence_parameters };
  for (const [i, id] of ids.entries()) {
    const created = await request('POST', `/service/profiles/${id}`, { id, label: `profile ${i}`, flow_metadata: { ...metadata, codec: i === 2 ? 'video/h265' : metadata.codec } });
    assert.equal(created.status, 201, created.body);
  }
  assert.notEqual((await request('POST', `/service/profiles/${ids[0]}`, { id: ids[0], flow_metadata: metadata })).status, 201);
  const pages: string[] = [];
  let path: string | undefined = '/service/profiles?limit=2';
  while (path) {
    const page = await request('GET', path);
    assert.equal(page.status, 200, page.body);
    pages.push(...JSON.parse(page.body).map((p: { id: string }) => p.id));
    path = /<[^>]*?(\/service\/profiles[^>]*)>; rel="next"/.exec(page.headers.link ?? '')?.[1];
  }
  assert.deepEqual(pages, [...ids].sort());
  assert.deepEqual(JSON.parse((await request('GET', '/service/profiles?codec=video/h265')).body).map((p: { id: string }) => p.id), [ids[2]]);
  assert.equal(JSON.parse((await request('GET', `/service/profiles/${ids[1]}`)).body).label, 'profile 1');
  const flowId = crypto.randomUUID();
  const flow = await request('PUT', `/flows/${flowId}`, { id: flowId, source_id: crypto.randomUUID(), profile_id: ids[0] });
  assert.equal(flow.status, 201, flow.body);
  assert.equal(JSON.parse((await request('GET', `/flows/${flowId}`)).body).codec, videoFlow.codec);
});

test('Source edits queue the same metadata returned by GET', async () => {
  const { request, db } = await store();
  const id = crypto.randomUUID(), source = crypto.randomUUID(), path = '/sources/' + source;
  assert.equal((await request('PUT', '/flows/' + id, { ...videoFlow, id, source_id: source })).status, 201);
  assert.equal((await request('POST', '/service/webhooks', {
    url: 'http://hooks.test/source', events: ['sources/updated'],
  })).status, 201);
  const edits = [
    ['PUT', '/label', '"Edited"'], ['PUT', '/tags/role', '["editor"]'],
    ['PUT', '/description', '"Sample"'], ['DELETE', '/tags/role'], ['DELETE', '/description'],
  ];
  for (const [index, [method, field, body]] of edits.entries()) {
    assert.equal((await request(method, path + field, body)).status, 204);
    const current = JSON.parse((await request('GET', path)).body);
    const { rows } = await db.query<{ source: unknown }>(
      "SELECT record->'payload'->'event'->'source' AS source FROM tamoss_webhook_deliveries",
    );
    assert.equal(rows.length, index + 1);
    assert.ok(rows.some(row => isDeepStrictEqual(row.source, current)));
  }
});

test('webhooks filter by tags, page by url and receive matching events', async () => {
  const { request, core, deliveries } = await store();
  const hooks = [
    { url: 'http://hooks.test/a', events: ['flows/created'], tags: { role: 'edit' } },
    { url: 'http://hooks.test/b', events: ['flows/deleted'], tags: { role: ['edit', 'review'] } },
    { url: 'http://hooks.test/c', events: ['flows/created'] },
  ];
  for (const hook of hooks) {
    const created = await request('POST', '/service/webhooks', hook);
    assert.equal(created.status, 201, created.body);
  }
  const urls = async (query: string) => JSON.parse((await request('GET', `/service/webhooks${query}`)).body).map((h: { url: string }) => h.url);
  assert.deepEqual(await urls('?tag.role=edit'), ['http://hooks.test/a', 'http://hooks.test/b']);
  assert.deepEqual(await urls('?tag.role=review'), ['http://hooks.test/b']);
  assert.deepEqual(await urls('?tag_exists.role=false'), ['http://hooks.test/c']);
  assert.deepEqual(await urls('?limit=2&reverse_order=true'), ['http://hooks.test/c', 'http://hooks.test/b']);
  const flowId = crypto.randomUUID();
  assert.equal((await request('PUT', `/flows/${flowId}`, { ...videoFlow, id: flowId, source_id: crypto.randomUUID() })).status, 201);
  for (let attempt = 0; attempt < 5 && deliveries.length < 2; attempt++) await core.poll();
  assert.deepEqual(deliveries.map(d => `${d.event} ${d.url}`).sort(), ['flows/created http://hooks.test/a', 'flows/created http://hooks.test/c']);
});

test('a reused object only accepts segments within its own timerange', async () => {
  const { request, upload } = await store();
  const put = async () => {
    const id = crypto.randomUUID();
    assert.equal((await request('PUT', `/flows/${id}`, { ...videoFlow, id, source_id: crypto.randomUUID() })).status, 201);
    return id;
  };
  const original = await put(), reuse = await put();
  const allocated = await request('POST', `/flows/${original}/storage`, { limit: 1 });
  const objectId = JSON.parse(allocated.body).media_objects[0].object_id as string;
  upload(objectId);
  assert.equal((await request('POST', `/flows/${original}/segments`, { object_id: objectId, timerange: '[0:0_10:0)' })).status, 201);
  const register = (body: unknown) => request('POST', `/flows/${reuse}/segments`, body);
  const segment = (timerange: string, ts_offset: string) => ({ object_id: objectId, timerange, ts_offset });
  assert.equal((await register(segment('[100:0_110:0)', '100:0'))).status, 201, 'exact fit');
  assert.equal((await register(segment('[204:0_206:0)', '200:0'))).status, 201, 'partial clip');
  assert.equal((await register(segment('[500:0]', '500:0'))).status, 201, 'point at the start');
  const before = JSON.parse((await request('GET', `/flows/${reuse}/segments`)).body).length;
  assert.equal((await register(segment('[312:0_313:0)', '300:0'))).status, 400, 'overrun');
  assert.equal((await register(segment('[410:0]', '400:0'))).status, 400, 'point at the exclusive end');
  assert.equal(JSON.parse((await request('GET', `/flows/${reuse}/segments`)).body).length, before);
  const mixed = await register([segment('[604:0_605:0)', '600:0'), segment('[612:0_613:0)', '600:0')]);
  assert.equal(mixed.status, 200, mixed.body);
  assert.deepEqual(JSON.parse(mixed.body).failed_segments.map((s: { timerange: string }) => s.timerange), ['[612:0_613:0)']);
  const ranges = JSON.parse((await request('GET', `/flows/${reuse}/segments`)).body).map((s: { timerange: string }) => s.timerange);
  assert.ok(ranges.includes('[604:0_605:0)') && !ranges.includes('[612:0_613:0)'), ranges.join());
  assert.equal(JSON.parse((await request('GET', `/objects/${objectId}`)).body).timerange, '[0:0_10:0)');
});

test('deleting a reference keeps a reused object on its own timeline', async () => {
  const { request, upload, core } = await store();
  const put = async () => {
    const id = crypto.randomUUID();
    assert.equal((await request('PUT', `/flows/${id}`, { ...videoFlow, id, source_id: crypto.randomUUID() })).status, 201);
    return id;
  };
  const shared = async () => {
    const original = await put(), reuse = await put();
    const objectId = JSON.parse((await request('POST', `/flows/${original}/storage`, { limit: 1 })).body).media_objects[0].object_id as string;
    upload(objectId);
    assert.equal((await request('POST', `/flows/${original}/segments`, { object_id: objectId, timerange: '[0:0_10:0)' })).status, 201);
    assert.equal((await request('POST', `/flows/${reuse}/segments`, { object_id: objectId, timerange: '[104:0_106:0)', ts_offset: '100:0' })).status, 201);
    return { original, reuse, objectId };
  };
  const unchanged = async (reuse: string, objectId: string) => {
    assert.equal(JSON.parse((await request('GET', `/objects/${objectId}`)).body).timerange, '[0:0_10:0)');
    const segments = JSON.parse((await request('GET', `/flows/${reuse}/segments?include_object_timerange=true`)).body);
    assert.deepEqual(segments.map((s: { object_timerange: string }) => s.object_timerange), ['[0:0_10:0)']);
    const third = await put();
    const reused = await request('POST', `/flows/${third}/segments`, { object_id: objectId, timerange: '[200:0_210:0)', ts_offset: '200:0' });
    assert.equal(reused.status, 201, reused.body);
    assert.equal(JSON.parse((await request('GET', `/flows/${third}/segments?include_object_timerange=true`)).body)[0].object_timerange, '[0:0_10:0)');
  };

  // Deleting the flow queues the deletion of its segments.
  const queued = await shared();
  assert.equal((await request('DELETE', `/flows/${queued.original}`)).status, 202);
  for (let attempt = 0; attempt < 5 && (await request('GET', `/flows/${queued.original}`)).status !== 404; attempt++) await core.poll();
  assert.equal((await request('GET', `/flows/${queued.original}`)).status, 404);
  await unchanged(queued.reuse, queued.objectId);

  // Deleting by object ID removes the segment immediately.
  const immediate = await shared();
  assert.equal((await request('DELETE', `/flows/${immediate.original}/segments?object_id=${immediate.objectId}`)).status, 204);
  await unchanged(immediate.reuse, immediate.objectId);
});

test('flow timerange searches include the segments of collection members', async () => {
  const { request, upload } = await store();
  const put = async (extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    assert.equal((await request('PUT', `/flows/${id}`, { ...videoFlow, id, source_id: crypto.randomUUID(), ...extra })).status, 201);
    return id;
  };
  const segments = async (id: string, timeranges: string[]) => {
    const objects = (JSON.parse((await request('POST', `/flows/${id}/storage`, { limit: timeranges.length })).body).media_objects as { object_id: string }[]).map(o => o.object_id);
    objects.forEach(upload);
    assert.equal((await request('POST', `/flows/${id}/segments`, objects.map((object_id, i) => ({ object_id, timerange: timeranges[i] })))).status, 201);
  };
  const a = await put(), b = await put(), own = await put(), hollow = await put();
  await segments(a, ['[10:0_12:0)']);
  await segments(b, ['[20:0_22:0)']);
  await segments(own, ['[10:0_11:0)']);
  const collection = await put({ flow_collection: [{ id: a, role: 'a' }, { id: b, role: 'b' }] });
  const empty = await put({ flow_collection: [{ id: hollow, role: 'h' }] });
  const ids = async (query: string) => {
    const response = await request('GET', `/flows?${query}`);
    assert.equal(response.status, 200, response.body);
    return (JSON.parse(response.body) as { id: string }[]).map(f => f.id);
  };
  const names = new Map<string, string>([[a, 'a'], [b, 'b'], [own, 'own'], [hollow, 'hollow'], [collection, 'collection'], [empty, 'empty']]);
  const named = (list: string[]) => list.map(id => names.get(id)).filter(Boolean).sort();
  assert.deepEqual(named(await ids('timerange=[10:0_11:0)')), ['a', 'collection', 'own']);
  assert.deepEqual(named(await ids('timerange=[21:0_23:0)')), ['b', 'collection']);
  assert.deepEqual(named(await ids('timerange=[11:0]')), ['a', 'collection']);
  // The list filters on each flow's reported extent, so the gap between members still matches the collection.
  assert.deepEqual(named(await ids('timerange=[12:0_20:0)')), ['collection']);
  assert.deepEqual(named(await ids('timerange=()')), ['empty', 'hollow']);

  // Following the cursor one flow at a time yields the unpaged result exactly once each.
  const unpaged = await ids('timerange=[10:0_21:0)');
  const paged: string[] = [];
  let path: string | undefined = '/flows?timerange=[10:0_21:0)&limit=1';
  while (path) {
    const page = await request('GET', path);
    const head = await request('HEAD', path);
    assert.equal(head.status, 200);
    assert.equal(head.headers.link, page.headers.link);
    paged.push(...(JSON.parse(page.body) as { id: string }[]).map(f => f.id));
    path = /<[^>]*?(\/flows\?[^>]*)>; rel="next"/.exec(page.headers.link ?? '')?.[1];
  }
  assert.deepEqual(paged, unpaged);
  assert.equal(new Set(paged).size, paged.length);
  assert.deepEqual(named(paged), ['a', 'b', 'collection', 'own']);
});

test('sparse segment ingest reads only intersecting stored ranges', async () => {
  const { request, returned } = await store();
  const flow = crypto.randomUUID(), path = '/flows/' + flow;
  assert.equal((await request('PUT', path, { ...videoFlow, id: flow, source_id: crypto.randomUUID() })).status, 201);
  const clip = (n: number) => ({ object_id: crypto.randomUUID(), timerange: `[${n}:0_${n+1}:0)`,
    get_urls: [{ label: 'Archive', url: 'https://archive.example/media' }] });
  const register = (clips: ReturnType<typeof clip>[]) => request('POST', path + '/segments', clips);
  assert.equal((await register(Array.from({ length: 48 }, (_, i) => clip(i + 100)))).status, 201);
  returned.rows = 0;
  assert.equal((await register([clip(150), clip(151)])).status, 201);
  const adjacent = returned.rows;
  returned.rows = 0;
  assert.equal((await register([clip(99), clip(152)])).status, 201);
  assert.equal(returned.rows, adjacent, 'the 48 unrelated segments never cross the SQL bridge');
  const candidates = [clip(98), clip(100), clip(98)];
  const mixed = await register(candidates);
  assert.equal(mixed.status, 200);
  assert.deepEqual(JSON.parse(mixed.body).failed_segments.map((s: { object_id: string }) => s.object_id),
    [candidates[1].object_id, candidates[2].object_id]);
});

test('segment deletion selects matching segments in the database', async () => {
  const { request, upload, returned } = await store();
  const flow = crypto.randomUUID();
  assert.equal((await request('PUT', `/flows/${flow}`, { ...videoFlow, id: flow, source_id: crypto.randomUUID() })).status, 201);
  const count = 40;
  const objects = (JSON.parse((await request('POST', `/flows/${flow}/storage`, { limit: count + 1 })).body).media_objects as { object_id: string }[]).map(o => o.object_id);
  objects.forEach(upload);
  const timeranges = [...Array(count).keys()].map(i => `[${i}:0_${i + 1}:0)`).concat('[50:0]');
  assert.equal((await request('POST', `/flows/${flow}/segments`, objects.map((object_id, i) => ({ object_id, timerange: timeranges[i] })))).status, 201);
  const remaining = async () => (JSON.parse((await request('GET', `/flows/${flow}/segments`)).body) as { object_id: string }[]).map(s => s.object_id);
  const remove = async (query: string) => {
    returned.rows = 0;
    const response = await request('DELETE', `/flows/${flow}/segments?${query}`);
    return { ...response, rows: returned.rows };
  };

  // One match: only that segment crosses into the core.
  const one = await remove(`object_id=${objects[2]}&timerange=${encodeURIComponent('[2:0_3:0)')}`);
  assert.equal(one.status, 204, one.body);
  assert.ok(one.rows < count / 2, `${one.rows} rows returned`);
  assert.ok(!(await remaining()).includes(objects[2]));

  // No match, and partial overlap, leave the segment in place.
  for (const timerange of ['[0:0_1:0)', '[3:500000000_5:0)']) {
    const none = await remove(`object_id=${objects[3]}&timerange=${encodeURIComponent(timerange)}`);
    assert.equal(none.status, 204, none.body);
    assert.ok(none.rows < count / 2, `${none.rows} rows returned`);
  }
  assert.ok((await remaining()).includes(objects[3]));

  // A point timerange contains a point segment.
  assert.equal((await remove(`object_id=${objects[count]}&timerange=${encodeURIComponent('[50:0]')}`)).status, 204);
  assert.ok(!(await remaining()).includes(objects[count]));

  // Queued deletion reads only the bounds of the selection.
  const queued = await remove(`timerange=${encodeURIComponent('_10:0)')}`);
  assert.equal(queued.status, 202, queued.body);
  assert.equal(JSON.parse(queued.body).timerange_to_delete, '_10:0)');
  assert.ok(queued.rows < count / 2, `${queued.rows} rows returned`);
  const single = await remove(`timerange=${encodeURIComponent('[20:0_21:500000000)')}`);
  assert.equal(JSON.parse(single.body).timerange_to_delete, '[20:0_21:500000000)');
  const whole = await remove('');
  assert.equal(whole.status, 202, whole.body);
  assert.equal(JSON.parse(whole.body).timerange_to_delete, '[0:0_40:0)');
  assert.equal((await remove(`timerange=${encodeURIComponent('[45:0_46:0)')}`)).status, 204);
  assert.equal((await remove(`timerange=${encodeURIComponent('()')}`)).status, 204);
});

test('object references filter by flow tags and page in one query', async () => {
  const { request, upload, returned } = await store();
  const put = async (tags?: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    assert.equal((await request('PUT', `/flows/${id}`, { ...videoFlow, id, source_id: crypto.randomUUID(), ...(tags ? { tags } : {}) })).status, 201);
    return id;
  };
  const first = await put({ sample: 'yes' });
  const objectId = JSON.parse((await request('POST', `/flows/${first}/storage`, { limit: 1 })).body).media_objects[0].object_id as string;
  upload(objectId);
  const reference = async (tags?: Record<string, unknown>) => {
    const id = await put(tags);
    const response = await request('POST', `/flows/${id}/segments`, { object_id: objectId, timerange: '[0:0_1:0)' });
    assert.equal(response.status, 201, response.body);
    return id;
  };
  assert.equal((await request('POST', `/flows/${first}/segments`, { object_id: objectId, timerange: '[0:0_1:0)' })).status, 201);
  const scalar = [first, await reference({ sample: 'yes' }), await reference({ sample: 'yes' })];
  const array = [await reference({ sample: ['no', 'yes'] }), await reference({ sample: ['no', 'yes'] })];
  const other = [await reference({ sample: 'no' }), await reference({ sample: 'no' }), await reference({ sample: ['no'] })];
  const untagged = [await reference(), await reference()];
  const sorted = (ids: string[]) => [...ids].sort();
  const all = async (query: string) => {
    const ids: string[] = [];
    let path: string | undefined = `/objects/${objectId}?${query}`;
    while (path) {
      const page = await request('GET', path);
      assert.equal(page.status, 200, page.body);
      const head = await request('HEAD', path);
      assert.equal(head.headers['x-paging-count'], page.headers['x-paging-count']);
      assert.equal(head.headers.link, page.headers.link);
      const referenced = JSON.parse(page.body).referenced_by_flows as string[];
      assert.equal(page.headers['x-paging-count'], String(referenced.length));
      ids.push(...referenced);
      path = /<[^>]*?(\/objects\/[^>]*)>; rel="next"/.exec(page.headers.link ?? '')?.[1];
    }
    return ids;
  };
  assert.deepEqual(await all('flow_tag.sample=yes&limit=2'), sorted([...scalar, ...array]));
  assert.deepEqual(await all('flow_tag.sample=yes,no&limit=3'), sorted([...scalar, ...array, ...other]));
  assert.deepEqual(await all('flow_tag_exists.sample=false&limit=1'), sorted(untagged));
  assert.deepEqual(await all('flow_tag_exists.sample=true&flow_tag.sample=no'), sorted([...array, ...other]));
  assert.deepEqual(await all('limit=4'), sorted([...scalar, ...array, ...other, ...untagged]));

  // The number of queries does not grow with the number of referencing flows.
  const queries = async () => {
    returned.queries = 0;
    assert.equal((await request('GET', `/objects/${objectId}?flow_tag.sample=yes&limit=1`)).status, 200);
    return returned.queries;
  };
  const before = await queries();
  for (let i = 0; i < 6; i++) await reference({ sample: 'yes' });
  assert.equal(await queries(), before);
});

test('an unregistered allocation survives the advertised minimum and expires after the grace period', async () => {
  const { db, core, request } = await store();
  const flow = crypto.randomUUID(), id = crypto.randomUUID();
  assert.equal((await request('PUT', '/flows/' + flow, { ...videoFlow, id: flow, source_id: crypto.randomUUID() })).status, 201);
  assert.equal((await request('POST', '/flows/' + flow + '/storage', { object_ids: [id] })).status, 201);
  const minimum = Number(JSON.parse((await request('GET', '/service')).body).min_object_timeout.split(':')[0]);
  const age = async (seconds: number) => {
    await db.query("UPDATE tamoss_media_objects SET created_at=NOW()-($1::int * INTERVAL '1 second') WHERE id=$2", [seconds, id]);
    await core.poll();
    return (await db.query("SELECT id FROM tamoss_media_objects WHERE id=$1", [id])).rows.length;
  };
  assert.equal(await age(minimum + 5), 1);
  assert.equal(await age(minimum + 60), 0);
});
