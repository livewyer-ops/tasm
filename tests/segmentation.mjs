import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Input, BufferSource, MPEG_TS, EncodedPacketSink, Output, BufferTarget, Mp4OutputFormat, MovOutputFormat, AdtsOutputFormat, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';
await mkdir('.local', { recursive: true });
await build({ entryPoints: ['apps/shared/ingest-worker.ts'], bundle: true, platform: 'node', format: 'esm', external: ['mediabunny'], outfile: '.local/test-segmenter.mjs' });
const { segmentMedia, importMedia, MAX_IMPORT_BYTES } = await import('../.local/test-segmenter.mjs');
const samples = JSON.parse(await readFile('apps/shared/samples/manifest.json', 'utf8'));
async function packets(bytes, kind) {
  const input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
  try {
    const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    const result = [];
    for await (const p of new EncodedPacketSink(track).packets()) result.push({ timestamp: Math.round(p.timestamp * 90000), duration: Math.round(p.duration * 90000), type: p.type, data: kind === 'video' ? Buffer.from(p.data).toString('latin1').split(/\x00\x00(?:\x00)?\x01/).map(n => Buffer.from(n, 'latin1').toString('hex')) : Buffer.from(p.data).toString('hex') });
    return result;
  } finally { input.dispose(); }
}
for (const sample of samples) {
  const bytes = await readFile(`apps/shared/samples/${sample.file}`);
  const objects = await segmentMedia(bytes, sample.kind);
  if (sample.id === 'newsreader-offset') assert.equal(objects.length, 5);
  if (['voice-a', 'voice-b'].includes(sample.id)) assert.ok(objects.length >= 3);
  if (!sample.category && !sample.id.startsWith('newsreader')) assert.equal(objects.length, sample.id === 'grid' || sample.id === 'ping' ? 2 : 4);
  assert.equal(objects[0].start, sample.startNs);
  assert.equal(objects.at(-1).end, String(BigInt(sample.startNs) + BigInt(sample.durationNs)));
  const outputPackets = [];
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i], decoded = await packets(object.bytes, sample.kind);
    assert.equal(object.bytes.byteLength % 188, 0, 'TS packet size');
    assert.equal(decoded.length, object.packets);
    if (sample.kind === 'video') assert.equal(decoded[0].type, 'key');
    if (i) assert.equal(object.start, objects[i - 1].end);
    if (i < objects.length - 1) assert.equal(BigInt(object.end) - BigInt(object.start), sample.kind === 'video' ? 2000000000n : 1984000000n);
    outputPackets.push(...decoded);
  }
  assert.deepEqual(outputPackets, await packets(bytes, sample.kind), `${sample.id}: NAL/AAC payloads, timestamps and durations preserved (Annex B start codes may be normalized)`);
  console.log(`${sample.id}: ${objects.length} segments, ${outputPackets.length} unchanged packets; tail retained`);
}
await assert.rejects(() => importMedia(new File([], 'empty.mp4')), /non-empty/);
await assert.rejects(() => importMedia({ size: MAX_IMPORT_BYTES + 1 }), /100 MiB/);
await assert.rejects(() => importMedia(new File(['not media'], 'wrong.mp4')), /MP4, MOV, TS, M4A or AAC/);
for (const [format, kind] of [[new Mp4OutputFormat(), 'video'], [new MovOutputFormat(), 'video'], [new Mp4OutputFormat(), 'audio'], [new AdtsOutputFormat(), 'audio']]) {
  const sample = samples.find(s => s.kind === kind), input = new Input({ source: new BufferSource(await readFile(`apps/shared/samples/${sample.file}`)), formats: [MPEG_TS] });
  try {
    const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    const target = new BufferTarget(), output = new Output({ format, target });
    const source = kind === 'video' ? new EncodedVideoPacketSource('avc') : new EncodedAudioPacketSource('aac');
    if (kind === 'video') output.addVideoTrack(source); else output.addAudioTrack(source);
    await output.start();
    const decoderConfig = await track.getDecoderConfig();
    for await (const packet of new EncodedPacketSink(track).packets()) await source.add(packet, { decoderConfig });
    source.close(); await output.finalize();
    const imported = await importMedia(new File([target.buffer], 'recording' + format.fileExtension));
    assert.equal(imported.length, 1); assert.equal(imported[0].sample.kind, kind);
    assert.equal(imported[0].sample.durationNs, sample.durationNs);
    const single = new Input({ source: new BufferSource(imported[0].bytes), formats: [MPEG_TS] });
    try { assert.equal((await single.getTracks()).length, 1); } finally { single.dispose(); }
    assert.equal(imported[0].sample.bytes, imported[0].bytes.byteLength);
    // Remuxing may repeat SPS/PPS and access-unit delimiters; encoded media must not change.
    const payload = p => kind === 'video' ? p.data.filter(n => n && ![7, 8, 9].includes(parseInt(n.slice(0, 2), 16) & 31)) : p.data;
    assert.deepEqual((await packets(imported[0].bytes, kind)).map(payload),
      (await packets(await readFile(`apps/shared/samples/${sample.file}`), kind)).map(payload), 'Demuxing preserves encoded media');
    const objects = await segmentMedia(imported[0].bytes, kind);
    assert.equal(objects.length, 4);
    assert.deepEqual((await importMedia(new File([target.buffer], 'renamed' + format.fileExtension)))[0].sample.id, imported[0].sample.id);
    console.log(`${format.fileExtension} ${kind}: demuxed, then segmented on placement`);
  } finally { input.dispose(); }
}

// AAC encoder padding must be included in the ready library duration.
const short = (await importMedia(new File([await readFile('tests/media/short-mono.m4a')], 'Short mono.m4a')))[0];
const shortObjects = await segmentMedia(short.bytes, 'audio');
assert.deepEqual(short.sample.technical.essence_parameters, { sample_rate: 48000, channels: 1 });
assert.equal(short.sample.durationNs, String(BigInt(shortObjects.at(-1).end) - BigInt(shortObjects[0].start)));
assert.ok(BigInt(short.sample.durationNs) < 1000000000n);
