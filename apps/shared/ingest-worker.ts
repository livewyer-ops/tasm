import { Input, BufferSource, MPEG_TS, MP4, QTFF, ADTS, UnsupportedInputFormatError, EncodedPacketSink, Output, BufferTarget, PathedTarget, HlsOutputFormat, MpegTsOutputFormat, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';
import type { Sample } from './workspace-store';

export interface PreparedObject { bytes: ArrayBuffer; start: string; end: string; packets: number }
export interface ImportedTrack { sample: Sample; bytes: ArrayBuffer }
// Demuxing holds the input file in memory.
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const importFormats = [MP4, QTFF, MPEG_TS, ADTS];
const ns = (time: number) => String(BigInt(Math.round(time * 90000)) * 1000000000n / 90000n);

// HLS supplies the existing keyframe/packet-aware segmenter; only its TS objects are stored.
export async function segmentMedia(bytes: ArrayBuffer, kind: string): Promise<PreparedObject[]> {
  const input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
  try {
    const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    if (!track) throw new Error(`Missing ${kind} track`);
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error('Missing decoder configuration');
    const packets = new EncodedPacketSink(track);
    const first = await packets.getFirstPacket();
    if (!first) throw new Error('No media packets were found.');
    const chunks: { index: number; bytes: ArrayBuffer }[] = [];
    const output = new Output({ format: new HlsOutputFormat({ segmentFormat: new MpegTsOutputFormat(), targetDuration: 2, mediaTimestampBase: first.timestamp,
      onSegment: (target, info) => { chunks.push({ index: info.n, bytes: (target as BufferTarget).buffer! }); } }),
      target: new PathedTarget('master.m3u8', () => new BufferTarget()) });
    const source = kind === 'video' ? new EncodedVideoPacketSource('avc') : new EncodedAudioPacketSource('aac');
    if (source instanceof EncodedVideoPacketSource) output.addVideoTrack(source); else output.addAudioTrack(source);
    await output.start();
    for await (const packet of packets.packets(first)) await source.add(packet, { decoderConfig } as never);
    source.close(); await output.finalize();
    const objects: PreparedObject[] = [];
    for (const { bytes } of chunks.sort((a, b) => a.index - b.index)) {
      const chunk = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
      try {
        const track = kind === 'video' ? await chunk.getPrimaryVideoTrack() : await chunk.getPrimaryAudioTrack();
        if (!track) throw new Error('Segment has no track');
        let start = Infinity, end = -Infinity, packets = 0;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          if (!packets && kind === 'video' && packet.type !== 'key') throw new Error('Video segment must begin with a keyframe');
          start = Math.min(start, packet.timestamp); end = Math.max(end, packet.timestamp + packet.duration); packets++;
        }
        if (!packets || end <= start) throw new Error('Empty media segment');
        objects.push({ bytes, start: ns(start), end: ns(end), packets });
      } finally { chunk.dispose(); }
    }
    // 44.1 kHz AAC durations round between 90 kHz ticks; use the next packet's PTS at those boundaries.
    for (let i = 1; i < objects.length; i++) {
      const delta = BigInt(objects[i].start) - BigInt(objects[i - 1].end);
      if (delta < -11112n || delta > 11112n) throw new Error('Media contains discontinuous segment timing. Export a continuous file and try again.');
      objects[i - 1].end = objects[i].start;
    }
    if (!objects.length) throw new Error('No media packets were found.');
    return objects;
  } finally { input.dispose(); }
}

export async function importMedia(file: File): Promise<ImportedTrack[]> {
  if (!file.size || file.size > MAX_IMPORT_BYTES) throw new Error('Choose a non-empty media file up to 100 MiB.');
  const bytes = await file.arrayBuffer();
  const input = new Input({ source: new BufferSource(bytes), formats: importFormats });
  try {
    const videos = await input.getVideoTracks(), audios = await input.getAudioTracks();
    if (!videos.length && !audios.length) throw new Error('No audio or video track was found.');
    if (videos.length > 1 || audios.length > 1) throw new Error('Choose a file with at most one video and one audio track.');
    const video = videos[0], audio = audios[0];
    if (video && await video.getCodec() !== 'avc') throw new Error('Video must use H.264. Export an H.264 MP4 and try again.');
    if (audio && await audio.getCodec() !== 'aac') throw new Error('Audio must use AAC. Export an AAC M4A or MP4 and try again.');
    if (video && (await video.getRotation() !== 0 || await video.getFlip())) throw new Error('This video has rotation or mirroring metadata. Export it with the orientation applied first.');
    const tracks = [...videos, ...audios];
    const first = Math.min(...await Promise.all(tracks.map(t => t.getFirstTimestamp())));
    const end = Math.max(...await Promise.all(tracks.map(t => t.computeDuration())));
    if (!Number.isFinite(first) || !Number.isFinite(end) || end <= first || end - first > 86400) throw new Error('Choose media with a valid duration of up to 24 hours.');
    const result: ImportedTrack[] = [];
    for (const track of tracks) {
      const kind = track.type === 'video' ? 'video' : 'audio';
      const decoderConfig = await track.getDecoderConfig();
      if (!decoderConfig) throw new Error('Missing decoder configuration');
      const target = new BufferTarget(), output = new Output({ format: new MpegTsOutputFormat(), target });
      const source = kind === 'video' ? new EncodedVideoPacketSource('avc') : new EncodedAudioPacketSource('aac');
      if (source instanceof EncodedVideoPacketSource) output.addVideoTrack(source); else output.addAudioTrack(source);
      await output.start();
      let start = Infinity, end = -Infinity, minTicks = Infinity, maxTicks = 0, packets = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        if (!packets && kind === 'video' && packet.type !== 'key') throw new Error('Video must begin with a keyframe. Export an H.264 MP4 and try again.');
        const time = packet.timestamp - first, ticks = Math.round(packet.duration * 90000);
        start = Math.min(start, time); end = Math.max(end, time + packet.duration);
        minTicks = Math.min(minTicks, ticks); maxTicks = Math.max(maxTicks, ticks); packets++;
        await source.add(packet.clone({ timestamp: time }), { decoderConfig } as never);
      }
      source.close(); await output.finalize();
      if (!packets || end <= start) throw new Error('No media packets were found.');
      const media = target.buffer!, sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', media)), n => n.toString(16).padStart(2, '0')).join('');
      // Measure the remuxed packets, including AAC padding, before exposing a ready sample.
      const objects = await segmentMedia(media, kind);
      const measuredStart = objects[0].start;
      const durationNs = String(BigInt(objects.at(-1)!.end) - BigInt(measuredStart));
      const stats = await track.computePacketStats();
      const avc = video && track === video ? (await video.getCodecParameterString())?.match(/^avc[13]\.([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i) : undefined;
      if (kind === 'video' && (!avc || !Number.isFinite(minTicks) || minTicks <= 0)) throw new Error('Video codec or frame timing could not be determined.');
      const technical: Sample['technical'] = video && track === video
        ? { format: 'urn:x-nmos:format:video', codec: 'video/h264', container: 'video/mp2t', avg_bit_rate: Math.ceil(stats.averageBitrate / 1000),
            essence_parameters: { frame_width: await video.getCodedWidth(), frame_height: await video.getCodedHeight(),
              ...(maxTicks - minTicks > 1 ? { vfr: true } : { frame_rate: { numerator: 90000, denominator: Math.round(90000 / stats.averagePacketRate) } }),
              avc_parameters: { profile: parseInt(avc![1], 16), flags: parseInt(avc![2], 16), level: parseInt(avc![3], 16) } } }
        : { format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'video/mp2t', avg_bit_rate: Math.ceil(stats.averageBitrate / 1000),
            essence_parameters: { sample_rate: await audio.getSampleRate(), channels: await audio.getNumberOfChannels() } };
      result.push({ bytes: media, sample: { id: `upload-${sha256.slice(0, 24)}-${kind}`, name: file.name.slice(0, 160), kind, imported: true,
        color: kind === 'video' ? '#8c9bff' : '#5cd6b1', file: '', bytes: media.byteLength, sha256, startNs: measuredStart, trackOffsetNs: ns(start), durationNs, technical } });
    }
    return result;
  } catch (error) {
    if (error instanceof UnsupportedInputFormatError) throw new Error('Use an MP4, MOV, TS, M4A or AAC file with H.264 video or AAC audio.');
    throw error;
  } finally { input.dispose(); }
}

if (typeof self !== 'undefined') self.onmessage = async ({ data }) => {
  try {
    if (data.file) { const tracks = await importMedia(data.file); self.postMessage({ tracks }, { transfer: tracks.map(t => t.bytes) }); }
    else { const objects = await segmentMedia(data.bytes, data.kind); self.postMessage({ objects }, { transfer: objects.map(o => o.bytes) }); }
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
