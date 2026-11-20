import assert from 'node:assert/strict';

type Request = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: string }>;

export async function checkUuidFilters(request: Request, videoFlow: object) {
  const flow = 'cb8590c4-c2c0-4cfe-a9af-783821a26d57';
  const source = 'abcdef12-3456-4abc-89ab-0123456789ab';
  const parent = crypto.randomUUID();
  assert.equal((await request('PUT', `/flows/${flow}`, { ...videoFlow, id: flow, source_id: source })).status, 201);
  assert.equal((await request('PUT', `/flows/${parent}`, { ...videoFlow, id: parent,
    source_id: crypto.randomUUID(), flow_collection: [{ id: flow, role: 'video' }] })).status, 201);

  const ids = async (query: string) => {
    const response = await request('GET', '/flows?source_id=' + query);
    assert.equal(response.status, 200, response.body);
    return (JSON.parse(response.body) as { id: string }[]).map(row => row.id);
  };
  assert.deepEqual(await ids(source), [flow]);
  assert.deepEqual(await ids('%61' + source.slice(1)), [flow]);
  assert.deepEqual(await ids(source + '&collected_by_ids='), []);
  assert.deepEqual(await ids(source + '&collected_by_ids=' + parent), [flow]);

  for (const invalid of [source.toUpperCase(), source.replaceAll('-', ''), source.replace('-4abc', '-7abc'), source.replace('-89ab', '-c9ab')]) {
    assert.equal((await request('GET', '/flows?source_id=' + invalid)).status, 400, invalid);
    assert.equal((await request('GET', '/flows?collected_by_ids=' + parent + ',' + invalid)).status, 400, invalid);
    assert.equal((await request('GET', '/sources?collected_by_ids=' + parent + ',' + invalid)).status, 400, invalid);
    assert.equal((await request('GET', `/flows/${flow}/segments?accept_storage_ids=${parent},${invalid}`)).status, 400, invalid);
  }
  const encoded = '%63' + flow.slice(1);
  assert.equal((await request('GET', `/flows/${encoded}/segments`)).status, 200);
  assert.equal((await request('POST', `/flows/${encoded}/storage`, { limit: 1 })).status, 201);
  assert.equal((await request('GET', '/flows/' + flow.toUpperCase())).status, 404);
  assert.equal((await request('GET', `/flows/${flow.replaceAll('-', '')}/segments`)).status, 404);
  assert.equal((await request('PUT', `/flows/${flow}`, { ...videoFlow, id: flow, source_id: source.toUpperCase() })).status, 400);
}
