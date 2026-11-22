import { test } from 'node:test';
import { expect } from '@playwright/test';
import { NS, PROFILE, samples, range, editWorkspace, planPlacement, snapPlacement, blockBoundaries, blockEnd, reusableSample, WorkspaceStore, type Block, type Lane, type Workspace, type RequestRecord } from '../apps/shared/workspace-store';
import { curlCommand, parseCurl } from '../apps/playpen/terminal';
import { describeRequest, requestDetails, walkthrough } from '../apps/playpen/api-review';

test('insert preserves interrupted media, gaps, other lanes, object timing and fractional offsets', async () => {
  const sample = { ...samples[0], durationNs: String(10n * NS) }, incoming = { ...sample, id: 'B', durationNs: String(3n * NS) };
  const block = (key: string, start: bigint): Block => ({ key, start, sample, profile: 'test', checksum: sample.sha256,
    segments: Array.from({ length: 5 }, (_, i) => ({ object_id: `${key}${i}`, timerange: range(start + BigInt(i * 2) * NS, start + BigInt(i * 2 + 2) * NS), ts_offset: '-1:0', object_timerange: range(start + BigInt(i * 2 + 1) * NS, start + BigInt(i * 2 + 3) * NS) })) });
  const a = block('A', 0n), later = block('later', 12n * NS);
  const lane = { id: 'video', kind: 'video' as const, flow: { id: 'flow', source_id: 'source', format: sample.technical.format }, blocks: [a, later], segments: [...a.segments, ...later.segments] };
  const otherBlock = block('other', 0n);
  const other = { ...lane, id: 'other', blocks: [otherBlock], segments: otherBlock.segments };
  const workspace: Workspace = { root: lane.flow, lanes: [lane, other] };
  const placement = planPlacement(workspace, lane, incoming, 3900000000n, 3n * NS, 26, false);
  expect(placement).toMatchObject({ start: 4n * NS, snapped: 4n * NS, insert: true, invalid: false });
  expect(planPlacement(workspace, lane, incoming, 3n * NS, 3n * NS, 26, false).start).toBe(2n * NS);
  const result = editWorkspace(workspace, { laneId: lane.id, start: placement.start, sample: incoming, insert: true });
  expect(result.lanes[0].blocks.map(b => [b.sample.id, b.start, blockEnd(b)])).toEqual([
    [sample.id, 0n, 4n * NS], ['B', 4n * NS, 7n * NS], [sample.id, 7n * NS, 13n * NS], [sample.id, 15n * NS, 25n * NS],
  ]);
  const resumed = result.lanes[0].blocks[2].segments[0];
  expect(resumed).toEqual({ ...a.segments[2], timerange: '[7:0_9:0)', ts_offset: '2:0' });
  expect(result.lanes[1]).toEqual(other);
  expect(workspace.lanes[0].blocks).toEqual([a, later]);
  const fractional = editWorkspace(workspace, { laneId: lane.id, start: 4n * NS, sample: { ...incoming, durationNs: '1984000000' }, insert: true });
  expect(fractional.lanes[0].blocks[2].segments[0]).toMatchObject({ timerange: '[5:984000000_7:984000000)', ts_offset: '0:984000000' });
  expect(() => editWorkspace(workspace, { laneId: lane.id, start: 3n * NS, sample: incoming, insert: true })).toThrow('segment boundary');
  expect(planPlacement(workspace, lane, { ...incoming, kind: 'audio' }, 4n * NS, 3n * NS, 26, false).invalid).toBe(true);
  expect(planPlacement(workspace, lane, { ...incoming, durationNs: String(86400n * NS) }, 4n * NS, 86400n * NS, 26, false).invalid).toBe(true);
});

test('split saved clips can supply a complete sample without uploading it again', async () => {
  const sample = { ...samples[0], startNs: String(2n * NS), durationNs: String(6n * NS) };
  const block: Block = { key: 'A', sample, start: 10n * NS, profile: PROFILE, checksum: sample.sha256,
    segments: [0n, 2n, 4n].map(n => ({ object_id: `object-${n}`, timerange: range((10n + n) * NS, (12n + n) * NS),
      ts_offset: '8:0', object_timerange: range((2n + n) * NS, (4n + n) * NS) })) };
  const lane = { id: 'video', kind: 'video' as const, flow: { id: 'flow', source_id: 'source', format: sample.technical.format }, blocks: [block], segments: block.segments };
  const workspace: Workspace = { root: lane.flow, lanes: [lane] };
  const earlier = editWorkspace(workspace, { laneId: lane.id, fromLaneId: lane.id, key: block.key, start: NS });
  expect(earlier.lanes[0].segments[0]).toMatchObject({
    timerange: '[1:0_3:0)', ts_offset: '-1:0', object_timerange: '[2:0_4:0)',
  });
  const split = editWorkspace(workspace, { laneId: lane.id, start: 12n * NS, sample: { ...sample, id: 'B' }, insert: true });
  const parts = split.lanes[0].blocks.filter(b => b.sample.id === sample.id);
  const reusable = reusableSample(parts, sample)!;
  expect(reusable.partial).toBeUndefined();
  expect(reusable.segments.map(s => [s.object_id, s.timerange, s.ts_offset])).toEqual([
    ['object-0', '[2:0_4:0)', '0:0'], ['object-2', '[4:0_6:0)', '0:0'], ['object-4', '[6:0_8:0)', '0:0'],
  ]);
  expect(reusableSample(parts.slice(1), sample)).toBeUndefined();
  const inserted = editWorkspace(split, { laneId: lane.id, start: 30n * NS, sample });
  expect(inserted.lanes[0].blocks.at(-1)!.segments.map(s => s.object_id)).toEqual(block.segments.map(s => s.object_id));
});

test('unsaved splits survive cloning, repeated inserts, moves and removals', async () => {
  const sample = { ...samples[0], durationNs: String(10n * NS) }, incoming = { ...sample, id: 'B', durationNs: String(3n * NS) };
  const block: Block = { key: 'A', sample, start: 0n, segments: [], profile: 'test', checksum: sample.sha256, boundaries: [0n, 2n, 4n, 6n, 8n, 10n].map(n => n * NS) };
  const lane = { id: 'video', kind: 'video' as const, flow: { id: 'flow', source_id: 'source', format: sample.technical.format }, blocks: [block], segments: [] };
  let workspace: Workspace = { root: lane.flow, lanes: [lane] };
  workspace = structuredClone(editWorkspace(workspace, { laneId: lane.id, start: 4n * NS, sample: incoming, insert: true, boundaries: [0n, 2n * NS, 3n * NS] }));
  expect(workspace.lanes[0].blocks.map(b => b.sourceRange)).toEqual([[0n, 4n * NS], undefined, [4n * NS, 10n * NS]]);
  const tail = workspace.lanes[0].blocks[2];
  expect(blockBoundaries(tail)).toEqual([7n, 9n, 11n, 13n].map(n => n * NS));
  expect(planPlacement(workspace, workspace.lanes[0], sample, 8n * NS, 6n * NS, 26, false, { laneId: lane.id, key: tail.key })).toMatchObject({ noop: false, start: 8n * NS });
  expect(planPlacement(workspace, workspace.lanes[0], sample, tail.start, 6n * NS, 26, false, { laneId: lane.id, key: tail.key }).noop).toBe(true);
  workspace = editWorkspace(workspace, { laneId: lane.id, start: 9n * NS, sample: incoming, insert: true, boundaries: [0n, 2n * NS, 3n * NS] });
  expect(blockEnd(workspace.lanes[0].blocks.at(-1)!)).toBe(16n * NS);
  const b = workspace.lanes[0].blocks.find(b => b.sample.id === 'B')!;
  workspace = editWorkspace(workspace, { laneId: lane.id, fromLaneId: lane.id, key: b.key, remove: true });
  expect(workspace.lanes[0].blocks[1].start).toBe(7n * NS);
});

test('edge snapping uses screen distance, excludes the moving item and rejects illegal alignments', async () => {
  const sample = samples[0];
  const block = (key: string, start: bigint, end: bigint): Block => ({ key, start, sample, profile: 'test', checksum: sample.sha256, segments: [{ object_id: key, timerange: range(start, end) }] });
  const lane = (id: string, blocks: Block[]): Lane => ({ id, kind: 'video', flow: { id, source_id: 'source', format: sample.technical.format }, blocks, segments: blocks.flatMap(b => b.segments) });
  const target = lane('target', [block('one', 0n, 2n * NS)]), other = lane('other', [block('two', 5n * NS, 7n * NS)]);
  const workspace: Workspace = { root: target.flow, lanes: [target, other] };
  expect(snapPlacement(workspace, target, sample, 2110000000n, 2n * NS, 26, false).start).toBe(2n * NS);
  expect(snapPlacement(workspace, target, sample, 4900000000n, 2n * NS, 26, true).start).toBe(5n * NS);
  expect(snapPlacement(workspace, target, sample, 4900000000n, 2n * NS, 156, false).snapped).toBeUndefined();
  expect(snapPlacement(workspace, target, sample, 1100000000n, 2n * NS, 26, false).invalid).toBe(true);
  expect(snapPlacement(workspace, other, sample, 5100000000n, 2n * NS, 26, true, { laneId: 'other', key: 'two', segment: { objectId: 'two', timerange: '[5:0_7:0)' } }).snapped).toBeUndefined();
  expect(snapPlacement(workspace, target, sample, 86400n * NS, 2n * NS, 26, true).invalid).toBe(true);
});

const record = (path: string, method = 'GET', body?: unknown): RequestRecord => ({ url: `http://localhost/${path}`, method, body, headers: {}, status: 200, ms: 12 });

test('review explains recorded endpoints and does not infer a successful result', () => {
  for (const [request, title] of [
    [record('api/flows/root', 'PUT', { format: 'urn:x-nmos:format:multi' }), 'Create source collection'],
    [record('api/flows/video', 'PUT', { format: 'urn:x-nmos:format:video' }), 'Create media flow'],
    [{ ...record('api/flows/video', 'PUT'), stage: 'segment' }, 'Prepare replacement flow'],
    [record('api/flows/video/storage', 'POST', { object_ids: ['object-1'] }), 'Allocate media storage'],
    [record('media/object-1', 'PUT', { file: 'clip.ts', bytes: 1024 }), 'Upload media bytes'],
    [record('api/flows/video/segments', 'POST', { object_id: 'object-1', timerange: '[2:0_4:0)' }), 'Register a segment'],
    [record('api/flows/root/flow_collection', 'PUT', []), 'Publish flow collection'],
    [{ ...record('api/flows/old', 'DELETE'), stage: 'update' }, 'Retire a flow'],
    [record('api/flows/video/segments?timerange=%5B2%3A0_4%3A0)'), 'Query a time range'],
    [record('api/flows/video/segments'), 'Read flow segments'],
    [record('media/object-1'), 'Read media bytes'],
    [record('media/object-1', 'HEAD'), 'Check stored object'],
    [record('api/flows/video/label', 'PUT', 'New name'), 'Rename source or flow'],
    [record('api/flows/video'), 'Read source or flow metadata'],
    [record('api/sources?limit=100'), 'Read source or flow metadata'],
    [record('api/unknown', 'PATCH'), 'API request'],
  ] as [RequestRecord, string][]) expect(describeRequest(request).title).toBe(title);
  const upload = record('media/object-1', 'PUT', { file: 'clip.ts', bytes: 1024 });
  expect(describeRequest(upload).context).toContainEqual(['Bytes sent', '1024']);
  expect(describeRequest({ ...upload, ms: undefined }).state).toBe('Pending');
  expect(describeRequest({ ...upload, ms: undefined }).outcome).not.toContain('were stored');
  expect(describeRequest({ ...upload, status: 503, error: 'Write failed' }).outcome).toContain('Do not assume');
  expect(describeRequest({ ...upload, status: undefined }).state).toBe('Unknown');
  const query = { ...record('api/flows/video/segments?timerange=%5B2%3A0_4%3A0)'), response: [{ object_id: 'object-1' }] };
  expect(describeRequest(query).context).toContainEqual(['Requested time range', '[2:0_4:0)']);
  expect(describeRequest(query).outcome).toContain('1 segment reference was');
  expect(requestDetails({ ...upload, body: '<img src=x onerror=alert(1)>', response: null, status: 204 })).toContain('&lt;img');
  expect(requestDetails({ ...upload, response: null, status: 204 })).toContain('(empty)');
  const partial = { ...record('api/flows/video/segments', 'POST', [{ object_id: 'object-1' }]), response: { failed_segments: [{ object_id: 'object-1' }] } };
  expect(describeRequest(partial).state).toBe('Failed');
  expect(describeRequest({ ...record('api/flows/old', 'DELETE'), status: 202 }).outcome).toContain('pending');
  const stages = walkthrough({ id: 'move', name: 'Move media', pending: false, requests: [record('api/flows/root'), record('api/flows/video/segments'), partial], events: [{ position: 2, title: 'Reuse stored media', detail: 'Reuse 4 objects.', state: 'Succeeded', ms: 1 }] });
  expect(stages.map(s => s.title)).toEqual(['Read current arrangement', 'Reuse stored media', 'Register segments']);
  expect(stages[0].records).toHaveLength(2); expect(stages[2].state).toBe('Failed');
});

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

test('loading rejects a missing, malformed, or repeated lane identity', async t => {
  const id = 'a2e04f1e-7d44-497f-80e0-4e754999aea6';
  for (const tags of [[undefined], ['old lane'], [id, id.toUpperCase()]]) {
    const flows = tags.map((tag, i) => ({ id: String(i), format: 'urn:x-nmos:format:video', tags: { 'tasm.playpen.lane': tag ? [tag] : [] } }));
    const fetch = t.mock.method(globalThis, 'fetch', async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/root')) return Response.json({ flow_collection: flows.map(({ id }) => ({ id })) });
      return Response.json(path.endsWith('/segments') ? [] : flows[Number(path.split('/').at(-1))]);
    });
    try { await expect(new WorkspaceStore('https://example.test/api/').load('root')).rejects.toThrow('lane ID'); }
    finally { fetch.mock.restore(); }
  }
});

test('placing an imported track preserves its file offset between grid ticks', () => {
  const sample = { ...samples[0], imported: true, trackOffsetNs: '500000000' };
  const flow = { id: 'flow', source_id: 'source', format: sample.technical.format };
  const lane: Lane = { id: 'video', flow, kind: 'video', blocks: [], segments: [] };
  const workspace = { root: flow, lanes: [lane] };
  for (const exact of [true, false]) {
    expect(planPlacement(workspace, lane, sample, NS, NS, 26, false, undefined, exact).start).toBe(1500000000n);
  }
});

test('background reads leave completed step history available', async () => {
  const store = new WorkspaceStore('https://example.test/api/');
  for (let i = 0; i < 30; i++) await store.action('Step ' + i, async () => {});
  await store.action('Verify stored media', async () => {});
  expect(store.actions).toHaveLength(30);
  expect(store.actions.at(-1)?.name).toBe('Step 0');
});

test('pagination follows the link on its own response while another request finishes', async t => {
  const store = new WorkspaceStore('https://example.test/api/');
  const action = store.beginAction('Read pages');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/first')) {
      await gate;
      return Response.json([1], { headers: { link: '<second>; rel="next"' } });
    }
    return Response.json(url.endsWith('/second') ? [2] : {});
  });
  const pages = store.list<number>(action, 'first');
  await store.request(action, 'background');
  release();
  expect(await pages).toEqual([1, 2]);
});

test('storage checks distinguish zero bytes, missing objects and unknown lengths', async t => {
  const store = new WorkspaceStore('https://example.test/api/');
  const action = store.beginAction('Verify stored media');
  const signal = new AbortController().signal;
  const responses = [
    new Response(null, { headers: { 'content-length': '0' } }),
    new Response(null, { status: 404 }),
    new Response(null),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift()!);
  for (const result of [{ state: 'stored', bytes: 0 }, { state: 'missing' }, { state: 'unknown' }]) {
    expect(await store.checkStorage(action, 'asset', '/media/asset', signal)).toEqual(result);
  }
  expect(action.requests.map(r => r.method)).toEqual(['HEAD', 'HEAD', 'HEAD']);
});
