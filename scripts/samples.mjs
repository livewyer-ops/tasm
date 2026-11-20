import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Fixtures are checked in; FFmpeg is only needed to regenerate them.
await mkdir('apps/shared/samples', { recursive: true });
const definitions = [
  { id: 'orbit', name: 'Orbit', kind: 'video', seconds: 6.4, color: '#8c9bff', input: 'testsrc2=size=640x360:rate=25', filter: "drawtext=text='ORBIT  %{pts\\:hms}':fontcolor=white:fontsize=28:x=24:y=24:box=1:boxcolor=black@0.6:boxborderw=10" },
  { id: 'grid', name: 'Signal grid', kind: 'video', seconds: 3.2, color: '#5cd6b1', input: 'color=c=0x173d40:size=640x360:rate=25', filter: "drawgrid=width=64:height=60:thickness=1:color=0x5cd6b1@0.5,drawbox=x=0:y=140:w=640:h=80:color=0x122529:t=fill,drawtext=text='SIGNAL  %{pts\\:hms}':fontcolor=white:fontsize=30:x='mod(t*90,400)':y=162" },
  { id: 'bars', name: 'Colour bars', kind: 'video', seconds: 6.4, color: '#f0b86b', input: 'smptebars=size=640x360:rate=25', filter: "drawtext=text='COLOUR  %{pts\\:hms}':fontcolor=white:fontsize=28:x=24:y=24:box=1:boxcolor=black@0.7:boxborderw=10" },
  { id: 'pulse', name: 'Soft pulse', kind: 'audio', seconds: 6.4, color: '#5cd6b1', input: 'aevalsrc=0.18*sin(2*PI*220*t)*exp(-9*mod(t\,0.4)):s=48000' },
  { id: 'chord', name: 'Warm chord', kind: 'audio', seconds: 6.4, color: '#f0b86b', input: 'aevalsrc=0.055*(sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+sin(2*PI*392*t)):s=48000' },
  { id: 'ping', name: 'Bright ping', kind: 'audio', seconds: 3.2, color: '#8c9bff', input: 'aevalsrc=0.18*sin(2*PI*(520+60*sin(t))*t)*exp(-7*mod(t\,0.8)):s=48000' },
];
definitions.push(
  { id: 'newsreader-offset', name: 'Newsreader · offset example', kind: 'video', seconds: 10, color: '#8c9bff', source: 'newsreader.ts', filter: 'scale=640:360', gop: 50 },
  { id: 'voice-a', name: 'Voice A · ready for the programme', kind: 'audio', category: 'speech', color: '#5cd6b1', phrases: [['we', 'are', 'ready', 'now'], ['we', 'can', 'make', 'this', 'good'], ['we', 'will', 'have', 'more', 'cheese', 'and green custard']] },
  { id: 'voice-b', name: 'Voice B · an interruption', kind: 'audio', category: 'speech', color: '#f0b86b', phrases: [['I', 'am', 'secretly', 'wonky'], ['you', 'are', 'suspicious']] },
);
const supplied = JSON.parse(await readFile('apps/shared/samples/manifest.json', 'utf8')).filter(s => (s.category === 'speech' || s.id === 'newsreader') && !definitions.some(item => item.id === s.id));
const manifest = [];
for (const item of definitions) {
  const file = `${item.id}.ts`;
  let pcm;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (item.phrases) {
    const chunks = [];
    for (const [i, phrase] of item.phrases.entries()) {
      for (const [j, word] of phrase.entries()) {
        if (i || j) chunks.push(Buffer.alloc(Math.round((j ? 0.15 : 0.4) * 48000) * 2 * 4));
        const sample = supplied.find(s => s.name === word);
        if (!sample) throw new Error(`Missing supplied voice: ${word}`);
        chunks.push(execFileSync('ffmpeg', ['-v', 'error', '-i', `apps/shared/samples/${sample.file}`, '-f', 'f32le', '-ar', '48000', '-ac', '2', '-']));
      }
    }
    pcm = Buffer.concat(chunks);
    args.push('-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0');
  } else if (item.source) args.push('-i', `apps/shared/samples/${item.source}`);
  else args.push('-f', 'lavfi', '-i', item.input.replaceAll('mod(t,', 'mod(t\\,'));
  if (item.seconds) args.push('-t', String(item.seconds));
  if (item.kind === 'video') args.push('-vf', item.filter, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-pix_fmt', 'yuv420p', '-g', String(item.gop ?? 25), '-bf', '0', '-sc_threshold', '0');
  else {
    if (item.seconds) args.push('-af', 'afade=t=in:d=0.025,afade=t=out:st=' + (item.seconds - 0.06) + ':d=0.06');
    args.push('-vn', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
  }
  execFileSync('ffmpeg', [...args, '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', `apps/shared/samples/${file}`], { input: pcm });
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-show_streams', '-of', 'json', `apps/shared/samples/${file}`]));
  const packets = probe.packets.filter(p => p.stream_index === 0);
  // MPEG-TS PTS ticks are exact integers at 90 kHz; retain their measured bounds.
  const first = Math.min(...packets.map(p => Number(p.pts)));
  const last = Math.max(...packets.map(p => Number(p.pts) + Number(p.duration)));
  const ns = ticks => String(BigInt(ticks) * 1000000000n / 90000n);
  const bytes = await readFile(`apps/shared/samples/${file}`);
  let waveform;
  if (item.kind === 'video') execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `apps/shared/samples/${file}`, '-frames:v', '1', '-vf', 'scale=320:180', `apps/shared/samples/${item.id}.jpg`]);
  else {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', `apps/shared/samples/${file}`, '-f', 'f32le', '-ac', '1', '-ar', '8000', '-']);
    const values = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    waveform = Array.from({ length: 64 }, (_, i) => {
      let peak = 0;
      for (let n = Math.floor(i * values.length / 64); n < Math.floor((i + 1) * values.length / 64); n++) peak = Math.max(peak, Math.abs(values[n]));
      return Math.round(peak * 1000) / 1000;
    });
  }
  manifest.push({ ...(item.category ? { category: item.category } : {}), id: item.id, name: item.name, kind: item.kind, color: item.color, file,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    startNs: ns(first), durationNs: ns(last - first), thumbnail: item.kind === 'video' ? `${item.id}.jpg` : undefined, waveform,
    technical: item.kind === 'video'
      ? { format: 'urn:x-nmos:format:video', codec: 'video/h264', container: 'video/mp2t', avg_bit_rate: Math.ceil(bytes.length * 8 / ((last - first) / 90000) / 1000), essence_parameters: { frame_width: 640, frame_height: 360, frame_rate: { numerator: 25, denominator: 1 }, interlace_mode: 'progressive', avc_parameters: { profile: 100, level: 30, flags: 0 } } }
      : { format: 'urn:x-nmos:format:audio', codec: 'audio/aac', container: 'video/mp2t', avg_bit_rate: 128, essence_parameters: { sample_rate: 48000, channels: 2 } } });
}
await writeFile('apps/shared/samples/manifest.json', JSON.stringify([...manifest, ...supplied], null, 2) + '\n');
// Hidden preview fixtures; these never become library samples or TAMS records.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:size=640x360:rate=25', '-t', '4', '-an', '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'high', '-level:v', '3.0', '-pix_fmt', 'yuv420p', '-g', '25', '-bf', '0', '-sc_threshold', '0', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'apps/shared/samples/black.ts']);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '4', '-vn', '-c:a', 'aac', '-b:a', '128k', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'apps/shared/samples/silence.ts']);
