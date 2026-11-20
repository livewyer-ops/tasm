import { Input, BufferSource, MPEG_TS, EncodedPacketSink, Output, BufferTarget, MpegTsOutputFormat, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';

// Remux encoded packets only: no browser encoder or server is needed.
self.onmessage = async ({ data: { id, bytes, kind, start, end, offset, filler } }) => {
  const input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
  try {
    const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    if (!track) throw new Error(`Missing ${kind} track in TAMS object`);
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error('Missing decoder configuration');
    const target = new BufferTarget();
    const output = new Output({ format: new MpegTsOutputFormat(), target });
    const source = kind === 'video' ? new EncodedVideoPacketSource('avc') : new EncodedAudioPacketSource('aac');
    if (source instanceof EncodedVideoPacketSource) output.addVideoTrack(source);
    else output.addAudioTrack(source);
    await output.start();
    for await (const packet of new EncodedPacketSink(track).packets()) {
      const time = packet.timestamp + (filler ? start : offset);
      if (time < start - 0.000001 || time >= end - 0.000001) continue;
      await source.add(packet.clone({ timestamp: time, duration: Math.min(packet.duration, end - time) }), { decoderConfig } as never);
    }
    source.close(); await output.finalize();
    self.postMessage({ id, bytes: target.buffer }, { transfer: [target.buffer!] });
  } catch (error) { self.postMessage({ id, error: String(error) }); }
  finally { input.dispose(); }
};
