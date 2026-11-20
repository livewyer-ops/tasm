import sampleData from './samples/manifest.json';
import type { PreparedObject } from './ingest-worker';
import { libraryBytes, mediaWorker } from './sample-library';
import { abortable } from '../../core/browser/lifecycle';

export type Sample = Omit<typeof sampleData[number], 'technical' | 'category'> & { imported?: boolean; trackOffsetNs?: string; category?: 'speech'; technical: Technical };
export const samples = sampleData as Sample[];
export interface Technical {
  format: string; codec: string; container: string; avg_bit_rate?: number;
  essence_parameters: { frame_width?: number; frame_height?: number; frame_rate?: { numerator: number; denominator: number }; vfr?: boolean;
    interlace_mode?: string; avc_parameters?: { profile: number; level: number; flags: number }; sample_rate?: number; channels?: number };
}
export type Kind = 'video' | 'audio';
export interface Flow {
  id: string; source_id: string; label?: string; format: string; container?: string;
  tags?: Record<string, string[]>; flow_collection?: { id: string; role?: string }[];
  [key: string]: unknown;
}
export interface Segment { object_id: string; timerange: string; ts_offset?: string; object_timerange?: string; get_urls?: { url: string }[]; [key: string]: unknown }
export interface Block { sample: Sample; start: bigint; key: string; profile: string; checksum: string; segments: Segment[]; partial?: boolean; sourceRange?: [bigint, bigint]; boundaries?: bigint[] }
export interface Lane { id: string; flow: Flow; kind: Kind; blocks: Block[]; segments: Segment[] }
export interface Workspace { root: Flow; lanes: Lane[] }
export interface DraftWorkspace { base: Workspace; workspace: Workspace }
export interface EditChange { laneId: string; start?: bigint; sample?: Sample; fromLaneId?: string; key?: string; segment?: { objectId: string; timerange: string }; remove?: boolean; step?: boolean; insert?: boolean; boundaries?: bigint[] }
export type Stage = 'segment' | 'allocate' | 'upload' | 'register' | 'update';
export interface RequestContext { stage?: Stage | 'query' | 'read'; blockId?: string; flowId?: string; objectId?: string; objectIds?: string[]; timerange?: string }
export interface RequestRecord extends RequestContext {
  method: string; url: string; headers: Record<string, string>; body?: unknown; rawBody?: string;
  status?: number; response?: unknown; responseHeaders?: Record<string, string>; ms?: number; error?: string;
}
export interface NarrativeEvent { position: number; title: string; detail: string; state: 'Pending' | 'Succeeded' | 'Failed' | 'Cancelled'; ms?: number }
export interface FlowChange { laneId: string; oldId?: string; newId: string; state: 'creating' | 'created' | 'published' | 'failed' | 'unconfirmed'; retirement?: 'pending' | 'deleted' | 'failed'; error?: string }
export interface ActionRecord { id: string; name: string; requests: RequestRecord[]; events?: NarrativeEvent[]; flows?: FlowChange[]; error?: string; pending: boolean; playback?: boolean }
export class RequestError extends Error {
  constructor(readonly record: RequestRecord, message: string) { super(message); }
}
interface RequestOptions extends RequestContext { signal?: AbortSignal; binary?: boolean; headers?: Record<string, string>; rawBody?: string }
export interface IngestObject { segment: Segment; sample?: Sample; bytes: number; state: 'prepared' | 'allocated' | 'uploaded' | 'registered'; reused: boolean }
export const PROFILE = 'mediabunny-1.58.0/mpegts/hls-2s/v1';
const BLOCK_TAG = 'tasm.playpen.blocks.v1';
export const NS = 1000000000n;
export const seconds = (n: bigint) => Number(n) / 1e9;
export const timestamp = (n: bigint) => `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / NS}:${(n < 0n ? -n : n) % NS}`;
export function parseTimestamp(value: string): bigint {
  const negative = value.startsWith('-'), [s, ns] = value.replace(/^-/, '').split(':');
  return (BigInt(s) * NS + BigInt(ns)) * (negative ? -1n : 1n);
}
export const bounds = (value: string) => value.slice(1, -1).split('_').map(parseTimestamp);
export const range = (start: bigint, end: bigint) => `[${timestamp(start)}_${timestamp(end)})`;
export const blockEnd = (b: Block) => b.segments.length ? bounds(b.segments.at(-1)!.timerange)[1] : b.start + (b.sourceRange ? b.sourceRange[1] - b.sourceRange[0] : BigInt(b.sample.durationNs));
export const blockBoundaries = (b: Block): bigint[] => b.segments.length ? [b.start, ...b.segments.map(s => bounds(s.timerange)[1])]
  : (b.boundaries ?? []).filter(t => !b.sourceRange || t >= b.sourceRange[0] && t <= b.sourceRange[1]).map(t => b.start + t - (b.sourceRange?.[0] ?? 0n));
function shiftedBlock(block: Block, shift: bigint): Block {
  return { ...block, start: block.start + shift, segments: block.segments.map(s => ({ ...s,
    timerange: range(bounds(s.timerange)[0] + shift, bounds(s.timerange)[1] + shift), ts_offset: timestamp(parseTimestamp(s.ts_offset ?? '0:0') + shift) })) };
}
function splitBlock(block: Block, at: bigint): Block[] {
  if (!blockBoundaries(block).includes(at)) throw new Error('Insert at a segment boundary.');
  const cut = (block.sourceRange?.[0] ?? 0n) + at - block.start;
  return [
    { ...block, partial: true, segments: block.segments.filter(s => bounds(s.timerange)[1] <= at),
      ...(!block.segments.length ? { sourceRange: [block.sourceRange?.[0] ?? 0n, cut] as [bigint, bigint] } : {}) },
    { ...block, key: crypto.randomUUID(), start: at, partial: true, segments: block.segments.filter(s => bounds(s.timerange)[0] >= at),
      ...(!block.segments.length ? { sourceRange: [cut, block.sourceRange?.[1] ?? BigInt(block.sample.durationNs)] as [bigint, bigint] } : {}) },
  ];
}
export function reusableSample(blocks: Block[], sample: Sample): Block | undefined {
  const candidates = blocks.filter(b => b.sample.id === sample.id && b.checksum === sample.sha256 && b.profile === PROFILE && b.segments.length);
  const full = candidates.find(b => !b.partial);
  if (full) return full;
  // Split clips still cover a complete sample when their original ranges join without gaps.
  const segments = [...new Map(candidates.flatMap(b => b.segments.map(s => {
    const offset = parseTimestamp(s.ts_offset ?? '0:0'), [a, b] = bounds(s.timerange);
    const original = { ...s, timerange: range(a - offset, b - offset), ts_offset: '0:0' };
    return [original.timerange, original] as const;
  }))).values()].sort((a, b) => bounds(a.timerange)[0] < bounds(b.timerange)[0] ? -1 : 1);
  const start = BigInt(sample.startNs);
  if (!segments.length || bounds(segments[0].timerange)[0] !== start || bounds(segments.at(-1)!.timerange)[1] !== start + BigInt(sample.durationNs) ||
      segments.some((s, i) => i && bounds(segments[i - 1].timerange)[1] !== bounds(s.timerange)[0])) return;
  return { sample, start, key: candidates[0].key, profile: PROFILE, checksum: sample.sha256, segments };
}
export const tag = (f: Flow, name: string) => f.tags?.[`tasm.playpen.${name}`]?.[0];
function restoredMedia(value: Partial<Sample> | undefined, flow: Flow): Sample | undefined {
  if (!value) return;
  if (typeof value.id !== 'string' || !/^upload-[a-f0-9]{24}-(video|audio)$/.test(value.id) || typeof value.name !== 'string' || value.name.length > 160 ||
      !['audio', 'video'].includes(value.kind ?? '') || flow.format !== `urn:x-nmos:format:${value.kind}` ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.durationNs !== 'string' || !/^\d{1,14}$/.test(value.durationNs) || BigInt(value.durationNs) <= 0n ||
      typeof value.startNs !== 'string' || !/^\d{1,20}$/.test(value.startNs) || !Number.isSafeInteger(value.bytes) || value.bytes! <= 0) throw new Error('Invalid imported media metadata');
  if (value.trackOffsetNs !== undefined && (typeof value.trackOffsetNs !== 'string' || !/^\d{1,14}$/.test(value.trackOffsetNs))) throw new Error('Invalid imported track offset');
  return { trackOffsetNs: value.trackOffsetNs, id: value.id, name: value.name, kind: value.kind!, sha256: value.sha256, durationNs: value.durationNs, startNs: value.startNs, bytes: value.bytes!,
    imported: true, file: '', color: value.kind === 'video' ? '#8c9bff' : '#5cd6b1',
    technical: { format: flow.format, codec: String(flow.codec), container: String(flow.container), avg_bit_rate: flow.avg_bit_rate as number | undefined, essence_parameters: flow.essence_parameters as Technical['essence_parameters'] } };
}
const mediaFormat = (sample: Sample) => {
  const p = sample.technical.essence_parameters;
  return JSON.stringify([sample.kind, sample.technical.codec, p.frame_width, p.frame_height, p.frame_rate ? p.frame_rate.numerator / p.frame_rate.denominator : null,
    p.vfr ?? false, p.avc_parameters?.profile, p.avc_parameters?.level, p.avc_parameters?.flags, p.sample_rate, p.channels]);
};
export const audioSettings = (sample: Sample) => `${sample.technical.essence_parameters.sample_rate} Hz, ${sample.technical.essence_parameters.channels} channel${sample.technical.essence_parameters.channels === 1 ? '' : 's'}`;
export function validateWorkspace(workspace: Workspace) {
  for (const lane of workspace.lanes) {
    const blocks = [...lane.blocks].sort((a, b) => a.start < b.start ? -1 : 1);
    for (const [i, block] of blocks.entries()) {
      if (block.sample.kind !== lane.kind) throw new Error(`Place ${block.sample.kind} in a ${block.sample.kind} flow.`);
      if (block.sourceRange && (block.sourceRange[0] < 0n || block.sourceRange[1] > BigInt(block.sample.durationNs) || block.sourceRange[0] >= block.sourceRange[1] || !block.sourceRange.every(t => block.boundaries?.includes(t)))) throw new Error('Invalid draft media range.');
      if (block.start < 0n || blockEnd(block) > 86400n * NS || blockEnd(block) <= block.start) throw new Error('Keep this playpen within 24 hours.');
      if (mediaFormat(block.sample) !== mediaFormat(blocks[0].sample)) throw new Error(lane.kind === 'audio'
        ? `${block.sample.name} uses ${audioSettings(block.sample)}; ${blocks[0].sample.name} uses ${audioSettings(blocks[0].sample)}. Create a matching audio flow. The sample remains in the library.`
        : 'These clips have different video settings. Create a matching video flow. The sample remains in the library.');
      if (i && block.start < blockEnd(blocks[i - 1])) throw new Error('Blocks cannot overlap in the same flow. Choose an empty part of the timeline.');
    }
  }
}
export const laneSnapshot = (lane: Lane) => JSON.stringify({ kind: lane.kind, label: lane.flow.label, blocks: lane.blocks }, (key, value) => key === 'get_urls' ? undefined : typeof value === 'bigint' ? value.toString() : value);
export function addDraftLane(workspace: Workspace, kind: Kind, label: string): Workspace {
  const technical = samples.find(s => s.kind === kind)!.technical;
  return { ...workspace, lanes: [...workspace.lanes, { id: crypto.randomUUID(), kind, flow: { ...technical, id: '', source_id: '', label }, blocks: [], segments: [] }] };
}
export function editWorkspace(workspace: Workspace, change: EditChange): Workspace {
  const target = workspace.lanes.find(l => l.id === change.laneId);
  if (!target) throw new Error('The flow changed. Select an existing flow.');
  const source = workspace.lanes.find(l => l.id === change.fromLaneId), previous = source?.blocks.find(b => b.key === change.key);
  if (change.key && !previous) throw new Error('The clip changed. Select it again.');
  const index = change.segment ? previous?.segments.findIndex(s => s.object_id === change.segment!.objectId && s.timerange === change.segment!.timerange) : undefined;
  if (change.segment && (index === undefined || index < 0)) throw new Error('The segment changed. Select it again.');
  const picked = previous && index !== undefined ? { ...previous, segments: [previous.segments[index]], start: bounds(previous.segments[index].timerange)[0],
    key: previous.segments.length === 1 ? previous.key : crypto.randomUUID(), partial: previous.partial || previous.segments.length > 1 || undefined } : previous;
  const sample = change.sample ?? previous?.sample;
  if (!sample || target.kind !== sample.kind) throw new Error('Drop video on a video flow, or audio on an audio flow.');
  const lanes = workspace.lanes.map(lane => ({ ...lane, blocks: lane.blocks.filter(b => !(lane.id === source?.id && b.key === change.key)) }));
  if (previous && source && index !== undefined) {
    const runs = [previous.segments.slice(0, index), previous.segments.slice(index + 1)].filter(s => s.length);
    lanes.find(l => l.id === source.id)!.blocks.push(...runs.map((segments, i) => ({ ...previous, segments, start: bounds(segments[0].timerange)[0], key: i === 0 ? previous.key : crypto.randomUUID(), partial: true })));
  }
  if (!change.remove) {
    const start = change.start ?? 0n;
    const reusable = picked ?? reusableSample(workspace.lanes.flatMap(l => l.blocks), sample);
    const block: Block = reusable ? { ...shiftedBlock(reusable, start - reusable.start), key: picked?.key ?? crypto.randomUUID() }
      : { sample, start, key: crypto.randomUUID(), profile: PROFILE, checksum: sample.sha256, segments: [], ...(change.boundaries ? { boundaries: change.boundaries } : {}) };
    const destination = lanes.find(l => l.id === target.id)!;
    if (change.insert) {
      const duration = blockEnd(block) - start;
      destination.blocks = destination.blocks.flatMap(b => b.start < start && blockEnd(b) > start ? splitBlock(b, start) : [b])
        .map(b => b.start >= start ? shiftedBlock(b, duration) : b);
    }
    destination.blocks.push(block);
  }
  for (const lane of lanes) { lane.blocks.sort((a, b) => a.start < b.start ? -1 : 1); lane.segments = lane.blocks.flatMap(b => b.segments); }
  const result = { ...workspace, lanes }; validateWorkspace(result); return result;
}

export interface MovingItem { laneId: string; key: string; segment?: { objectId: string; timerange: string } }
export function planPlacement(workspace: Workspace, target: Lane, sample: Sample, raw: bigint, duration: bigint, pixelsPerSecond: number, segments: boolean, from?: MovingItem, exact = false) {
  if (!from && sample.trackOffsetNs) raw += BigInt(sample.trackOffsetNs);
  const source = workspace.lanes.find(l => l.id === from?.laneId)?.blocks.find(b => b.key === from?.key);
  const origin = from?.segment ? bounds(from.segment.timerange)[0] : source?.start;
  if (from?.laneId === target.id && raw === origin) return { start: raw, invalid: false, noop: true, insert: false, snapped: undefined as bigint | undefined, error: undefined as string | undefined };
  const remaining = from ? editWorkspace(workspace, { laneId: from.laneId, fromLaneId: from.laneId, key: from.key, segment: from.segment, remove: true }) : workspace;
  const hit = remaining.lanes.find(l => l.id === target.id)!.blocks.find(b => raw >= b.start && raw < blockEnd(b));
  if (!hit) return { ...(exact ? { start: raw, invalid: false, snapped: undefined as bigint | undefined } : snapPlacement(workspace, target, sample, raw, duration, pixelsPerSecond, segments, from)), insert: false, noop: false, error: undefined as string | undefined };
  const edges = blockBoundaries(hit);
  if (!edges.length) return { start: raw, invalid: true, insert: true, noop: false, snapped: undefined as bigint | undefined, error: 'Preparing segment boundaries. Try again shortly.' };
  const abs = (n: bigint) => n < 0n ? -n : n;
  const start = edges.reduce((best, edge) => abs(edge - raw) < abs(best - raw) ? edge : best);
  let error: string | undefined;
  try { editWorkspace(workspace, { laneId: target.id, start, sample: from ? undefined : sample, fromLaneId: from?.laneId, key: from?.key, segment: from?.segment, insert: true }); }
  catch (e) { error = (e as Error).message; }
  return { start, invalid: !!error, insert: true, noop: false, snapped: start, error };
}
export function snapPlacement(workspace: Workspace, target: Lane, sample: Sample, raw: bigint, duration: bigint, pixelsPerSecond: number, segments: boolean, from?: MovingItem) {
  const moving = (lane: Lane, block: Block, s?: Segment) => lane.id === from?.laneId && block.key === from.key &&
    (!from.segment || !!s && s.object_id === from.segment.objectId && s.timerange === from.segment.timerange);
  const remaining = target.blocks.flatMap(b => b.segments.length ? b.segments.filter(s => !moving(target, b, s)).map(s => bounds(s.timerange)) : moving(target, b) ? [] : [[b.start, blockEnd(b)]]);
  const compatible = target.kind === sample.kind && target.blocks.every(b => (b.segments.length ? b.segments.every(s => moving(target, b, s)) : moving(target, b)) || mediaFormat(b.sample) === mediaFormat(sample));
  const valid = (start: bigint) => compatible && start >= 0n && start + duration <= 86400n * NS &&
    !remaining.some(([a, b]) => start < b && a < start + duration);
  const offset = from ? 0n : BigInt(sample.trackOffsetNs ?? 0);
  const anchor = raw - offset;
  let start = ((anchor < 0n ? 0n : anchor) + 20000000n) / 40000000n * 40000000n + offset;
  let distance = Infinity, snapped: bigint | undefined;
  for (const lane of workspace.lanes) for (const block of lane.blocks) {
    const edges = segments && block.segments.length ? block.segments.filter(s => !moving(lane, block, s)).flatMap(s => bounds(s.timerange)) : moving(lane, block) ? [] : [block.start, blockEnd(block)];
    for (const edge of edges) for (const candidate of [edge, edge - duration]) {
      const px = Math.abs(seconds(candidate - raw)) * pixelsPerSecond;
      if (px <= 10 && px < distance && valid(candidate)) { start = candidate; distance = px; snapped = edge; }
    }
  }
  return { start, invalid: !valid(start), snapped };
}

export class IngestSession extends EventTarget {
  stage: Stage = 'segment';
  completed = new Set<Stage>();
  objects: IngestObject[] = [];
  block?: Block;
  pending?: RequestRecord;
  uploadedBytes = 0;
  published = false;
  status: 'running' | 'paused' | 'complete' | 'cancelled' | 'failed' = 'running';
  error?: string;
  readonly abort = new AbortController();
  private advance?: () => void;
  constructor(readonly actionId: string, public step: boolean, readonly sample: Sample, readonly laneId: string) { super(); }
  changed() { this.dispatchEvent(new Event('change')); }
  next() { this.advance?.(); }
  runRemaining() { this.step = false; this.next(); }
  cancel() { if (!this.published) { this.abort.abort(new DOMException('Ingest cancelled', 'AbortError')); this.next(); } }
  async before(record: RequestRecord) {
    if (!this.published) this.abort.signal.throwIfAborted();
    this.stage = record.stage as Stage; this.pending = record;
    if (this.step) {
      this.status = 'paused';
      await new Promise<void>(resolve => { this.advance = resolve; this.changed(); });
      this.advance = undefined;
    }
    if (!this.published) this.abort.signal.throwIfAborted();
    this.status = 'running'; this.pending = undefined; this.changed();
  }
}

export class WorkspaceStore extends EventTarget {
  private boundaryCache = new Map<string, bigint[]>();
  actions: ActionRecord[] = [];
  latestAction?: ActionRecord;
  ingest?: IngestSession;
  private abort = new AbortController();
  private work = new Set<Promise<unknown>>();
  private counts = new WeakMap<ActionRecord, number>();
  constructor(readonly apiUrl: string) { super(); }
  beginAction(name: string, playback = false): ActionRecord {
    this.abort.signal.throwIfAborted();
    const action: ActionRecord = { id: crypto.randomUUID(), name, requests: [], pending: false, playback };
    this.actions.unshift(action); return action;
  }
  async action<T>(name: string, work: (action: ActionRecord) => Promise<T>, existing?: ActionRecord): Promise<T> {
    this.abort.signal.throwIfAborted();
    const action = existing ?? this.beginAction(name);
    if (!this.actions.includes(action)) this.actions.unshift(action);
    action.pending = true; this.counts.set(action, (this.counts.get(action) ?? 0) + 1);
    if (name !== 'Verify stored media') this.latestAction = action;
    this.changed();
    const pending = Promise.resolve().then(() => { this.abort.signal.throwIfAborted(); return work(action); });
    this.work.add(pending);
    try { return await pending; }
    catch (error) { action.error = error instanceof Error ? error.message : String(error); throw error; }
    finally {
      this.work.delete(pending);
      this.counts.set(action, this.counts.get(action)! - 1);
      action.pending = !!this.counts.get(action);
      while (this.actions.length > 30) {
        const eligible = [...this.actions].reverse().filter(a => !a.pending && a.id !== this.ingest?.actionId);
        const oldest = eligible.find(a => a.playback || a.name === 'Read preview media' || a.name === 'Verify stored media') ?? eligible[0];
        if (!oldest) break;
        this.actions.splice(this.actions.indexOf(oldest), 1);
      }
      this.changed();
    }
  }
  async stop() {
    this.abort.abort(new DOMException('Playpen reset', 'AbortError'));
    // Reset discards the whole store, including a published ingest paused at cleanup.
    if (this.ingest) { this.ingest.step = false; this.ingest.abort.abort(); this.ingest.next(); }
    await Promise.allSettled([...this.work]);
  }
  private changed() { this.dispatchEvent(new Event('requests')); }
  async narrative<T>(action: ActionRecord, title: string, detail: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const event: NarrativeEvent = { position: action.requests.length, title, detail, state: 'Pending' };
    (action.events ??= []).push(event); this.changed();
    const started = performance.now();
    try { const result = await work(); event.state = 'Succeeded'; return result; }
    catch (error) { event.state = signal?.aborted ? 'Cancelled' : 'Failed'; event.detail += ` ${(error as Error).message}`; throw error; }
    finally { event.ms = Math.round(performance.now() - started); this.changed(); }
  }
  async request<T = any>(action: ActionRecord | undefined, path: string, method = 'GET', body?: unknown, upload?: { bytes: Blob; name: string; type: string }, options: RequestOptions = {}): Promise<T> {
    return (await this.requestWithRecord<T>(action, path, method, body, upload, options)).value;
  }
  async requestWithRecord<T = any>(action: ActionRecord | undefined, path: string, method = 'GET', body?: unknown, upload?: { bytes: Blob; name: string; type: string }, options: RequestOptions = {}): Promise<{ value: T; record: RequestRecord }> {
    const url = new URL(path, this.apiUrl).href;
    const headers: Record<string, string> = options.headers ?? (upload ? { 'content-type': upload.type } : body === undefined ? {} : { 'content-type': 'application/json' });
    const { signal: requestedSignal, binary, headers: _headers, ...context } = options;
    const signal = requestedSignal ? AbortSignal.any([this.abort.signal, requestedSignal]) : this.abort.signal;
    signal.throwIfAborted();
    const record: RequestRecord = { ...context, method, url, headers, body: upload ? { file: upload.name, contentType: upload.type, bytes: upload.bytes.size } : body };
    action?.requests.push(record);
    if (action?.id && action.name !== 'Verify stored media') this.latestAction = action;
    this.changed();
    const started = performance.now();
    try {
      const response = await fetch(url, { method, headers, body: upload?.bytes ?? options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)), signal });
      record.status = response.status; record.responseHeaders = Object.fromEntries(response.headers);
      if (binary && response.ok) {
        const bytes = await response.arrayBuffer(); record.response = { bytes: bytes.byteLength, contentType: response.headers.get('content-type') }; return { value: bytes as T, record };
      }
      const text = await response.text();
      try { record.response = text ? JSON.parse(text) : null; } catch { record.response = text; }
      if (!response.ok) throw new RequestError(record, `${method} ${new URL(url).pathname}: ${response.status} ${(record.response as any)?.summary ?? text}`);
      if (Array.isArray((record.response as any)?.failed_segments) && (record.response as any).failed_segments.length) throw new Error(`Segment registration partially failed: ${JSON.stringify((record.response as any).failed_segments)}`);
      return { value: record.response as T, record };
    } catch (error) { record.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { record.ms = Math.round(performance.now() - started); this.changed(); }
  }
  async list<T>(action: ActionRecord | undefined, path: string, options?: RequestOptions): Promise<T[]> {
    const result: T[] = []; let next: string | undefined = path;
    while (next) {
      const page: { value: T[]; record: RequestRecord } = await this.requestWithRecord<T[]>(action, next, 'GET', undefined, undefined, options);
      result.push(...page.value);
      next = page.record.responseHeaders?.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return result;
  }
  sources(action?: ActionRecord) { return this.list<Flow>(action, 'flows?tag.tasm.playpen.kind=source&limit=100'); }
  async createSource(action: ActionRecord, label: string, identity: { id: string; source_id: string } = { id: crypto.randomUUID(), source_id: crypto.randomUUID() }): Promise<Flow> {
    const root: Flow = { id: identity.id, source_id: identity.source_id, label, format: 'urn:x-nmos:format:multi', flow_collection: [], tags: { 'tasm.playpen.kind': ['source'] } };
    try { await this.request(action, `flows/${root.id}`, 'PUT', root); }
    catch (error) {
      // A lost response can follow a committed PUT. Keep the same source on retry.
      const saved = await this.request<Flow>(action, `flows/${root.id}`).catch(() => undefined);
      if (saved?.source_id !== root.source_id) throw error;
      return saved;
    }
    return root;
  }
  async load(rootId: string, action?: ActionRecord, deletingFlowId?: string): Promise<Workspace> {
    const root = await this.request<Flow>(action, `flows/${rootId}`), lanes: Lane[] = [];
    for (const member of root.flow_collection ?? []) {
      // A pending deletion may remove segments before removing the flow itself.
      if (member.id === deletingFlowId) continue;
      const flow = await this.request<Flow>(action, `flows/${member.id}`);
      const laneIds = flow.tags?.['tasm.playpen.lane'];
      const id = laneIds?.[0];
      if (laneIds?.length !== 1 || typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || lanes.some(l => l.id.toLowerCase() === id.toLowerCase())) {
        throw new Error('Invalid or duplicate playpen lane ID.');
      }
      const segments = await this.list<Segment>(action, `flows/${flow.id}/segments?include_object_timerange=true&limit=100`);
      const remaining = new Map(segments.map(s => [`${s.object_id}:${s.timerange}`, s]));
      const blocks: Block[] = [];
      for (const value of flow.tags?.[BLOCK_TAG] ?? []) {
        const group = JSON.parse(value);
        const sample: Sample | undefined = samples.find(s => s.id === group.sample) ?? restoredMedia(group.media, flow);
        if (!sample || typeof group.id !== 'string' || typeof group.profile !== 'string' || typeof group.checksum !== 'string' || !Array.isArray(group.segments) || !group.segments.length) throw new Error('Invalid playpen block metadata');
        if (sample.imported && (sample.id !== group.sample || sample.sha256 !== group.checksum || sample.id !== `upload-${sample.sha256.slice(0, 24)}-${sample.kind}`)) throw new Error('Imported media identity does not match its block');
        const refs: Segment[] = group.segments.map((ref: { object_id: string; timerange: string }) => {
          const key = `${ref.object_id}:${ref.timerange}`, segment = remaining.get(key);
          if (!segment) throw new Error('Block metadata does not match its TAMS segments');
          remaining.delete(key); return segment;
        });
        if (blocks.some(b => b.key === group.id) || refs.some((s, i) => i > 0 && bounds(s.timerange)[0] !== bounds(refs[i - 1].timerange)[1])) throw new Error('Invalid playpen block grouping');
        if (group.partial !== undefined && typeof group.partial !== 'boolean') throw new Error('Invalid partial block metadata');
        blocks.push({ key: group.id, sample, profile: group.profile, checksum: group.checksum, start: bounds(refs[0].timerange)[0], segments: refs, partial: group.partial });
      }
      // Older workspaces contain one complete sample per segment and need no migration.
      for (const segment of remaining.values()) {
        const sample = samples.find(s => segment.object_id.includes(`:${s.id}:`));
        if (!sample) throw new Error('This flow contains media outside the built-in sample library.');
        blocks.push({ sample, start: bounds(segment.timerange)[0], key: `${segment.object_id}:${segment.timerange}`, profile: 'legacy', checksum: sample.sha256, segments: [segment] });
      }
      blocks.sort((a, b) => a.start < b.start ? -1 : 1);
      lanes.push({ id, flow, kind: flow.format.endsWith(':audio') ? 'audio' : 'video', blocks, segments });
    }
    return { root, lanes };
  }
  async locked<T>(rootId: string, work: () => Promise<T>) { return navigator.locks.request(`tasm-playpen:${this.apiUrl}:${rootId}`, work); }
  private flow(root: Flow, laneId: string, kind: Kind, label: string, blocks: Block[] = [], fallback?: Technical): Flow {
    return { ...(blocks[0]?.sample.technical ?? fallback ?? samples.find(s => s.kind === kind)!.technical), id: crypto.randomUUID(), source_id: crypto.randomUUID(), label,
      tags: { 'tasm.playpen.root': [root.id], 'tasm.playpen.lane': [laneId], [BLOCK_TAG]: blocks.map(b => JSON.stringify({ id: b.key, sample: b.sample.id, checksum: b.checksum, profile: b.profile,
        ...(b.partial ? { partial: true } : {}),
        ...(b.sample.imported ? { media: { id: b.sample.id, name: b.sample.name, kind: b.sample.kind, sha256: b.sample.sha256, bytes: b.sample.bytes, startNs: b.sample.startNs, trackOffsetNs: b.sample.trackOffsetNs, durationNs: b.sample.durationNs } } : {}),
        segments: b.segments.map(s => ({ object_id: s.object_id, timerange: s.timerange })) })) } };
  }
  async addLane(action: ActionRecord, rootId: string, kind: Kind, label: string) {
    return this.locked(rootId, async () => {
      const { root } = await this.load(rootId, action), flow = this.flow(root, crypto.randomUUID(), kind, label);
      const change: FlowChange = { laneId: tag(flow, 'lane')!, newId: flow.id, state: 'creating' };
      (action.flows ??= []).push(change); this.changed();
      try {
        await this.request(action, `flows/${flow.id}`, 'PUT', flow);
        change.state = 'created'; this.changed();
        const collection = [...root.flow_collection ?? [], { id: flow.id, role: kind }];
        try { await this.request(action, `flows/${root.id}/flow_collection`, 'PUT', collection); }
        catch (error) {
          const current = await this.request<Flow>(action, `flows/${root.id}`);
          if (JSON.stringify(current.flow_collection) !== JSON.stringify(collection)) throw error;
        }
        change.state = 'published'; this.changed();
      } catch (error) { change.state = 'failed'; this.changed(); throw error;
      } finally { await this.discardUnpublished(action, root.id, [flow]); }
    });
  }
  async renameSource(action: ActionRecord, root: Flow, label: string) {
    await this.locked(root.id, async () => {
      await this.request(action, `flows/${root.id}/label`, 'PUT', label);
      await this.request(action, `sources/${root.source_id}/label`, 'PUT', label);
    });
  }
  private async retire(action: ActionRecord | undefined, id: string, change?: FlowChange) {
    if (change) { change.retirement = 'pending'; this.changed(); }
    try {
      const { value: job, record: response } = await this.requestWithRecord(action, `flows/${id}`, 'DELETE', undefined, undefined, { stage: 'update', flowId: id });
      const jobId = job?.id ?? response.responseHeaders?.location?.match(/\/flow-delete-requests\/([^/?#]+)/)?.[1];
      if (change && response.status !== 202) { change.retirement = 'deleted'; this.changed(); }
      if (jobId && response.status === 202) {
        const pending = this.monitorDeletion(action, id, jobId, change);
        this.work.add(pending); void pending.finally(() => this.work.delete(pending));
      }
    } catch (error) { if (change) { change.retirement = 'failed'; change.error = (error as Error).message; this.changed(); } /* recover on reopening */ }
  }
  private async monitorDeletion(action: ActionRecord | undefined, flowId: string, jobId: string, change?: FlowChange) {
    try {
      while (!this.abort.signal.aborted) {
        await abortable(new Promise(resolve => setTimeout(resolve, 1000)), this.abort.signal);
        const job = await this.request(action, `flow-delete-requests/${jobId}`, 'GET', undefined, undefined, { flowId });
        if (job.status === 'failed') throw new Error(`FLOW deletion failed: ${JSON.stringify(job.error)}`);
        if (job.status === 'done') { if (change) change.retirement = 'deleted'; this.changed(); return; }
      }
    } catch (error) { if (change && !this.abort.signal.aborted) { change.retirement = 'failed'; change.error = (error as Error).message; this.changed(); } }
  }
  private async discardUnpublished(action: ActionRecord | undefined, rootId: string, flows: Flow[]) {
    // A lost publication response is not proof of failure. Leave everything if the root cannot be read.
    let root: Flow;
    try { root = await this.request<Flow>(action, `flows/${rootId}`); } catch { return; }
    for (const flow of flows) if (!root.flow_collection?.some(m => m.id === flow.id)) await this.retire(action, flow.id);
  }
  async recover(rootId: string, action?: ActionRecord) {
    await this.locked(rootId, async () => {
      const root = await this.request<Flow>(action, `flows/${rootId}`), members = new Set(root.flow_collection?.map(m => m.id));
      for (const flow of await this.list<Flow>(action, `flows?tag.tasm.playpen.root=${rootId}&limit=100`)) if (!members.has(flow.id) && !flow.collected_by) await this.retire(action, flow.id);
    });
  }
  async segmentBoundaries(sample: Sample, signal: AbortSignal): Promise<bigint[]> {
    const key = `${sample.id}:${sample.sha256}:${PROFILE}`;
    const saved = this.boundaryCache.get(key);
    if (saved) return saved;
    const objects = await this.prepare(sample, signal), origin = BigInt(objects[0].start);
    const edges = [0n, ...objects.map(o => BigInt(o.end) - origin)];
    this.boundaryCache.set(key, edges);
    return edges;
  }
  private async prepare(sample: Sample, signal: AbortSignal): Promise<PreparedObject[]> {
    let bytes: ArrayBuffer;
    if (sample.imported) bytes = await libraryBytes(sample.id);
    else {
      const asset = await fetch(new URL(`../samples/${sample.file}`, this.apiUrl), { signal });
      if (!asset.ok) throw new Error(`Sample download failed: ${asset.status}`);
      bytes = await asset.arrayBuffer();
    }
    signal.throwIfAborted();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    if (digest !== sample.sha256) throw new Error(sample.imported ? 'Sample integrity check failed. Remove it from the library and import the original file again.' : 'Sample integrity check failed. Reload to update the sample library.');
    return (await mediaWorker({ bytes, kind: sample.kind }, signal)).objects!;
  }
  async edit(action: ActionRecord, rootId: string, change: EditChange) {
    return this.locked(rootId, async () => {
      const base = await this.load(rootId, action);
      await this.publishWorkspace(action, base, editWorkspace(base, change), !!change.step);
    });
  }
  async saveDraft(action: ActionRecord, draft: DraftWorkspace, step = false) {
    if (draft.base.root.id !== draft.workspace.root.id) throw new Error('Draft belongs to a different source.');
    return this.locked(draft.base.root.id, async () => {
      const current = await this.load(draft.base.root.id, action);
      if (JSON.stringify(current.root.flow_collection) !== JSON.stringify(draft.base.root.flow_collection) ||
          current.lanes.some(l => { const old = draft.base.lanes.find(b => b.id === l.id); return !old || laneSnapshot(l) !== laneSnapshot(old); })) {
        throw new Error('The saved source changed in another tab. Your draft is retained. Discard it and reload before editing the latest source.');
      }
      await this.publishWorkspace(action, current, draft.workspace, step);
    });
  }
  private async publishWorkspace(action: ActionRecord, workspace: Workspace, desired: Workspace, step: boolean) {
      const draft = structuredClone(desired);
      validateWorkspace(draft);
      const affected = draft.lanes.filter(l => !workspace.lanes.some(b => b.id === l.id && laneSnapshot(b) === laneSnapshot(l)));
      if (!affected.length) return;
      const sample = affected.flatMap(l => l.blocks)[0]?.sample ?? samples[0];
      const session = this.ingest = new IngestSession(action.id, step, sample, affected[0].id);
      session.addEventListener('change', () => this.dispatchEvent(new Event('ingest'))); session.changed();
      const staged: Flow[] = [], prepared = new Map<string, ArrayBuffer>();
      let publicationUnknown = false;
      const write = async (stage: Stage, path: string, method: string, body?: unknown, upload?: { bytes: Blob; name: string; type: string }, context: RequestContext = {}) => {
        const options = { ...context, stage, signal: session.abort.signal };
        await session.before({ ...context, stage, method, url: new URL(path, this.apiUrl).href, headers: { 'content-type': upload?.type ?? 'application/json' }, body: upload ? { file: upload.name, bytes: upload.bytes.size } : body });
        const result = await this.request(action, path, method, body, upload, options);
        session.completed.add(stage); session.changed(); return result;
      };
      try {
        const existing = workspace.lanes.concat(draft.lanes).flatMap(l => l.blocks);
        const reusable = new Map<string, Block>();
        for (const sample of new Map(existing.map(b => [b.sample.id, b.sample])).values()) {
          const block = reusableSample(existing, sample);
          if (block) reusable.set(sample.id + ':' + sample.sha256, block);
        }
        for (const lane of affected) for (const block of lane.blocks) {
          if (block.segments.length) continue;
          const key = block.sample.id + ':' + block.checksum;
          let template = reusable.get(key);
          if (!template) {
            const objects = await this.narrative(action, 'Prepare media segments', `Check ${block.sample.name} and segment its media at packet boundaries.`, () => this.prepare(block.sample, session.abort.signal), session.abort.signal);
            template = { ...block, start: BigInt(objects[0].start), segments: objects.map(o => {
              const object_id = `playpen:${workspace.root.source_id}:${block.sample.id}:${block.checksum.slice(0, 12)}:${crypto.randomUUID()}`;
              prepared.set(object_id, o.bytes);
              return { object_id, timerange: range(BigInt(o.start), BigInt(o.end)), ts_offset: '0:0', object_timerange: range(BigInt(o.start), BigInt(o.end)) };
            }) };
            reusable.set(key, template);
          }
          const sourceIn = block.sourceRange?.[0] ?? 0n, sourceOut = block.sourceRange?.[1] ?? BigInt(block.sample.durationNs);
          const shift = block.start - template.start - sourceIn;
          block.segments = template.segments.filter(s => {
            const [start, end] = bounds(s.timerange);
            return !block.sourceRange || start >= template!.start + sourceIn && end <= template!.start + sourceOut;
          }).map(s => ({ ...s, timerange: range(bounds(s.timerange)[0] + shift, bounds(s.timerange)[1] + shift), ts_offset: timestamp(parseTimestamp(s.ts_offset ?? '0:0') + shift) }));
          if (!block.segments.length) throw new Error('Draft media range contains no complete segments.');
          delete block.sourceRange; delete block.boundaries;
        }
        validateWorkspace(draft);
        session.block = affected.flatMap(l => l.blocks)[0];
        session.objects = [...new Map(affected.flatMap(l => l.blocks.flatMap(b => b.segments.map(segment => [segment.object_id, { segment, sample: b.sample, bytes: prepared.get(segment.object_id)?.byteLength ?? 0, reused: !prepared.has(segment.object_id), state: 'prepared' as const }] as const)))).values()];
        if (session.objects.some(o => o.reused)) await this.narrative(action, 'Reuse stored media', `Reuse ${session.objects.filter(o => o.reused).length} stored objects without uploading their bytes.`, async () => {});
        session.completed.add('segment'); session.changed();
        const collection = draft.lanes.map(l => ({ ...(workspace.root.flow_collection?.find(m => m.id === l.flow.id) ?? { role: l.kind }), id: l.flow.id }));
        const knownObjects = new Set(workspace.lanes.flatMap(l => l.segments.map(s => s.object_id)));
        for (const lane of affected) {
          const blocks = lane.blocks;
          const flow = this.flow(workspace.root, lane.id, lane.kind, lane.flow.label ?? lane.kind, blocks, lane.blocks[0]?.sample.technical); staged.push(flow);
          const transition: FlowChange = { laneId: lane.id, oldId: lane.flow.id || undefined, newId: flow.id, state: 'creating' };
          (action.flows ??= []).push(transition); this.changed();
          await write('segment', `flows/${flow.id}`, 'PUT', flow, undefined, { flowId: flow.id });
          transition.state = 'created'; this.changed();
          if (!step) {
            const entries = blocks.flatMap(block => block.segments.map(segment => ({ block, segment })));
            const fresh = [...new Map(entries.filter(e => !knownObjects.has(e.segment.object_id)).map(e => [e.segment.object_id, e])).values()];
            if (fresh.length) {
              const locations = new Map<string, { url: string; 'content-type': string }>();
              // The browser runtime accepts at most 1,000 objects per allocation request.
              for (let i = 0; i < fresh.length; i += 1000) {
                const ids = fresh.slice(i, i + 1000).map(e => e.segment.object_id);
                const allocation = await write('allocate', `flows/${flow.id}/storage`, 'POST', { object_ids: ids }, undefined, { flowId: flow.id, objectIds: ids });
                for (const object of allocation.media_objects) locations.set(object.object_id, object.put_url);
              }
              for (const { block, segment } of fresh) {
                const object = session.objects.find(o => o.segment.object_id === segment.object_id);
                if (object) { object.state = 'allocated'; session.changed(); }
                const put = locations.get(segment.object_id), bytes = prepared.get(segment.object_id);
                if (!put?.url || !bytes) throw new Error('Missing allocated storage or prepared media bytes');
                await write('upload', put.url, 'PUT', undefined, { bytes: new Blob([bytes]), name: `${block.sample.name}.ts`, type: put['content-type'] }, { flowId: flow.id, blockId: block.key, objectId: segment.object_id });
                session.uploadedBytes += bytes.byteLength; prepared.delete(segment.object_id);
                if (object) { object.state = 'uploaded'; session.changed(); }
              }
            }
            if (entries.length) {
              const registered = new Set(knownObjects);
              const registrations = entries.map(({ segment: s }) => {
                const first = !registered.has(s.object_id); registered.add(s.object_id);
                return { object_id: s.object_id, timerange: s.timerange, ts_offset: s.ts_offset, ...(first ? { object_timerange: s.object_timerange } : {}) };
              });
              await write('register', `flows/${flow.id}/segments`, 'POST', registrations, undefined, { flowId: flow.id, objectIds: entries.map(e => e.segment.object_id) });
              for (const { segment } of entries) {
                knownObjects.add(segment.object_id);
                const object = session.objects.find(o => o.segment.object_id === segment.object_id);
                if (object) object.state = 'registered';
              }
              session.changed();
            }
          } else {
            for (const block of blocks) {
              for (const segment of block.segments) {
                const { object_id, timerange, ts_offset, object_timerange } = segment;
                const first = !knownObjects.has(object_id), context = { blockId: block.key, flowId: flow.id, objectId: object_id };
                const object = session.objects.find(o => o.segment.object_id === segment.object_id);
                if (first) {
                  const allocation = await write('allocate', `flows/${flow.id}/storage`, 'POST', { object_ids: [object_id] }, undefined, context);
                  if (object) { object.state = 'allocated'; session.changed(); }
                  const put = allocation.media_objects[0].put_url, bytes = prepared.get(object_id);
                  if (!bytes) throw new Error('Missing prepared media bytes');
                  await write('upload', put.url, 'PUT', undefined, { bytes: new Blob([bytes]), name: `${block.sample.name}-${session.objects.findIndex(o => o.segment.object_id === object_id) + 1}.ts`, type: put['content-type'] }, context);
                  session.uploadedBytes += bytes.byteLength;
                  prepared.delete(object_id);
                  if (object) { object.state = 'uploaded'; session.changed(); }
                }
                await write('register', `flows/${flow.id}/segments`, 'POST', { object_id, timerange, ts_offset, ...(first ? { object_timerange } : {}) }, undefined, context);
                knownObjects.add(object_id); if (object) { object.state = 'registered'; session.changed(); }
              }
            }
          }
          collection[draft.lanes.findIndex(l => l.id === lane.id)].id = flow.id;
        }
        try { await write('update', `flows/${workspace.root.id}/flow_collection`, 'PUT', collection); session.published = true; }
        catch (error) {
          let root: Flow;
          try { root = await this.request<Flow>(action, `flows/${workspace.root.id}`); }
          catch (readError) { publicationUnknown = true; throw readError; }
          session.published = JSON.stringify(root.flow_collection) === JSON.stringify(collection);
          if (!session.published) throw error;
        }
        for (const flow of action.flows ?? []) if (staged.some(s => s.id === flow.newId)) flow.state = 'published';
        this.changed();
        // Publication succeeded; cleanup must finish even if Cancel raced with its response.
        for (const lane of affected.filter(l => l.flow.id)) {
          await session.before({ stage: 'update', method: 'DELETE', url: new URL(`flows/${lane.flow.id}`, this.apiUrl).href, headers: {}, flowId: lane.flow.id });
          await this.retire(action, lane.flow.id, action.flows?.find(f => f.oldId === lane.flow.id));
        }
        session.status = 'complete'; session.stage = 'update'; session.completed.add('update');
      } catch (error) {
        for (const flow of action.flows ?? []) if (staged.some(s => s.id === flow.newId) && flow.state !== 'published') flow.state = publicationUnknown ? 'unconfirmed' : 'failed';
        session.status = session.abort.signal.aborted && !session.published ? 'cancelled' : 'failed'; session.error = (error as Error).message; throw error;
      } finally {
        if (!session.published) await this.discardUnpublished(action, workspace.root.id, staged);
        session.pending = undefined; session.changed();
      }
  }
  async readRange(action: ActionRecord, workspace: Workspace, selection: Record<Kind, string>, start: bigint, end: bigint) {
    if (start < 0n || end <= start) throw new Error('The range end must be after its start.');
    const segments: Segment[] = [], flows: { id: string; label: string; segments: Segment[] }[] = [];
    for (const lane of workspace.lanes.filter(l => l.id === selection[l.kind])) {
      const matched = await this.list<Segment>(action, `flows/${lane.flow.id}/segments?${new URLSearchParams({ timerange: range(start, end), include_object_timerange: 'true', limit: '100' })}`, { stage: 'query', flowId: lane.flow.id });
      flows.push({ id: lane.flow.id, label: lane.flow.label ?? lane.kind, segments: matched }); segments.push(...matched);
    }
    const unique = new Map(segments.map(s => [s.object_id, s])), objectBytes = new Map<string, number>(); let bytes = 0;
    for (const s of unique.values()) {
      if (!s.get_urls?.[0]) throw new Error('Segment has no readable object URL');
      const size = (await this.request<ArrayBuffer>(action, s.get_urls[0].url, 'GET', undefined, undefined, { binary: true, stage: 'read', objectId: s.object_id })).byteLength;
      objectBytes.set(s.object_id, size); bytes += size;
    }
    return { segments, objects: unique.size, bytes, flows, objectBytes };
  }
}
