import assert from 'node:assert/strict';

export async function checkLegacyRanges(
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: string }>,
  exec: (sql: string, ...params: string[]) => Promise<unknown>,
  progress: () => Promise<unknown>,
  videoFlow: object,
) {
  const flow = crypto.randomUUID(), job = crypto.randomUUID();
  const path = '/flows/' + flow + '/segments';
  assert.equal((await request('PUT', '/flows/' + flow, { ...videoFlow, id: flow, source_id: crypto.randomUUID() })).status, 201);
  const segment = (object_id: string, timerange: string) => ({
    object_id, timerange, get_urls: [{ label: 'archive', url: 'https://archive.example/clip' }],
  });
  const old = crypto.randomUUID(), adjacent = crypto.randomUUID();
  assert.equal((await request('POST', path, [segment(old, '[0:0_1:0)'), segment(adjacent, '[1:0]')])).status, 201);
  // Historical keys and unfinished jobs could omit the exclusive closing marker.
  await exec('UPDATE tamoss_segments SET timerange=$1 WHERE object_id=$2', '[0:0_1:0', old);
  const first = JSON.parse((await request('GET', path + '?include_object_timerange=true')).body)[0];
  assert.equal(first.timerange, '[0:0_1:0)');
  assert.equal(first.object_timerange, '[0:0_1:0)');
  const range = '[0:0_1:0';
  await exec("INSERT INTO tamoss_delete_requests(id,flow_id,status,record,updated) VALUES($1,$2,'created',$3,$4)",
    job, flow, JSON.stringify({ timerange_to_delete: range, timerange_remaining: range }), new Date().toISOString());
  const deadline = Date.now() + 15000;
  while (JSON.parse((await request('GET', '/flow-delete-requests/' + job)).body).status !== 'done') {
    assert.ok(Date.now() < deadline, 'legacy delete completes');
    await progress();
  }
  assert.deepEqual(JSON.parse((await request('GET', path)).body).map((s: { object_id: string }) => s.object_id), [adjacent]);
}
