import { test, expect } from './fixtures';
import { build } from 'esbuild';
import type { Block, Workspace } from '../../apps/shared/workspace-store';

async function editing() {
  const bundle = await build({ entryPoints: ['apps/shared/workspace-store.ts'], bundle: true, format: 'iife', globalName: 'Editing', write: false, logLevel: 'silent' });
  return new Function(bundle.outputFiles[0].text + '; return Editing;')() as typeof import('../../apps/shared/workspace-store');
}

test('insert preserves interrupted media, gaps, other lanes, object timing and fractional offsets', async () => {
  const { samples, range, NS, editWorkspace, planPlacement, blockEnd } = await editing();
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
  const { samples, NS, PROFILE, range, reusableSample, editWorkspace } = await editing();
  const sample = { ...samples[0], startNs: String(2n * NS), durationNs: String(6n * NS) };
  const block: Block = { key: 'A', sample, start: 10n * NS, profile: PROFILE, checksum: sample.sha256,
    segments: [0n, 2n, 4n].map(n => ({ object_id: `object-${n}`, timerange: range((10n + n) * NS, (12n + n) * NS),
      ts_offset: '8:0', object_timerange: range((2n + n) * NS, (4n + n) * NS) })) };
  const lane = { id: 'video', kind: 'video' as const, flow: { id: 'flow', source_id: 'source', format: sample.technical.format }, blocks: [block], segments: block.segments };
  const workspace: Workspace = { root: lane.flow, lanes: [lane] };
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
  const { samples, NS, editWorkspace, blockEnd, blockBoundaries, planPlacement } = await editing();
  const sample = { ...samples[0], durationNs: String(10n * NS) }, incoming = { ...sample, id: 'B', durationNs: String(3n * NS) };
  const block: Block = { key: 'A', sample, start: 0n, segments: [], profile: 'test', checksum: sample.sha256, boundaries: [0n, 2n, 4n, 6n, 8n, 10n].map(n => n * NS) };
  const lane = { id: 'video', kind: 'video' as const, flow: { id: 'flow', source_id: 'source', format: sample.technical.format }, blocks: [block], segments: [] };
  let workspace: Workspace = { root: lane.flow, lanes: [lane] };
  workspace = structuredClone(editWorkspace(workspace, { laneId: lane.id, start: 4n * NS, sample: incoming, insert: true, boundaries: [0n, 2n * NS, 3n * NS] }));
  expect(workspace.lanes[0].blocks.map(b => b.sourceRange)).toEqual([[0n, 4n * NS], undefined, [4n * NS, 10n * NS]]);
  const tail = workspace.lanes[0].blocks[2];
  expect(blockBoundaries(tail)).toEqual([7n, 9n, 11n, 13n].map(n => n * NS));
  expect(planPlacement(workspace, workspace.lanes[0], sample, 8n * NS, 6n * NS, 26, false, { laneId: lane.id, key: tail.key }).noop).toBe(true);
  workspace = editWorkspace(workspace, { laneId: lane.id, start: 9n * NS, sample: incoming, insert: true, boundaries: [0n, 2n * NS, 3n * NS] });
  expect(blockEnd(workspace.lanes[0].blocks.at(-1)!)).toBe(16n * NS);
  const b = workspace.lanes[0].blocks.find(b => b.sample.id === 'B')!;
  workspace = editWorkspace(workspace, { laneId: lane.id, fromLaneId: lane.id, key: b.key, remove: true });
  expect(workspace.lanes[0].blocks[1].start).toBe(7n * NS);
});

test('unsaved insertion saves and reloads with shared media, and plays across both joins', async ({ page, browserName }) => {
  test.setTimeout(browserName === 'webkit' ? 360000 : 180000);
  await page.setViewportSize({ width: 1600, height: 1400 }); await page.goto('/');
  const ready = async () => { await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 90000 }); await expect(page.locator('body')).not.toHaveClass(/busy/, { timeout: 90000 }); };
  await ready();
  for (const [button, name] of [['#new-source', 'Insert example'], ['#add-video', 'Picture']]) {
    await page.locator(button).click(); await page.locator('#entity-name').fill(name); await page.locator('#dialog-submit').click(); await ready();
  }
  await page.locator('[data-sample="orbit"]').click(); await page.locator('#add-sample').click(); await ready();
  await page.locator('.clip').click(); await page.locator('#block-start').fill('10'); await page.locator('#move-block').click(); await ready();
  // Seek within the unsaved A; the source player has no saved duration yet, so use an actual drag.
  const card = await page.locator('[data-sample="orbit"]').boundingBox(), track = await page.locator('.lane-track').boundingBox();
  await page.mouse.move(card!.x + 15, card!.y + 15); await page.mouse.down();
  await page.mouse.move(track!.x + 13.9 * 26, track!.y + 35, { steps: 12 });
  await expect(page.locator('.drop-preview')).toContainText('Insert at 00:14.000'); await page.mouse.up(); await ready();
  await expect(page.locator('.clip')).toHaveCount(3);
  await page.reload(); await ready(); await expect(page.locator('.clip')).toHaveCount(3);
  await page.locator('#save-draft').click(); await ready();
  const read = () => page.evaluate(async () => {
    const root = await (await fetch(`/api/flows/${(document.getElementById('sources') as HTMLSelectElement).value}`)).json();
    return await (await fetch(`/api/flows/${root.flow_collection[0].id}/segments?include_object_timerange=true`)).json();
  });
  const segments = await read();
  expect(segments).toHaveLength(8);
  expect(new Set(segments.map((s: any) => s.object_id)).size).toBe(4);
  expect(segments[0].timerange).toBe('[10:0_12:0)');
  expect(segments[2].timerange).toBe('[14:0_16:0)');
  expect(segments[6].timerange).toBe('[20:400000000_22:400000000)');
  expect(segments[6].ts_offset).toBe('16:400000000');
  await page.reload(); await ready(); expect(await read()).toEqual(segments);
  await expect(page.locator('#preview-status')).toContainText('Source ready', { timeout: 60000 });
  await page.locator('#range-start').fill('13'); await page.locator('#range-end').fill('22'); await page.locator('#read-range').click();
  await expect(page.locator('#play-range')).toBeEnabled({ timeout: 60000 }); await page.locator('#play-range').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30000 }).toBeGreaterThanOrEqual(21.95);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});
