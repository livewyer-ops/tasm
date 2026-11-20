import { OmakasePlayer, MainMediaType, FileFormatType, PlayerEventType, ChromingTheme } from '@byomakase/omakase-player';
import Hls, { type LoaderContext, type LoaderConfiguration, type LoaderCallbacks } from 'hls.js';
import { firstValueFrom, timeout } from 'rxjs';
import { parseTimestamp, seconds, type ActionRecord, type Kind, type WorkspaceStore, type Workspace } from './workspace-store';

interface Chunk { kind: Kind; start: number; end: number; offset: number; url: string; filler: boolean; flowId?: string; objectId?: string; timerange?: string }
export type Selection = Record<Kind, string>;
const bounds = (range: string) => range.slice(1, -1).split('_').map(t => seconds(parseTimestamp(t)));
export const sourceEnd = (workspace?: Workspace) => Math.max(0, ...workspace?.lanes.flatMap(l => l.segments.map(s => bounds(s.timerange)[1])) ?? []);

// Virtual HLS is private to this player. It never adds media or endpoints to TAMS.
class TimelineMedia {
  readonly worker: Worker;
  readonly base = new URL(`./preview/${crypto.randomUUID()}/`, import.meta.url).href;
  readonly manifests = new Map<string, string>();
  readonly chunks = new Map<string, Chunk>();
  private cache = new Map<string, ArrayBuffer>();
  private cacheBytes = 0;
  private nextId = 0;
  private pending = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();
  private abort = new AbortController();
  private playback?: ActionRecord;
  constructor(workspace: Workspace, selection: Selection, readonly store: WorkspaceStore) {
    const end = sourceEnd(workspace);
    for (const kind of ['video', 'audio'] as const) {
      const lane = workspace.lanes.find(l => l.id === selection[kind]);
      const chunks: Chunk[] = [];
      const fill = (start: number, stop: number) => {
        for (let t = start; t < stop - 0.000001; t += 4) chunks.push({ kind, start: t, end: Math.min(t + 4, stop), offset: 0, filler: true, url: new URL(`./samples/${kind === 'video' ? 'black' : 'silence'}.ts`, import.meta.url).href });
      };
      let cursor = 0;
      for (const segment of lane?.segments ?? []) {
        const [start, stop] = bounds(segment.timerange);
        if (start < cursor - 0.000001 || stop <= start) throw new Error('Preview requires ordered, non-overlapping segments');
        fill(cursor, start);
        const url = segment.get_urls?.[0]?.url;
        if (!url) throw new Error('TAMS segment has no readable object URL');
        chunks.push({ kind, start, end: stop, offset: seconds(parseTimestamp(segment.ts_offset ?? '0:0')), url, filler: false,
          flowId: lane!.flow.id, objectId: segment.object_id, timerange: segment.timerange });
        cursor = stop;
      }
      fill(cursor, end);
      const entries = chunks.map((chunk, index) => {
        const url = `${this.base}${kind}-${index}.ts`; this.chunks.set(url, chunk);
        return `#EXTINF:${(chunk.end - chunk.start).toFixed(9)},\n${url}`;
      });
      this.manifests.set(`${this.base}${kind}.m3u8`, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...chunks.map(c => c.end - c.start)))}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n${entries.join('\n')}\n#EXT-X-ENDLIST\n`);
    }
    this.manifests.set(`${this.base}master.m3u8`, `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Timeline audio",DEFAULT=YES,AUTOSELECT=YES,URI="${this.base}audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="audio"\n${this.base}video.m3u8\n`);
    this.worker = new Worker(new URL('./preview-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id); this.pending.delete(data.id);
      if (data.error) pending?.reject(new Error(data.error)); else pending?.resolve(data.bytes);
    };
    this.worker.onerror = event => { for (const p of this.pending.values()) p.reject(new Error(event.message)); this.pending.clear(); };
  }
  private remember(key: string, bytes: ArrayBuffer) {
    // Bound both original bytes and generated chunks, including long empty timelines.
    while (this.cacheBytes + bytes.byteLength > 32 * 1024 * 1024 && this.cache.size) {
      const key = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(key)!.byteLength; this.cache.delete(key);
    }
    if (bytes.byteLength <= 32 * 1024 * 1024 && !this.cache.has(key)) { this.cache.set(key, bytes); this.cacheBytes += bytes.byteLength; }
    return bytes;
  }
  async read(url: string): Promise<string | ArrayBuffer> {
    this.abort.signal.throwIfAborted();
    const manifest = this.manifests.get(url); if (manifest) return manifest;
    const cached = this.cache.get(url); if (cached) return cached.slice(0);
    const chunk = this.chunks.get(url); if (!chunk) throw new Error('Unknown preview resource');
    let original = this.cache.get(chunk.url);
    if (!original) {
      // Fetch in the page: the TAMS service worker routes via its window client.
      let bytes: ArrayBuffer;
      if (chunk.filler) {
        const response = await fetch(chunk.url, { signal: this.abort.signal });
        if (!response.ok) throw new Error(`Preview fixture read failed: ${response.status}`);
        bytes = await response.arrayBuffer();
      } else {
        this.playback ??= this.store.beginAction('Playback', true);
        bytes = await this.store.action('Playback', action => this.store.request<ArrayBuffer>(action, chunk.url, 'GET', undefined, undefined,
          { signal: this.abort.signal, binary: true, flowId: chunk.flowId, objectId: chunk.objectId, timerange: chunk.timerange }), this.playback);
      }
      original = this.remember(chunk.url, bytes);
    }
    this.abort.signal.throwIfAborted();
    const id = ++this.nextId, bytes = original.slice(0);
    const result = await new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, ...chunk, bytes }, [bytes]);
    });
    this.remember(url, result); return result.slice(0);
  }
  destroy() {
    this.abort.abort(); this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new DOMException('Preview replaced', 'AbortError'));
    this.pending.clear(); this.cache.clear(); this.cacheBytes = 0;
  }
}

export class Preview extends EventTarget {
  readonly omakase: OmakasePlayer;
  currentTime = 0;
  loaded = false;
  private unsavedChoices = new Map<string, Partial<Selection>>();
  selection: Selection = { video: '', audio: '' };
  private generation = 0;
  private destroyed = false;
  private sourceId?: string;
  private media?: TimelineMedia;
  private rangeFrame?: number;
  private rangeTimer?: ReturnType<typeof setTimeout>;
  private rangeEnd?: number;
  private rangeAlignment?: number;
  private rangeVersion = 0;
  constructor(readonly store: WorkspaceStore, chromingTheme = ChromingTheme.DEFAULT) {
    super();
    const preview = this;
    class TimelineLoader extends Hls.DefaultConfig.loader {
      override load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
        const media = preview.media;
        if (!media || !context.url.startsWith(media.base)) { super.load(context, config, callbacks); return; }
        this.context = context; this.stats.loading.start = performance.now();
        void media.read(context.url).then(data => {
          if (this.stats.aborted) return;
          this.stats.loading.first = this.stats.loading.end = performance.now();
          this.stats.loaded = this.stats.total = typeof data === 'string' ? data.length : data.byteLength;
          callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, null);
        }).catch(error => { if (!this.stats.aborted) callbacks.onError({ code: 0, text: error.message }, context, null, this.stats); });
      }
      override abort() { this.stats.aborted = true; super.abort(); }
    }
    this.omakase = new OmakasePlayer({ playerHtmlElementId: 'omakase-player', chromingTheme, chromingStyleUrl: new URL('./omakase.css', import.meta.url).href,
      playerControllerConfig: { [MainMediaType.HLS]: { hlsConfig: { loader: TimelineLoader, maxBufferLength: 12, maxMaxBufferLength: 20, backBufferLength: 8 } } } });
    this.omakase.player.onEvent$.subscribe(event => {
      // The final boundary alignment is part of completing the range; other seeks cancel it.
      if (event.type === PlayerEventType.PLAYER_SEEKING && (this.rangeAlignment === undefined || Math.abs(event.data.toTime - this.rangeAlignment) > 0.05)) this.stopRange();
      if (event.type === PlayerEventType.PLAYER_PAUSE && this.rangeEnd !== undefined && event.data.currentTime < this.rangeEnd - 0.005) this.stopRange();
      if (event.type === PlayerEventType.PLAYER_ENDED) {
        const end = this.rangeEnd ?? this.rangeAlignment;
        if (end !== undefined && event.data.currentTime >= end - 0.005) {
          this.stopRange(false); this.dispatchEvent(new Event('rangeend'));
        }
      }
      if (event.type === PlayerEventType.PLAYER_PLAYBACK_PROGRESS && this.loaded) {
        this.currentTime = this.omakase.player.getCurrentTime(); this.dispatchEvent(new Event('time'));
      }
    });
  }
  choices(workspace?: Workspace) {
    let saved: Partial<Selection> = {};
    try { saved = JSON.parse(localStorage.getItem(`tasm-preview:${workspace?.root.id}`) ?? '{}'); } catch { /* use collection defaults */ }
    saved = { ...saved, ...this.unsavedChoices.get(workspace?.root.id ?? '') };
    for (const kind of ['video', 'audio'] as const) {
      this.selection[kind] = saved[kind] === '' || workspace?.lanes.some(l => l.kind === kind && l.id === saved[kind]) ? saved[kind]! : workspace?.lanes.find(l => l.kind === kind && l.blocks.length)?.id ?? '';
    }
    return this.selection;
  }
  select(workspace: Workspace, kind: Kind, id: string) {
    this.selection[kind] = id;
    const key = `tasm-preview:${workspace.root.id}`;
    let explicit: Partial<Selection> = {};
    try { explicit = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { /* reset malformed preferences */ }
    const choices = { ...explicit, ...this.unsavedChoices.get(workspace.root.id), [kind]: id };
    try { localStorage.setItem(key, JSON.stringify(choices)); this.unsavedChoices.delete(workspace.root.id); }
    catch { this.unsavedChoices.set(workspace.root.id, choices); }
  }
  stopRange(notify = true) {
    const active = this.rangeEnd !== undefined || this.rangeAlignment !== undefined;
    ++this.rangeVersion;
    const video = document.querySelector<HTMLVideoElement>('#omakase-player video');
    if (this.rangeFrame !== undefined) video?.cancelVideoFrameCallback(this.rangeFrame);
    clearTimeout(this.rangeTimer); this.rangeFrame = undefined; this.rangeEnd = this.rangeAlignment = undefined;
    if (active && notify) this.dispatchEvent(new Event('rangecancel'));
  }
  pause() { this.stopRange(); document.querySelector<HTMLVideoElement>('#omakase-player video')?.pause(); }
  async playRange(start: number, end: number) {
    this.stopRange();
    if (this.loaded) await firstValueFrom(this.omakase.player.pause().pipe(timeout(10000)));
    await this.seek(start);
    if (!this.loaded || end <= start || end > this.omakase.player.getDuration()) throw new Error('Choose a range inside the source duration.');
    const video = document.querySelector<HTMLVideoElement>('#omakase-player video')!;
    this.rangeEnd = end;
    const finish = () => {
      this.stopRange(false); let version = this.rangeVersion;
      const generation = this.generation;
      this.rangeAlignment = Math.min(end, this.omakase.player.getDuration() - 0.04);
      // Omakase advances one frame when pausing. Wait for that alignment, then
      // leave the displayed frame at the requested boundary using its public API.
      void firstValueFrom(this.omakase.player.pause().pipe(timeout(10000))).then(async () => {
        if (version !== this.rangeVersion || generation !== this.generation || !this.loaded || !video.paused) return;
        const alignment = this.seek(end, true); version = this.rangeVersion;
        await alignment;
        if (version === this.rangeVersion && generation === this.generation && this.loaded && video.paused) {
          this.rangeAlignment = undefined; this.dispatchEvent(new Event('rangeend'));
        }
      }).catch(error => {
        if (version === this.rangeVersion) { this.stopRange(); this.dispatchEvent(new CustomEvent('error', { detail: error.message })); }
      });
    };
    const check = () => {
      if (this.rangeEnd === undefined) return;
      if (video.currentTime >= this.rangeEnd - 0.005) finish();
      else this.rangeTimer = setTimeout(check, Math.min(10, Math.max(1, (this.rangeEnd - video.currentTime) * 1000 / video.playbackRate)));
    };
    const frame = () => { if (this.rangeEnd !== undefined) { if (video.currentTime >= this.rangeEnd - 0.005) check(); else this.rangeFrame = video.requestVideoFrameCallback(frame); } };
    if (video.requestVideoFrameCallback) this.rangeFrame = video.requestVideoFrameCallback(frame);
    check();
    try { await firstValueFrom(this.omakase.player.play().pipe(timeout(10000))); }
    catch (error) { this.pause(); throw error; }
  }
  async update(workspace?: Workspace, resume = false) {
    this.stopRange();
    const generation = ++this.generation;
    const video = document.querySelector<HTMLVideoElement>('#omakase-player video');
    const wasPlaying = resume && !!video && !video.paused;
    const desiredTime = this.sourceId === workspace?.root.source_id ? video?.currentTime ?? this.currentTime : 0;
    const rate = video?.playbackRate ?? 1;
    this.sourceId = workspace?.root.source_id; this.loaded = false;
    this.media?.destroy(); this.media = undefined;
    await firstValueFrom(this.omakase.player.unloadMainMedia());
    if (generation !== this.generation) return;
    this.choices(workspace);
    const end = sourceEnd(workspace);
    if (!workspace || !end) { this.currentTime = 0; this.dispatchEvent(new Event('time')); return; }
    this.media = new TimelineMedia(workspace, this.selection, this.store);
    try {
      const video = workspace.lanes.find(l => l.id === this.selection.video), rate = video?.blocks[0]?.sample.technical.essence_parameters.frame_rate;
      await firstValueFrom(this.omakase.loadMainMedia(`${this.media.base}master.m3u8`, { mainMediaType: MainMediaType.HLS, fileFormatType: FileFormatType.HLS, frameRate: rate ? rate.numerator / rate.denominator : 25, duration: end, forceSkipMetadataResolution: true }).pipe(timeout(45000)));
    } catch (error) { if (generation !== this.generation) return; throw error; }
    if (generation !== this.generation) return;
    this.omakase.player.getPlaybackEngine(MainMediaType.HLS).hls?.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal && generation === this.generation) {
        this.pause(); this.loaded = false;
        this.dispatchEvent(new CustomEvent('error', { detail: data.error?.message ?? data.details }));
      }
    });
    this.loaded = true; this.currentTime = Math.min(desiredTime, end);
    if (this.currentTime > 0) await this.seek(this.currentTime);
    if (generation !== this.generation) return;
    const current = document.querySelector<HTMLVideoElement>('#omakase-player video');
    if (current) { current.playbackRate = rate; if (wasPlaying) await current.play(); }
    this.dispatchEvent(new Event('time'));
  }
  async seek(time: number, alignRange = false) {
    const generation = this.generation;
    this.stopRange(!alignRange);
    this.currentTime = Math.max(0, time);
    if (this.loaded) {
      const target = Math.min(this.currentTime, this.omakase.player.getDuration() - 0.04);
      if (alignRange) this.rangeAlignment = target;
      await firstValueFrom(this.omakase.player.seekTo(target).pipe(timeout(10000)));
      if (generation !== this.generation) return;
      this.currentTime = this.omakase.player.getCurrentTime();
    }
    this.dispatchEvent(new Event('time'));
  }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.stopRange(); ++this.generation; this.media?.destroy(); this.omakase.destroy(); }
}
