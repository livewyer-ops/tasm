import { onFrame, setText } from '../shared/render';
import { WorkspaceStore, type StorageCheck, samples, seconds, blockEnd, bounds, parseTimestamp, planPlacement, reusableSample, addDraftLane, editWorkspace, laneSnapshot, type DraftWorkspace, type MovingItem, type ActionRecord, type Block, type Flow, type Kind, type Lane, type Sample, type Workspace } from '../shared/workspace-store';
import { Preview, sourceEnd } from '../shared/player';
import { librarySamples, saveLibrarySamples, removeLibrarySample, mediaWorker, libraryDraft, saveLibraryDraft } from '../shared/sample-library';
import { escape, requestDetails, resourceButton, wireReview } from './api-review';
import type { TasmClient } from '../../core/browser/public.d.ts';
import type {} from '../shared/startup';
import { wireTerminal, type CurlRequest } from './terminal';
import type { RequestRecord } from '../shared/workspace-store';
import { createTour } from './tour';


const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`;
const nsInput = (value: string) => {
  if (!/^\d+(\.\d{1,9})?$/.test(value) || Number(value) > 86400) throw new Error('Enter a start time between 0 and 86400 seconds.');
  const [s, ns = ''] = value.split('.'); return BigInt(s) * 1000000000n + BigInt(ns.padEnd(9, '0'));
};
let store!: WorkspaceStore, preview!: Preview, workspace: Workspace | undefined, publishedWorkspace: Workspace | undefined;
let draft: DraftWorkspace | undefined, draftWrites: Promise<unknown> = Promise.resolve(), draftPending = 0, draftError = false;
const draftAbort = new AbortController();
const draftKey = (id: string) => `${store.apiUrl}:${id}`;
let sources: Flow[] = [], selectedLane = '', selectedBlock = '', selectedSample = samples[0].id;
let filter = 'all', zoom = 1, busy = true, selectedAction = '', selectedRequest = -1;
let view: 'flows' | 'segments' = 'flows', selectedSegment = -1, previewBusy = false, previewVersion = 0, workspaceVersion = 0;
let noticeTimer: ReturnType<typeof setTimeout>;
let followRequests = true, retryAction: (() => void) | undefined;
let historyHtml = '', detailKey = '', detailHtml = '', selectedObject = '', ingestId = '';
let inspectIngest = false, rangeReady = false;
const storageChecks = new Map<string, StorageCheck>();
let checkingStorage = false;
let library: Sample[] = [...samples], libraryReady = false, libraryBusy = false;
let importing: AbortController | undefined;
let resetting = false;
let pendingPlacement: { laneId: string; start: bigint; sample: Sample; duration?: bigint; importing?: boolean } | undefined;
const pixels = () => 26 * zoom;
const dataKey = `tasm-playpen:selected:${location.pathname}`;

function scheduleNoticeDismissal() {
  clearTimeout(noticeTimer);
  if (!$('notice').hidden && !$('notice').classList.contains('error')) noticeTimer = setTimeout(() => $('notice').hidden = true, 4000);
}
function notify(message: string, error = false, retry?: () => void) {
  if (resetting || reloadRequired) return;
  showNotice(message, error, retry);
}
function showNotice(message: string, error: boolean, retry?: () => void) {
  retryAction = retry;
  $('notice-text').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false;
  $('retry-action').hidden = !error || !retryAction;
  scheduleNoticeDismissal();
}
let reloadRequired = false;
async function withBusy<T>(work: () => Promise<T>): Promise<T> {
  busy = true; controls();
  try { return await work(); }
  finally { busy = resetting || reloadRequired; controls(); }
}
async function reloadAfterSave(work: () => Promise<void>): Promise<boolean> {
  reloadRequired = true;
  try { await work(); reloadRequired = false; return true; }
  catch (error) {
    if (resetting) return false;
    $('runtime-status').textContent = 'Saved · reload required';
    showNotice(`Saved, but the workspace could not reload: ${(error as Error).message}`, true, () => void withBusy(() => reloadAfterSave(work)));
    return false;
  }
}
function controls() {
  if (resetting) { busy = true; $('runtime-status').textContent = 'Resetting Playpen...'; return; }
  if (!busy && store) setText($('runtime-status'), 'Browser store ready');
  const disable = (id: string, value: boolean) => { const element = $<HTMLButtonElement>(id); if (element) element.disabled = value; };
  disable('save-draft', busy || libraryBusy || !draft); disable('discard-draft', busy || libraryBusy || !draft);
  $('draft-status').textContent = draft ? draftError ? 'Unsaved changes · local storage failed' : draftPending ? 'Unsaved changes · storing locally…' : 'Unsaved changes · stored locally' : 'All changes saved';
  const savedMedia = publishedWorkspace?.lanes.some(lane => lane.blocks.length);
  const draftMedia = draft?.workspace.lanes.some(lane => lane.blocks.length);
  $('preview-caption').textContent = draft ? 'Preview shows the saved arrangement. Save to preview your edits.'
    : previewBusy ? 'Preparing the saved arrangement for playback...' : preview?.loaded ? 'Preview is up to date. Gaps play as black or silence.' : 'The arrangement is saved. Preview is unavailable; use Retry to load it.';
  $('preview-caption').classList.toggle('draft-preview', !!draft);
  $('preview-caption').hidden = !savedMedia;
  $('preview-empty').querySelector('strong')!.textContent = draftMedia ? 'Clips are ready to save' : 'No media yet';
  $('preview-empty').querySelector('p')!.textContent = draftMedia ? 'Save your arrangement to preview these clips.' : 'Add a flow, then place a sample on its timeline.';
  disable('rename-source', busy || libraryBusy || !!draft || !workspace);
  disable('empty-create', busy || libraryBusy);
  for (const id of ['add-video', 'add-audio']) disable(id, busy || libraryBusy || !workspace);
  for (const id of ['import-media', 'media-file']) disable(id, !libraryReady || libraryBusy);
  $('library-section').setAttribute('aria-busy', String(libraryBusy));
  $('import-cancel').hidden = !importing;
  document.querySelectorAll<HTMLButtonElement>('[data-remove-sample]').forEach(button => button.disabled = busy || libraryBusy);
  disable('add-sample', busy || libraryBusy || !workspace?.lanes.some(l => l.id === selectedLane && l.kind === library.find(s => s.id === selectedSample)?.kind));
  for (const id of ['preview-video', 'preview-audio', 'block-target', 'block-start']) ($<HTMLSelectElement>(id)).disabled = busy || !workspace;
  disable('new-source', busy || libraryBusy); disable('sources', busy || libraryBusy || !workspace);
  disable('read-range', busy || !workspace || !sourceEnd(publishedWorkspace)); disable('play-range', busy || previewBusy || !rangeReady);
  for (const id of ['seek-button', 'seek-time']) disable(id, busy || previewBusy || !workspace);
  for (const id of ['range-start', 'range-end']) disable(id, busy || !workspace);
  document.querySelector<HTMLElement>('.preview-stage')!.inert = busy || previewBusy;
  disable('follow-requests', !store?.actions.length);
  disable('storage-refresh', busy || checkingStorage || !mediaObjects().length);
  disable('step-through', busy); disable('asap', busy);
  disable('move-block', busy || libraryBusy); disable('remove-block', busy || libraryBusy);
  document.body.classList.toggle('busy', busy);
}
function waveform(sample: Sample, label = '') {
  const values = sample.waveform ?? [], peak = Math.max(...values, 0.001);
  return `<svg viewBox="0 0 256 48" preserveAspectRatio="none" ${label ? `role="img" aria-label="${escape(label)}"` : 'aria-hidden="true"'}>${values.map((v, i) => {
    const height = Math.max(2, v / peak * 40); return `<rect x="${i * 4}" y="${24 - height / 2}" width="2" height="${height}" rx="1" fill="${escape(sample.color)}"/>`;
  }).join('')}</svg>`;
}
function flowFormat(lane: Lane) {
  const p = lane.flow.essence_parameters as Sample['technical']['essence_parameters'];
  return lane.kind === 'video' ? `H.264 · ${p?.frame_rate ? `${(p.frame_rate.numerator / p.frame_rate.denominator).toFixed(2).replace(/\.00$/, '')} FPS` : 'variable FPS'}` : `AAC · ${(p?.sample_rate ?? 0) / 1000} kHz`;
}
function shortFlowId(id: string) {
  let length = 8;
  while (length < id.length && workspace?.lanes.some(l => l.flow.id !== id && l.flow.id.slice(0, length) === id.slice(0, length))) length++;
  return id.slice(0, length);
}
function clipMarkup(lane: Lane, block: Block, index?: number) {
  const segment = index === undefined ? undefined : block.segments[index];
  const [start, end] = segment ? bounds(segment.timerange) : [block.start, blockEnd(block)];
  const selected = selectedLane === lane.id && selectedBlock === block.key && (index === undefined || index === Math.max(0, selectedSegment));
  const name = `${block.sample.name}${index === undefined ? '' : ` · ${index + 1}`}`;
  return `<button class="clip ${lane.kind} ${segment ? 'segment-clip' : ''} ${!block.segments.length ? 'draft-clip' : ''} ${selected ? 'selected' : ''}" data-block="${escape(block.key)}" data-block-lane="${escape(lane.id)}" ${index === undefined ? '' : `data-edit-segment-index="${index}" data-object-id="${escape(segment!.object_id)}"`} style="left:${seconds(start) * pixels()}px;width:${seconds(end - start) * pixels()}px;--clip-color:${escape(block.sample.color)}" aria-label="${escape(name)} at ${seconds(start).toFixed(2)} seconds" title="${escape(name)} · ${fmt(seconds(start))} → ${fmt(seconds(end))}${!block.segments.length ? ' · Unsaved clip; Save to see its segments' : ''}">${segment ? '' : segmentMarks(block)}${block.sample.thumbnail ? `<img src="./samples/${escape(block.sample.thumbnail)}" draggable="false" alt="">` : waveform(block.sample)}<span class="clip-name">${escape(name)}</span><span class="clip-duration">${seconds(end - start).toFixed(2)}s</span></button>`;
}
function renderTransitions() {
  if (!store) return;
  const focusedResource = $('flow-identifiers').querySelector<HTMLElement>(':focus')?.dataset.resource;
  $('flow-identifiers').innerHTML = (workspace?.lanes ?? []).map(lane => `<div class="flow-identifier" data-lane-id="${escape(lane.id)}"><strong>${escape(lane.flow.label)}</strong> ${lane.flow.id ? resourceButton('flows', lane.flow.id, shortFlowId(lane.flow.id)) : '<span class="flow-id">Unsaved flow</span>'}<small class="flow-transition" data-transition="${escape(lane.id)}"></small></div>`).join('');
  if (focusedResource) $('flow-identifiers').querySelector<HTMLButtonElement>(`[data-resource="${CSS.escape(focusedResource)}"]`)?.focus({ preventScroll: true });
  for (const element of document.querySelectorAll<HTMLElement>('[data-transition]')) {
    const change = store.actions.flatMap(a => a.flows ?? []).find(f => f.laneId === element.dataset.transition);
    if (!change) continue;
    element.textContent = `${change.state === 'published' ? 'Created → Published' : change.state === 'unconfirmed' ? 'Publication unconfirmed' : change.state} ${shortFlowId(change.newId)}${change.oldId ? ` · ${shortFlowId(change.oldId)} ${change.retirement === 'deleted' ? 'Deleted' : change.retirement === 'failed' ? 'Deletion not confirmed' : change.retirement === 'pending' ? 'Deletion pending' : change.state === 'failed' ? 'still active' : change.state === 'unconfirmed' ? 'status unconfirmed' : 'to be retired'}` : ''}`;
    element.title = change.error ?? `${change.newId}${change.oldId ? ` replaces ${change.oldId}` : ''}`;
    if (change.state === 'published' && workspace?.lanes.find(l => l.id === element.dataset.transition)?.flow.id === change.newId) {
      const id = element.closest('.flow-identifier')?.querySelector<HTMLElement>('.flow-id');
      if (id) { id.textContent = shortFlowId(change.newId); id.title = change.newId; id.setAttribute('aria-label', `FLOW ID ${change.newId}`); id.closest('.lane-header')?.setAttribute('aria-description', `FLOW ID ${change.newId}`); }
    }
  }
}
function fillResource(path: string) {
  terminal.fill({ method: 'GET', url: new URL(path, store.apiUrl).href, headers: {} });
}
function renderSamples() {
  const focused = (document.activeElement as HTMLElement)?.dataset.sample;
  $('sample-count').textContent = String(library.length);
  $('samples').innerHTML = library.filter(s => filter === 'all' || (filter === 'speech' ? s.category === 'speech' : s.kind === filter)).map(sample => `<div class="sample-entry"><button class="sample-card ${selectedSample === sample.id ? 'selected' : ''}" data-sample="${escape(sample.id)}" aria-label="Select ${escape(sample.name)} ${escape(sample.kind)} sample" aria-pressed="${selectedSample === sample.id}"><span class="sample-art">${sample.imported ? `<span class="sample-icon" aria-hidden="true">${sample.kind === 'video' ? '▷' : '♫'}</span>` : sample.thumbnail ? `<img src="./samples/${escape(sample.thumbnail)}" alt="" draggable="false">` : waveform(sample)}</span><span class="sample-info"><strong>${escape(sample.name)}</strong><small>${escape(sample.kind)} · ${seconds(BigInt(sample.durationNs)).toFixed(2)} s</small></span><span aria-hidden="true">⠿</span></button>${sample.imported ? `<button class="remove-sample" data-remove-sample="${escape(sample.id)}" aria-label="Remove ${escape(sample.name)} ${escape(sample.kind)} from library">Remove from library</button>` : ''}</div>`).join('');
  if (focused) document.querySelector<HTMLButtonElement>(`[data-sample="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
function renderSources() {
  $('sources').innerHTML = sources.length ? sources.map(source => `<option value="${escape(source.id)}" ${workspace?.root.id === source.id ? 'selected' : ''}>${escape(source.label ?? 'Untitled source')}</option>`).join('') : '<option value="">No source yet</option>';
  $('source-title').textContent = workspace?.root.label ?? 'No source yet';
  $('source-id').innerHTML = workspace ? `Source ID ${resourceButton('sources', workspace.root.source_id)}` : '';
  $('rename-source').hidden = !workspace;
}
function renderTimeline() {
  $('timeline').dataset.pxPerSecond = String(pixels());
  const focused = (document.activeElement as HTMLElement)?.dataset;
  const focusSelector = focused?.block ? `[data-block="${CSS.escape(focused.block)}"]${focused.editSegmentIndex !== undefined ? `[data-edit-segment-index="${focused.editSegmentIndex}"]` : ''}` : focused?.selectLane ? `[data-select-lane="${CSS.escape(focused.selectLane)}"]` : undefined;
  const lanes = workspace?.lanes ?? [];
  preview?.choices(publishedWorkspace);
  $('source-duration').textContent = `End ${fmt(sourceEnd(workspace))}`;
  $('flow-count').textContent = `${lanes.length} flow${lanes.length === 1 ? '' : 's'}`;
  $('zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  if (!lanes.length) {
    $('timeline').style.width = '';
    $('timeline').innerHTML = `<div class="timeline-empty"><span class="empty-tracks" aria-hidden="true">▰<br>▰</span><h3>${workspace ? 'Add a video or audio flow' : 'Create your first source'}</h3><p>${workspace ? 'Add a video or audio flow, then drag a sample onto its timeline.' : 'Create a source to start arranging video and audio.'}</p>${workspace ? '<button data-add-kind="video" class="primary">Add a video flow +</button>' : '<button id="empty-create" class="primary">Create a source +</button>'}</div>`;
    renderTransitions(); updateSelection(); renderObjects(); controls(); return;
  }
  const end = Math.max(30, ...lanes.flatMap(l => l.blocks.map(b => seconds(blockEnd(b)) + 5)));
  const span = Math.ceil(Math.max(end, ($('timeline-scroll').clientWidth - 156) / pixels()) / 5) * 5;
  const width = span * pixels();
  $('timeline').style.width = `${width + 156}px`;
  $('timeline').style.setProperty('--grid-size', `${pixels() * (zoom < 1 ? 5 : 2)}px`);
  const tick = zoom < 1 ? 5 : zoom < 2 ? 2 : 1;
  $('timeline').innerHTML = `<div class="ruler" aria-label="Seek on the timeline">${Array.from({ length: Math.ceil(span / tick) }, (_, i) => `<span class="ruler-label" style="left:${i * tick * pixels()}px">${fmt(i * tick).slice(0, 5)}</span>`).join('')}</div><div class="ruler-corner">${view.toUpperCase()} / SECONDS</div>${lanes.map(lane => `<div class="lane" data-lane="${escape(lane.id)}"><button class="lane-header ${selectedLane === lane.id ? 'active' : ''}" data-select-lane="${escape(lane.id)}" title="Flow ${escape(lane.flow.id)}" aria-label="Select ${escape(lane.flow.label)} flow" aria-description="FLOW ID ${escape(lane.flow.id)}" aria-pressed="${selectedLane === lane.id}"><span class="lane-icon" aria-hidden="true">${lane.kind === 'video' ? '▷' : '♫'}</span><span><strong>${escape(lane.flow.label)}</strong><small>${escape(flowFormat(lane))}</small>${preview?.selection[lane.kind] === lane.id ? '<small class="preview-badge">In preview</small>' : ''}</span></button><div class="lane-track ${selectedLane === lane.id ? 'active' : ''}" data-track="${escape(lane.id)}">${lane.blocks.map(block => view === 'flows' || !block.segments.length ? clipMarkup(lane, block) : block.segments.map((_, i) => clipMarkup(lane, block, i)).join('')).join('')}</div></div>`).join('')}<div class="end-marker" style="left:${156 + sourceEnd(workspace) * pixels()}px"><span>END</span></div><div id="playhead" class="playhead"></div>`;
  renderPending(); renderTransitions(); updatePlayhead(); updateSelection(); renderObjects(); controls();
  if (focusSelector) document.querySelector<HTMLButtonElement>(focusSelector)?.focus({ preventScroll: true });
}
function currentBlock(): { lane: Lane; block: Block } | undefined {
  const lane = workspace?.lanes.find(l => l.id === selectedLane), block = lane?.blocks.find(b => b.key === selectedBlock);
  return lane && block ? { lane, block } : undefined;
}
function currentItem() {
  const current = currentBlock();
  if (!current || view === 'flows' || !current.block.segments.length) return current;
  const segment = current.block.segments[Math.max(0, selectedSegment)];
  return segment ? { lane: current.lane, block: { ...current.block, start: bounds(segment.timerange)[0], segments: [segment] } } : undefined;
}
function movingItem(lane: Lane, block: Block, index?: number): MovingItem {
  const segment = index === undefined ? undefined : block.segments[index];
  return { laneId: lane.id, key: block.key, ...(segment ? { segment: { objectId: segment.object_id, timerange: segment.timerange } } : {}) };
}
function updateSelection() {
  const activeIngest = inspectIngest && store?.ingest && ['running', 'paused'].includes(store.ingest.status) ? store.ingest : undefined;
  const selection = activeIngest ? undefined : currentItem();
  $<HTMLInputElement>('block-start').setAttribute('aria-label', `${view === 'segments' ? 'Segment' : 'Clip'} start in seconds`);
  $('block-controls').hidden = !selection;
  $('selection-label').closest<HTMLElement>('.selection-bar')!.hidden = !activeIngest && !selection;
  $('selection-label').textContent = activeIngest ? 'Saving draft · provisional objects · preview uses the saved source' : selection?.block.sample.name ?? '';
  if (selection) {
    const { block, lane } = selection;
    const target = $<HTMLSelectElement>('block-target');
    target.replaceChildren(...workspace!.lanes.filter(l => l.kind === lane.kind).map(l => new Option(l.flow.label ?? l.id, l.id, false, l.id === lane.id)));
    $<HTMLInputElement>('block-start').value = String(block.start / 1000000000n) + '.' + String(block.start % 1000000000n).padStart(9, '0');
    $('block-bounds').textContent = `End ${fmt(seconds(blockEnd(block)))} · Duration ${seconds(blockEnd(block) - block.start).toFixed(3)}s`;
  }
}
function updatePlayhead() {
  const time = preview?.currentTime ?? 0;
  $('playhead-time').textContent = fmt(time);
  if ($('playhead')) $('playhead').style.left = `${156 + time * pixels()}px`;
}
function renderRequests() {
  if (resetting) return;
  renderTransitions();
  updateReview();
  if (!store?.actions.length) return;
  $<HTMLButtonElement>('follow-requests').disabled = false;
  const scroll = $('requests').scrollTop;
  const newest = store.actions.find(a => a.pending && !a.playback && a.name !== 'Verify stored media')
    ?? (store.latestAction && store.actions.includes(store.latestAction) ? store.latestAction : store.actions.find(a => a.name !== 'Verify stored media')) ?? store.actions[0];
  if (followRequests) { selectedAction = newest.id; selectedRequest = -1; }
  const action = store.actions.find(a => a.id === selectedAction) ?? newest;
  const session = store.ingest?.actionId === action.id ? store.ingest : undefined;
  const state = session?.status === 'paused' ? 'Paused' : session?.status === 'cancelled' ? 'Cancelled' : action.error ? 'Failed' : action.pending ? 'Working' : 'Done';
  $('activity-summary').textContent = `${action.name} · ${state}`;
  $('follow-requests').textContent = followRequests ? 'Following live' : 'Resume live';
  $('follow-requests').setAttribute('aria-pressed', String(followRequests));
  const history = store.actions.map(a => `<option value="${a.id}" ${a.id === action.id ? 'selected' : ''}>${escape(a.name)}${a.pending ? ' …' : a.error ? ' · failed' : ''}</option>`).join('');
  if (history !== historyHtml) { $('action-history').innerHTML = history; historyHtml = history; }
  $('request-count').textContent = String(action.requests.length);
  const index = selectedRequest < 0 ? action.requests.length - 1 : Math.min(selectedRequest, action.requests.length - 1);
  const rows = $('requests');
  if (rows.dataset.action !== action.id) { rows.replaceChildren(); rows.dataset.action = action.id; }
  action.requests.forEach((r, i) => {
    let row = rows.children[i] as HTMLButtonElement | undefined;
    if (!row) {
      row = document.createElement('button');
      row.className = 'request-row'; row.dataset.request = String(i); row.title = r.url;
      row.innerHTML = '<span class="method"></span><span class="path"></span><span></span><small></small>';
      row.children[0].textContent = r.method;
      row.children[1].textContent = new URL(r.url).pathname.replace(new URL(store.apiUrl).pathname.replace(/\/$/, ''), '');
      rows.append(row);
    }
    row.classList.toggle('selected', i === index); row.classList.toggle('error', !!r.error);
    row.classList.toggle('related', !!selectedObject && (r.objectId === selectedObject || !!r.objectIds?.includes(selectedObject)));
    row.setAttribute('aria-pressed', String(i === index));
    setText(row.children[2], String(r.status ?? '…'));
    setText(row.children[3], r.ms === undefined ? 'Pending' : `${r.ms} ms${r.error ? ' · failed' : ''}`);
  });
  const record = action.requests[index];
  $<HTMLButtonElement>('copy-request').disabled = !record;
  if (!record) { detailKey = ''; $('request-detail').innerHTML = '<p class="api-empty">No requests recorded yet.</p>'; return; }
  const key = `${action.id}:${index}`;
  const expanded = key === detailKey ? [...$('request-detail').querySelectorAll('details')].map(d => d.open) : undefined;
  const html = `${action.playback ? '<p class="request-explanation">Playback reads ahead and reuses cached media. Requests may occur before playback reaches a segment.</p>' : record.stage ? `<p class="request-explanation">${escape(stageText[record.stage] ?? '')}${record.objectId ? `<br>${resourceButton('objects', record.objectId)}` : ''}</p>` : ''}${requestDetails(record)}`;
  if (detailKey !== key || detailHtml !== html) {
    $('request-detail').innerHTML = html;
    if (expanded) $('request-detail').querySelectorAll('details').forEach((d, i) => d.open = expanded[i]);
    detailKey = key; detailHtml = html;
  }
  $('requests').scrollTop = followRequests && selectedRequest < 0 ? $('requests').scrollHeight : scroll;

}
async function updatePreview(resume = false) {
  if (resetting) return;
  const version = ++previewVersion;
  previewBusy = true; controls();
  const choices = preview.choices(publishedWorkspace);
  for (const kind of ['video', 'audio'] as const) {
    const select = $<HTMLSelectElement>(`preview-${kind}`);
    select.innerHTML = `<option value="">None · ${kind === 'video' ? 'black' : 'silence'}</option>` + (publishedWorkspace?.lanes.filter(l => l.kind === kind).map(l => `<option value="${escape(l.id)}">${escape(l.flow.label)}</option>`).join('') ?? '');
    select.value = choices[kind];
  }
  const hasBlocks = publishedWorkspace?.lanes.some(l => l.blocks.length);
  $('preview-empty').hidden = !!hasBlocks;
  $('preview-status').textContent = hasBlocks ? 'Preparing preview…' : 'Waiting for media';
  $('preview-format').textContent = choices.video ? (choices.audio ? 'Video + audio' : 'Video') : choices.audio ? 'Audio' : hasBlocks ? 'Black + silence' : '';
  try {
    await preview.update(publishedWorkspace, resume);
    if (version !== previewVersion || resetting) return;
    $('preview-status').textContent = hasBlocks ? 'Source ready · press play to preview' : 'Waiting for media';
  } catch (error) { if (version !== previewVersion || resetting) return; $('preview-status').textContent = 'Preview could not load'; notify(`Preview could not load: ${(error as Error).message}`, true, () => void updatePreview()); }
  finally { if (version === previewVersion) { previewBusy = false; controls(); } }
}
async function refresh(rootId = workspace?.root.id, afterTerminalWrite = false) {
  if (resetting) return;
  rangeReady = false; $('range-result').textContent = 'Queries the selected saved preview flows, then reads each matching object once.'; controls();
  sources = await store.sources();
  if (afterTerminalWrite && !draft && !sources.some(source => source.id === rootId)) rootId = sources[0]?.id;
  publishedWorkspace = rootId ? await store.load(rootId) : undefined;
  if (!afterTerminalWrite || !draft || draft.workspace.root.id !== rootId) draft = rootId ? await libraryDraft(draftKey(rootId)) : undefined;
  workspace = draft?.workspace ?? publishedWorkspace;
  for (const block of workspace?.lanes.flatMap(l => l.blocks) ?? []) {
    if (!block.segments.length && !block.boundaries) block.boundaries = await store.segmentBoundaries(block.sample, draftAbort.signal);
  }
  workspaceVersion++;
  if (resetting) return;
  if (!workspace?.lanes.some(l => l.id === selectedLane)) selectedLane = workspace?.lanes[0]?.id ?? '';
  renderSources(); renderTimeline();
  void updatePreview();
  void verifyStorage();
}
async function run(name: string, work: (action: ActionRecord) => Promise<void>, action?: ActionRecord) {
  if (busy) return;
  retryAction = undefined; $('notice').hidden = true;
  await withBusy(async () => {
    preview.pause(); $('runtime-status').textContent = 'Saving…';
    try { await store.action(name, work, action); }
    catch (error) {
      notify((error as Error).message, true, () => void run(name, work));
      try { await refresh(); } catch { /* retain last visible state */ }
      return;
    } finally { pendingPlacement = undefined; }
    await reloadAfterSave(() => refresh());
  });
}
function changeDraft(next: Workspace, name: string) {
  if (!publishedWorkspace || resetting || reloadRequired) return;
  const same = next.lanes.length === publishedWorkspace.lanes.length && next.lanes.every((lane, i) => lane.id === publishedWorkspace!.lanes[i].id && laneSnapshot(lane) === laneSnapshot(publishedWorkspace!.lanes[i]));
  draft = same ? undefined : { base: draft?.base ?? structuredClone(publishedWorkspace), workspace: next };
  workspace = next;
  const key = draftKey(next.root.id), snapshot = draft && structuredClone(draft);
  draftPending++; controls();
  draftWrites = draftWrites.then(async () => {
    if (!resetting) await saveLibraryDraft(key, snapshot, draftAbort.signal);
    draftError = false;
  }).catch(error => { draftError = true; notify(`Draft could not be stored locally: ${error.message}. Keep this tab open and Save.`, true); })
    .finally(() => { draftPending--; controls(); });
  void store.action(name, a => store.narrative(a, 'Edit local draft', 'Changed the local arrangement. No TAMS writes are sent until Save; playback uses the saved source.', async () => {}));
  rangeReady = false; renderTimeline();
}
async function saveDraft(stepThrough = $<HTMLInputElement>('step-through').checked): Promise<boolean> {
  if (busy || libraryBusy || !draft) return !draft;
  $<HTMLDetailsElement>('storage').open = true;
  const saving = structuredClone(draft);
  retryAction = undefined; $('notice').hidden = true; preview.pause();
  const finish = async () => {
    await saveLibraryDraft(draftKey(saving.base.root.id), undefined, draftAbort.signal);
    draft = undefined; draftError = false;
    await refresh(saving.base.root.id);
  };
  return withBusy(async () => {
    try {
      await draftWrites;
      await store.action('Save draft', a => store.saveDraft(a, saving, stepThrough));
    } catch (error) {
      notify(`Draft retained. ${(error as Error).message}`, true, () => void saveDraft());
      return false;
    }
    if (!await reloadAfterSave(finish)) return false;
    notify('Saved. Preview now uses this arrangement.');
    return true;
  });
}
async function discardDraft() {
  if (busy || !draft) return;
  await withBusy(async () => {
    try {
      await draftWrites; await saveLibraryDraft(draftKey(draft!.base.root.id), undefined, draftAbort.signal);
      draft = undefined; draftError = false; workspace = publishedWorkspace; selectedBlock = ''; renderTimeline();
      await reloadAfterSave(() => refresh());
    } catch (error) { notify(`Could not discard draft: ${(error as Error).message}`, true, () => void discardDraft()); }
  });
}
async function leaveDraft(): Promise<boolean> {
  if (!draft) return true;
  const dialog = $<HTMLDialogElement>('draft-dialog');
  dialog.returnValue = ''; dialog.showModal();
  const choice = await new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (choice === 'save') return saveDraft();
  if (choice === 'discard') { await discardDraft(); return !draft && !reloadRequired; }
  return false;
}
async function askName(title: string, submit: string, value = '', hint = 'A source groups related media, such as video and audio from the same recording.'): Promise<string | undefined> {
  const dialog = $<HTMLDialogElement>('name-dialog');
  if (dialog.open) return;
  $('dialog-title').textContent = title; $('dialog-submit').textContent = submit; $('dialog-hint').textContent = hint;
  $<HTMLInputElement>('entity-name').value = value;
  dialog.returnValue = ''; dialog.showModal(); $<HTMLInputElement>('entity-name').focus();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'save' ? $<HTMLInputElement>('entity-name').value.trim() || 'Untitled' : undefined), { once: true }));
}
async function createSource() {
  if (busy || !await leaveDraft()) return;
  const name = await askName('Create a source', 'Create source');
  if (!name) return;
  tour.stop(false);
  await run('Create source', async action => {
    const root = await store.createSource(action, name); workspace = { root, lanes: [] }; selectedLane = ''; selectedBlock = '';
    localStorage.setItem(dataKey, root.id);
  });
}
async function addLane(kind: Kind) {
  if (busy || !workspace) return;
  const name = await askName(`Add ${kind} flow`, 'Add flow', `${kind === 'video' ? 'Video' : 'Audio'} ${workspace.lanes.filter(l => l.kind === kind).length + 1}`, `Drag ${kind} samples into this flow to build its timeline.`);
  if (!name) return;
  changeDraft(addDraftLane(workspace, kind, name), `Draft: add ${kind} flow`);
  const lane = workspace?.lanes.at(-1); if (lane) { selectedLane = lane.id; selectedBlock = ''; renderTimeline(); }
}
async function place(sample: Sample, laneId: string, raw: bigint, from?: MovingItem, pointer = false) {
  if (!workspace || busy) return false;
  if (raw > 86400n * 1000000000n) { notify('Keep this playpen within 24 hours.', true); return false; }
  const target = workspace.lanes.find(l => l.id === laneId); if (!target) return false;
  const original = workspace.lanes.find(l => l.id === from?.laneId)?.blocks.find(b => b.key === from?.key);
  const duration = from?.segment ? bounds(from.segment.timerange)[1] - bounds(from.segment.timerange)[0] : original ? blockEnd(original) - original.start : BigInt(sample.durationNs);
  const placement = planPlacement(workspace, target, sample, raw, duration, pixels(), view === 'segments', from, !pointer);
  if (placement.noop) return false;
  if (placement.invalid) { notify(placement.error ?? 'Cannot place here. Choose an empty part of a compatible flow.', true); return false; }
  selectedLane = laneId; selectedBlock = from?.key ?? ''; selectedSample = sample.id;
  const current = workspace;
  return withBusy(async () => {
    pendingPlacement = { laneId, start: placement.start, sample, duration }; renderPending(); controls();
    try {
      const boundaries = !from && !reusableSample(current.lanes.flatMap(l => l.blocks), sample) ? await store.segmentBoundaries(sample, draftAbort.signal) : undefined;
      if (resetting) return false;
      const next = editWorkspace(current, { laneId, start: placement.start, sample: from ? undefined : sample, fromLaneId: from?.laneId, key: from?.key, segment: from?.segment, insert: placement.insert, boundaries });
      selectedBlock = next.lanes.find(l => l.id === laneId)?.blocks.find(b => b.start === placement.start && b.sample.id === sample.id)?.key ?? from?.key ?? '';
      selectedSegment = from?.segment ? 0 : -1; inspectIngest = false;
      changeDraft(next, `Draft: ${placement.insert ? 'insert' : from ? 'move' : 'place'} ${sample.name}`); renderSamples();
      if (placement.insert) notify(`Inserted at ${fmt(seconds(placement.start))}. Later media in this flow moved by ${seconds(duration).toFixed(3)} s. Save to preview.`);
      return true;
    } catch (error) { notify((error as Error).message, true); return false; }
    finally { pendingPlacement = undefined; renderPending(); }
  });
}
function libraryNotice(message: string, error = false) {
  $('library-status').textContent = message; $('library-status').classList.toggle('error', error);
}
async function importFile(file: File, drop?: { rootId: string; laneId: string; raw: bigint }) {
  if (!libraryReady || libraryBusy) return;
  const controller = importing = new AbortController();
  libraryBusy = true; controls(); libraryNotice(`Preparing ${file.name}...`);
  let tracks: Awaited<ReturnType<typeof mediaWorker>>['tracks'];
  const action = store.beginAction(`Import ${file.name}`);
  if (drop) { const sample = { ...(samples.find(s => s.kind === workspace?.lanes.find(l => l.id === drop.laneId)?.kind) ?? samples[0]), name: file.name }; pendingPlacement = { laneId: drop.laneId, start: drop.raw, sample, importing: true }; renderPending(); }
  try {
    await store.action(action.name, async () => {
      tracks = await store.narrative(action, 'Prepare imported media', `Read ${file.name} and extract its H.264 video and AAC audio tracks.`, async () => (await mediaWorker({ file }, controller.signal)).tracks!, controller.signal);
      libraryNotice('Saving samples to the library...');
      await store.narrative(action, 'Save library samples', `Save ${tracks.length} tracks in this browser's library.`, () => saveLibrarySamples(tracks!, controller.signal), controller.signal);
      library = [...samples, ...await librarySamples()];
      selectedSample = tracks[0].sample.id;
      renderSamples(); libraryNotice('Ready in the library. Drag a sample onto a matching flow.');
    }, action);
  } catch (error) {
    tracks = undefined;
    libraryNotice(controller.signal.aborted ? 'Import cancelled.' : (error as Error).name === 'QuotaExceededError' ? 'Browser storage is full. Remove unused library samples and try again.' : (error as Error).message, !controller.signal.aborted);
  } finally { importing = undefined; libraryBusy = false; if (drop) { pendingPlacement = undefined; renderPending(); } controls(); }
  if (drop && tracks && !controller.signal.aborted && !resetting) {
    const lane = workspace?.root.id === drop.rootId ? workspace.lanes.find(l => l.id === drop.laneId) : undefined;
    const sample = tracks.find(t => t.sample.kind === lane?.kind)?.sample;
    if (!lane || !sample) { libraryNotice('The file is in the library. Drop a matching track onto an existing channel.', true); return; }
    await place(sample, lane.id, drop.raw, undefined, true);
  }
}
async function removeSample(id: string) {
  if (busy || libraryBusy || !library.some(s => s.id === id && s.imported)) return;
  if (draft?.workspace.lanes.some(l => l.blocks.some(b => b.sample.id === id))) { libraryNotice('Save or discard the draft before removing a sample it uses.', true); return; }
  libraryBusy = true; controls();
  try {
    await removeLibrarySample(id); library = library.filter(s => s.id !== id);
    if (selectedSample === id) selectedSample = samples[0].id;
    renderSamples(); libraryNotice('Removed from the library. Existing flow media is unchanged.');
  } catch (error) { libraryNotice((error as Error).message, true); }
  finally { libraryBusy = false; controls(); }
}
async function openLibrary() {
  if (!isSecureContext) { libraryNotice('Import requires HTTPS or localhost.'); return; }
  try { library = [...samples, ...await librarySamples(window.tasmStartup.signal)]; if (resetting) return; libraryReady = true; renderSamples(); }
  catch (error) { libraryNotice(`Library unavailable: ${(error as Error).message}`, true); }
  controls();
}
function wire() {
  $('close-glossary').onclick = () => {
    const glossary = $('close-glossary').closest('details')!;
    glossary.open = false; glossary.querySelector('summary')!.focus();
  };
  document.addEventListener('click', event => {
    const path = (event.target as HTMLElement).closest<HTMLElement>('[data-resource]')?.dataset.resource;
    if (path && store) fillResource(path);
  });
  // User edits leave the example; programmatic actions within the tour keep it active.
  const manualActions = '#save-draft,#discard-draft,#new-source,#empty-create,#rename-source,#add-video,#add-audio,[data-add-kind],#add-sample,#move-block,#remove-block,#import-media,[data-remove-sample],#read-range,#play-range';
  document.addEventListener('click', event => {
    if (event.isTrusted && (event.target as HTMLElement).closest(manualActions)) tour.stop(false);
  }, true);
  document.addEventListener('input', event => {
    if (event.isTrusted && (event.target as HTMLElement).matches('#range-start,#range-end,#block-start,#sources,#preview-video,#preview-audio')) tour.stop(false);
  }, true);
  $('save-draft').onclick = () => void saveDraft();
  $('discard-draft').onclick = () => void discardDraft();
  $('asap').onchange = () => { $<HTMLInputElement>('step-through').checked = !$<HTMLInputElement>('asap').checked; };
  $('step-through').onchange = () => { $<HTMLInputElement>('asap').checked = !$<HTMLInputElement>('step-through').checked; };
  window.addEventListener('beforeunload', event => { if (draftPending || draftError || busy && draft) { event.preventDefault(); event.returnValue = ''; } });
  $('about-playpen').onclick = () => $<HTMLDialogElement>('playpen-about').showModal();
  $('new-source').onclick = () => void createSource();
  $('import-media').onclick = () => $<HTMLInputElement>('media-file').click();
  $('media-file').onchange = () => {
    const input = $<HTMLInputElement>('media-file'), file = input.files?.[0]; input.value = '';
    if (file && !libraryBusy && !resetting) void importFile(file);
  };
  $('import-cancel').onclick = () => importing?.abort();
  for (const mode of ['flows', 'segments'] as const) {
    const tab = $(`${mode}-tab`);
    tab.onclick = () => {
      view = mode; selectedSegment = -1;
      for (const m of ['flows', 'segments']) { const t = $(`${m}-tab`); t.classList.toggle('active', m === mode); t.setAttribute('aria-selected', String(m === mode)); t.tabIndex = m === mode ? 0 : -1; }
      $('timeline-scroll').setAttribute('aria-labelledby', `${mode}-tab`); renderTimeline();
    };
    tab.onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = $(event.key === 'Home' ? 'flows-tab' : event.key === 'End' ? 'segments-tab' : `${mode === 'flows' ? 'segments' : 'flows'}-tab`); next.click(); next.focus(); } };
  }
  document.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = (event.target as HTMLElement).closest('#library-section,[data-track]') && libraryReady && !libraryBusy && !busy ? 'copy' : 'none';
  });
  document.addEventListener('drop', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    tour.stop(false);
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-track]');
    if (!target && !(event.target as HTMLElement).closest('#library-section')) { libraryNotice('Drop files into the Sample library or onto a matching channel.'); return; }
    if (event.dataTransfer.files.length !== 1) { libraryNotice('Import one file at a time.', true); return; }
    if (!resetting && !libraryBusy && !busy && libraryReady) void importFile(event.dataTransfer.files[0], target && workspace ? { rootId: workspace.root.id, laneId: target.dataset.track!, raw: BigInt(Math.round(Math.max(0, (event.clientX - target.getBoundingClientRect().left) / pixels()) * 1e9)) } : undefined);
  });
  window.addEventListener('pagehide', () => importing?.abort());
  $('add-video').onclick = () => void addLane('video'); $('add-audio').onclick = () => void addLane('audio');
  $('rename-source').onclick = async () => {
    if (!workspace || busy) return;
    const name = await askName('Rename source', 'Save name', workspace.root.label);
    if (name) await run('Rename source', a => store.renameSource(a, workspace!.root, name));
  };
  $('dialog-cancel').onclick = () => $<HTMLDialogElement>('name-dialog').close();
  $('sources').onchange = async () => {
    const id = $<HTMLSelectElement>('sources').value;
    if (!id || busy || workspace?.root.id === id) return;
    $<HTMLSelectElement>('sources').value = workspace?.root.id ?? '';
    if (!await leaveDraft()) return;
    tour.stop(false);
    retryAction = undefined; $('notice').hidden = true;
    await withBusy(async () => {
      selectedLane = ''; selectedBlock = '';
      try { await store.action('Open source', async a => { await store.recover(id, a); workspace = await store.load(id, a); }); if (resetting) return; localStorage.setItem(dataKey, id); await refresh(id); }
      catch (error) { notify((error as Error).message, true); }
    });
  };
  for (const kind of ['video', 'audio'] as const) $(`preview-${kind}`).onchange = async () => {
    if (!publishedWorkspace) return;
    tour.stop(false); rangeReady = false; preview.stopRange();
    preview.select(publishedWorkspace, kind, $<HTMLSelectElement>(`preview-${kind}`).value);
    await withBusy(async () => { await updatePreview(true); renderTimeline(); });
  };
  $('seek-button').onclick = () => { try { void preview.seek(seconds(nsInput($<HTMLInputElement>('seek-time').value))).catch(e => notify(e.message, true)); } catch (error) { notify((error as Error).message, true); } };
  $('seek-time').onkeydown = event => { if (event.key === 'Enter') $('seek-button').click(); };
  $('dismiss-notice').onclick = () => { if (!reloadRequired) { retryAction = undefined; $('notice').hidden = true; } };
  $('retry-action').onclick = () => { $('notice').hidden = true; const retry = retryAction; retryAction = undefined; retry?.(); };
  $('follow-requests').onclick = () => { followRequests = true; selectedAction = store.actions[0]?.id; selectedRequest = -1; renderRequests(); };
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => button.onclick = () => {
    filter = button.dataset.filter!; document.querySelectorAll('[data-filter]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); }); renderSamples();
  });
  $('samples').onclick = event => {
    const remove = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-sample]')?.dataset.removeSample;
    if (remove) { if (!libraryBusy && !resetting) void removeSample(remove); return; }
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-sample]')?.dataset.sample;
    if (!id) return; selectedSample = id;
    const sample = library.find(s => s.id === id)!;
    if (!workspace?.lanes.some(l => l.id === selectedLane && l.kind === sample.kind)) selectedLane = workspace?.lanes.find(l => l.kind === sample.kind)?.id ?? selectedLane;
    selectedBlock = ''; renderSamples(); renderTimeline(); controls();
  };
  $('add-sample').onclick = () => void place(library.find(s => s.id === selectedSample)!, selectedLane, BigInt(Math.round((preview.currentTime || 0) * 25)) * 40000000n);
  $('timeline').onclick = event => {
    const target = event.target as HTMLElement;
    if (target.closest('#empty-create')) { void createSource(); return; }
    const kind = target.closest<HTMLElement>('[data-add-kind]')?.dataset.addKind; if (kind) { void addLane(kind as Kind); return; }
    const clip = target.closest<HTMLElement>('[data-block]');
    const lane = target.closest<HTMLElement>('[data-select-lane]');
    if (clip) { selectedLane = clip.dataset.blockLane!; selectedBlock = clip.dataset.block!; selectedSegment = Number(clip.dataset.editSegmentIndex ?? -1); inspectIngest = false; const block = currentBlock()!.block; selectedObject = block.segments[selectedSegment >= 0 ? selectedSegment : Number(target.closest<HTMLElement>('[data-segment-index]')?.dataset.segmentIndex ?? 0)]?.object_id ?? ''; renderTimeline(); correlateObject(); }
    else if (lane) { selectedLane = lane.dataset.selectLane!; selectedBlock = ''; inspectIngest = false; selectedObject = ''; renderTimeline(); }
    else {
      const ruler = target.closest<HTMLElement>('.ruler'), track = target.closest<HTMLElement>('.lane-track');
      const surface = ruler ?? track;
      if (surface) { if (track) { selectedLane = track.dataset.track!; selectedBlock = ''; } void preview.seek(Math.max(0, (event.clientX - surface.getBoundingClientRect().left) / pixels())).catch(e => notify(e.message, true)); updateSelection(); controls(); }
    }
  };
  $('zoom-out').onclick = () => { zoom = Math.max(0.5, zoom / 1.5); renderTimeline(); };
  $('zoom-in').onclick = () => { zoom = Math.min(6, zoom * 1.5); renderTimeline(); };
  $('move-block').onclick = () => {
    const current = currentBlock(); if (!current) return;
    try { void place(current.block.sample, $<HTMLSelectElement>('block-target').value, nsInput($<HTMLInputElement>('block-start').value), movingItem(current.lane, current.block, view === 'segments' ? Math.max(0, selectedSegment) : undefined)); }
    catch (error) { notify((error as Error).message, true); }
  };
  $('block-start').onkeydown = event => { if (event.key === 'Enter') $('move-block').click(); };
  $('remove-block').onclick = () => {
    const current = currentBlock(); if (!current || !workspace) return;
    const from = movingItem(current.lane, current.block, view === 'segments' ? Math.max(0, selectedSegment) : undefined);
    try { changeDraft(editWorkspace(workspace, { laneId: current.lane.id, fromLaneId: from.laneId, key: from.key, segment: from.segment, remove: true }), `Draft: remove ${current.block.sample.name}`); selectedSegment = -1; } catch (error) { notify((error as Error).message, true); }
  };
  $('action-history').onchange = () => { followRequests = false; selectedAction = $<HTMLSelectElement>('action-history').value; selectedRequest = -1; renderRequests(); };
  $('requests').onclick = event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-request]');
    if (!row) return;
    followRequests = false;
    selectedRequest = Number(row.dataset.request);
    const record = store.actions.find(action => action.id === selectedAction)?.requests[selectedRequest];
    if (!record) return;
    terminal.fill(record);
    if (record.objectId || record.objectIds?.length) {
      selectedObject = record.objectId ?? (record.objectIds!.includes(selectedObject) ? selectedObject : record.objectIds![0]);
      inspectIngest = !!record.blockId && record.blockId === store.ingest?.block?.key;
      if (!inspectIngest) {
        const match = workspace?.lanes.flatMap(lane => lane.blocks.map(block => ({ lane, block }))).find(({ block }) =>
          record.blockId ? block.key === record.blockId : block.segments.some(segment => segment.object_id === selectedObject));
        if (match) {
          selectedLane = match.lane.id; selectedBlock = match.block.key;
          selectedSegment = match.block.segments.findIndex(segment => segment.object_id === selectedObject);
        }
      }
      renderTimeline();
    }
    renderRequests();
  };
  $('copy-request').onclick = async () => {
    const action = store.actions.find(a => a.id === selectedAction), record = action?.requests[selectedRequest < 0 ? action.requests.length - 1 : selectedRequest];
    if (record) try { await navigator.clipboard.writeText(`${record.method} ${record.url}\n${Object.entries(record.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}${record.body === undefined ? '' : '\n\n' + JSON.stringify(record.body, null, 2)}`); notify('Request copied.'); } catch { notify('Clipboard access was unavailable.', true); }
  };
  document.addEventListener('keydown', event => {
    if (['Delete', 'Backspace'].includes(event.key) && event.target instanceof HTMLElement && !!event.target.closest('#timeline-scroll,#block-controls') && !event.target.closest('select,textarea,[contenteditable=true]') && !document.querySelector('dialog[open]') && !(event.target instanceof HTMLInputElement) && !busy && currentBlock()) { event.preventDefault(); tour.stop(false); $('remove-block').click(); }
  });
  $('ingest-next').onclick = () => store.ingest?.next();
  $('ingest-run').onclick = () => store.ingest?.runRemaining();
  $('ingest-cancel').onclick = () => store.ingest?.cancel();
  $('objects').onclick = event => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-object]')?.dataset.object;
    if (!id) return;
    fillResource('objects/' + encodeURIComponent(id));
    selectedObject = id;
    const refs = mediaObjects().find(o => o.id === id)?.refs ?? [];
    const ref = refs.find(r => r.block.key === selectedBlock) ?? refs[0];
    inspectIngest = !ref;
    if (ref) { selectedLane = ref.lane.id; selectedBlock = ref.block.key; selectedSegment = ref.index; }
    renderTimeline(); correlateObject();
  };
  $('storage-refresh').onclick = () => { if (!busy) void verifyStorage(); };
  $('copy-object-id').onclick = async () => {
    if (selectedObject) try { await navigator.clipboard.writeText(selectedObject); notify('Object ID copied.'); }
    catch { notify('Clipboard access was unavailable. Select the ID to copy it.', true); }
  };
  for (const id of ['range-start', 'range-end']) $(id).oninput = () => { tour.stop(false); rangeReady = false; preview.stopRange(); controls(); $('range-result').textContent = 'Range changed. Query the selected preview flows again.'; };
  $('read-range').onclick = () => void readRange();
  $('play-range').onclick = () => { void preview.playRange(seconds(nsInput($<HTMLInputElement>('range-start').value)), seconds(nsInput($<HTMLInputElement>('range-end').value))).catch(e => notify(e.message, true)); };
  document.addEventListener('pointerdown', beginDrag);

}
async function readRange(): Promise<ActionRecord | undefined> {
  const saved = publishedWorkspace;
  if (!saved || busy) return;
  return withBusy(async () => {
    try {
      const start = nsInput($<HTMLInputElement>('range-start').value), end = nsInput($<HTMLInputElement>('range-end').value);
      if (end <= start || seconds(end) > sourceEnd(saved)) throw new Error('Choose a range inside the saved source duration, with the end after the start.');
      rangeReady = false; preview.pause(); followRequests = true; controls();
      const queryAction = store.beginAction('Read time range');
      const result = await store.action(queryAction.name, a => store.readRange(a, saved, preview.selection, start, end), queryAction);
      rangeReady = true;
      $('range-result').innerHTML = `<p>${result.segments.length} segments · ${result.objects} unique objects · ${result.bytes.toLocaleString()} bytes read from the saved source. Playback uses ${fmt(seconds(start))}–${fmt(seconds(end))}.</p><details open><summary>Matching flows, segments and media objects</summary><div class="range-results"><table><thead><tr><th>Flow</th><th>Segment range</th><th>Object ID</th><th>Bytes read</th></tr></thead><tbody>${result.flows.flatMap(flow => flow.segments.length ? flow.segments.map(segment => `<tr><td>${escape(flow.label)}<br>${resourceButton('flows', flow.id, shortFlowId(flow.id))}</td><td>${escape(segment.timerange)}</td><td>${resourceButton('objects', segment.object_id)}</td><td>${result.objectBytes.get(segment.object_id)?.toLocaleString()} B</td></tr>`) : [`<tr><td>${escape(flow.label)}</td><td colspan="3">No matching segments</td></tr>`]).join('')}</tbody></table></div></details><button id="range-api">Inspect query API</button>`;
      setText($('range-status'), $('range-result').querySelector('p')!.textContent!);
      $('range-api').onclick = () => { followRequests = false; selectedAction = queryAction.id; selectedRequest = -1; renderRequests(); $('review-requests').click(); };
      return queryAction;
    } catch (error) { notify((error as Error).message, true); }
  });
}

let dragPointer: number | undefined;
function beginDrag(event: PointerEvent) {
  if (busy || libraryBusy || !event.isPrimary || event.button !== 0 || dragPointer !== undefined) return;
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-sample],[data-block]');
  if (!element) return;
  const lane = workspace?.lanes.find(l => l.id === element.dataset.blockLane);
  const original = lane?.blocks.find(b => b.key === element.dataset.block);
  const index = element.dataset.editSegmentIndex === undefined ? undefined : Number(element.dataset.editSegmentIndex);
  const segment = index === undefined ? undefined : original?.segments[index];
  const block = segment && original ? { ...original, segments: [segment], start: bounds(segment.timerange)[0] } : original;
  const from = original && lane ? movingItem(lane, original, index) : undefined;
  const sample = block?.sample ?? library.find(s => s.id === element.dataset.sample);
  if (!sample) return;
  dragPointer = event.pointerId;
  // Keep the timeline at the same screen coordinates until the pointer is released.
  clearTimeout(noticeTimer);
  const offset = block ? event.clientX - element.getBoundingClientRect().left : 0;
  let dragging = false, ghost: HTMLElement | undefined, drop: HTMLElement | undefined, guide: HTMLElement | undefined;
  let lastPointer = event, scrollTimer: ReturnType<typeof setInterval> | undefined;
  let targetLane: Lane | undefined, raw = 0n;
  const clearShift = () => {
    document.querySelectorAll('.insert-tail').forEach(el => el.remove());
    document.querySelectorAll<HTMLElement>('.insert-shift').forEach(el => {
      el.classList.remove('insert-shift'); el.style.removeProperty('transform');
      if (el.dataset.previewWidth) {
        el.style.width = el.dataset.previewWidth;
        el.querySelector('.clip-duration')!.textContent = `${(Number.parseFloat(el.style.width) / pixels()).toFixed(2)}s`;
        delete el.dataset.previewWidth;
      }
    });
  };
  const cleanup = () => { dragPointer = undefined; scheduleNoticeDismissal(); clearShift(); clearInterval(scrollTimer); ghost?.remove(); drop?.remove(); guide?.remove(); document.body.classList.remove('dragging'); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', escapeDrag); window.removeEventListener('blur', cleanup); document.removeEventListener('visibilitychange', visibility); };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    lastPointer = e;
    if (!dragging && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 6) return;
    e.preventDefault();
    if (!dragging) { tour.stop(false); dragging = true; document.body.classList.add('dragging'); ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.textContent = sample.name; document.body.append(ghost);
      scrollTimer = setInterval(() => {
        const scroller = $('timeline-scroll'), rect = scroller.getBoundingClientRect(), e = lastPointer;
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
        const x = scroller.scrollLeft, y = scroller.scrollTop;
        scroller.scrollLeft += e.clientX > rect.right - 30 ? 12 : e.clientX < rect.left + 185 ? -12 : 0;
        scroller.scrollTop += e.clientY > rect.bottom - 30 ? 10 : e.clientY < rect.top + 45 ? -10 : 0;
        if (x !== scroller.scrollLeft || y !== scroller.scrollTop) move(e);
      }, 40);
    }
    ghost!.textContent = sample.name; ghost!.style.maxWidth = 'min(360px, calc(100vw - 24px))';
    ghost!.style.left = `${e.clientX + 14}px`; ghost!.style.top = `${e.clientY + 14}px`;
    const track = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-track]');
    clearShift(); drop?.remove(); guide?.remove(); targetLane = workspace?.lanes.find(l => l.id === track?.dataset.track);
    if (!track || !targetLane) return;
    const position = Math.max(0, (e.clientX - track.getBoundingClientRect().left - offset) / pixels());
    drop = document.createElement('div'); drop.className = 'drop-preview';
    const duration = block ? blockEnd(block) - block.start : BigInt(sample.durationNs);
    raw = BigInt(Math.round(position * 1e9));
    const placement = planPlacement(workspace!, targetLane, sample, raw, duration, pixels(), view === 'segments', from);
    const { start, invalid } = placement;
    if (placement.snapped !== undefined) { guide = document.createElement('div'); guide.className = 'snap-guide'; guide.style.left = `${156 + seconds(placement.snapped) * pixels()}px`; guide.setAttribute('aria-hidden', 'true'); $('timeline').append(guide); }
    drop.classList.toggle('invalid', invalid); drop.style.left = `${seconds(start) * pixels()}px`; drop.style.width = `${seconds(duration) * pixels()}px`;
    drop.textContent = invalid ? placement.error ?? 'Cannot place here' : placement.noop ? 'Original position' : placement.insert ? `Insert at ${fmt(seconds(start))} · segment boundary · later media +${seconds(duration).toFixed(3)} s` : fmt(seconds(start)); track.append(drop);
    ghost!.textContent = `${sample.name} · ${drop.textContent}`;
    const box = ghost!.getBoundingClientRect();
    ghost!.style.left = `${Math.max(12, Math.min(e.clientX + 14, innerWidth - box.width - 12))}px`;
    ghost!.style.top = `${Math.max(12, Math.min(e.clientY + 14, innerHeight - box.height - 12))}px`;
    if (placement.insert && !invalid) {
      for (const el of track.querySelectorAll<HTMLElement>('[data-block]')) {
        const left = Number.parseFloat(el.style.left), width = Number.parseFloat(el.style.width), cut = seconds(start) * pixels();
        if (from && el.dataset.block === from.key && (from.segment ? el.dataset.editSegmentIndex === String(index) : true)) continue;
        if (left >= cut) {
          el.classList.add('insert-shift'); el.style.transform = `translateX(${seconds(duration) * pixels()}px)`;
        } else if (left + width > cut) {
          const tail = el.cloneNode(true) as HTMLElement;
          tail.classList.add('insert-tail'); tail.removeAttribute('data-block'); tail.setAttribute('aria-hidden', 'true'); tail.tabIndex = -1;
          tail.style.left = `${cut + seconds(duration) * pixels()}px`; tail.style.width = `${left + width - cut}px`; track.append(tail);
          tail.querySelector('.clip-duration')!.textContent = `${((left + width - cut) / pixels()).toFixed(2)}s`;
          el.dataset.previewWidth = el.style.width; el.classList.add('insert-shift'); el.style.width = `${cut - left}px`;
          el.querySelector('.clip-duration')!.textContent = `${((cut - left) / pixels()).toFixed(2)}s`;
        }
      }
    }

  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    cleanup();
    if (!dragging) return;
    const suppressClick = (e: MouseEvent) => { e.stopImmediatePropagation(); e.preventDefault(); };
    document.addEventListener('click', suppressClick, { once: true, capture: true });
    setTimeout(() => document.removeEventListener('click', suppressClick, true), 0);
    if (targetLane) void place(sample, targetLane.id, raw, from, true);
    else notify(workspace?.lanes.length ? 'Drop the sample onto a compatible flow.' : 'Create a source and add a flow first.');
  };
  const cancel = (e: PointerEvent) => { if (e.pointerId === event.pointerId) cleanup(); };
  const visibility = () => { if (document.hidden) cleanup(); };
  const escapeDrag = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cleanup(); } };
  window.addEventListener('blur', cleanup); document.addEventListener('visibilitychange', visibility);
  document.addEventListener('keydown', escapeDrag);
  document.addEventListener('pointermove', move, { passive: false }); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', cancel);
}

function renderPending() {
  document.querySelector('.pending-placement')?.remove();
  if (!pendingPlacement) return;
  const { laneId, start, sample, duration, importing } = pendingPlacement;
  const track = document.querySelector(`[data-track="${CSS.escape(laneId)}"]`);
  if (!track) return;
  const pending = document.createElement('div'); pending.className = 'drop-preview pending-placement';
  pending.style.left = `${seconds(start) * pixels()}px`; pending.style.width = `${seconds(duration ?? BigInt(sample.durationNs)) * pixels()}px`;
  pending.innerHTML = !importing && store?.ingest?.block && ['running', 'paused'].includes(store.ingest.status) ? `${segmentMarks(store.ingest.block)}<span>${escape(sample.name)} · provisional</span>` : `${escape(sample.name)} · ${importing ? 'importing' : 'preparing'}…`; track.append(pending);
}
const stageText: Record<string, string> = {
  segment: 'Prepare media objects at packet boundaries, aiming for two-second segments.',
  allocate: 'Allocate an upload URL for each media object. No bytes are stored yet.',
  upload: 'Store the media bytes. The timeline has not been published yet.',
  register: 'Link each stored object to its time range in the flow.',
  update: 'Publish the completed arrangement for preview.',
  query: 'Find the segments covering the selected time range.',
  read: 'Read each matching object in full. Playback uses only the selected time range.'
};
function segmentMarks(block: Block) {
  const duration = seconds(blockEnd(block) - block.start);
  return `<span class="segment-marks">${block.segments.map((s, i) => `<span class="segment-mark ${selectedObject === s.object_id ? 'selected' : ''}" data-segment-index="${i}" data-segment-object="${escape(s.object_id)}" style="left:${seconds(bounds(s.timerange)[0] - block.start) / duration * 100}%;width:${seconds(bounds(s.timerange)[1] - bounds(s.timerange)[0]) / duration * 100}%" title="Segment ${i + 1}: ${escape(s.timerange)}"><span>${seconds(bounds(s.timerange)[1] - bounds(s.timerange)[0]) * pixels() >= 22 ? String(i + 1).padStart(2, '0') : ''}</span></span>`).join('')}</span>`;
}
function renderIngest() {
  if (resetting) return;
  const session = store?.ingest; if (!session) return;
  const active = ['running', 'paused'].includes(session.status), paused = session.status === 'paused';
  if (active) $<HTMLDetailsElement>('ingest-controls').open = true;
  if (paused) $('runtime-status').textContent = 'Ingest paused';
  $('ingest-title').textContent = `Save draft · ${session.status}`;
  $('ingest-summary').textContent = `${session.objects.length} objects · ${session.objects.filter(o => o.reused).length} reused · ${session.uploadedBytes.toLocaleString()} bytes uploaded`;
  $<HTMLButtonElement>('ingest-next').disabled = !paused; $<HTMLButtonElement>('ingest-run').disabled = !paused;
  $<HTMLButtonElement>('ingest-cancel').disabled = !active || session.published;
  const planned = session.pending;
  if (followRequests && planned?.objectId && session.objects.some(o => o.segment.object_id === planned.objectId)) selectedObject = planned.objectId;
  $('planned-request').hidden = !planned;
  if (planned) $('planned-request').innerHTML = `<strong>Next operation · not sent</strong><p>${escape(planned.method)} ${escape(new URL(planned.url).pathname)}</p><pre>${escape(JSON.stringify(planned.body ?? '(no body)', null, 2))}</pre>`;
  renderObjects(); updateSelection();
}
function mediaObjects() {
  const refs = publishedWorkspace?.lanes.flatMap(lane => lane.blocks.flatMap(block => block.segments.map((segment, index) => ({ lane, block, segment, index })))) ?? [];
  const objects = new Map<string, typeof refs>();
  for (const ref of refs) { const list = objects.get(ref.segment.object_id) ?? []; list.push(ref); objects.set(ref.segment.object_id, list); }
  const session = store?.ingest, active = session && ['running', 'paused'].includes(session.status);
  if (active) for (const object of session.objects) if (!objects.has(object.segment.object_id)) objects.set(object.segment.object_id, []);
  return [...objects].map(([id, refs]) => ({ id, refs, pending: active ? session.objects.find(o => o.segment.object_id === id) : undefined }));
}
async function verifyStorage() {
  const objects = mediaObjects().filter(o => o.refs.length);
  if (resetting || checkingStorage || !objects.length) return;
  const version = workspaceVersion;
  checkingStorage = true; renderObjects();
  try {
    await store.action('Verify stored media', async action => {
      for (const { id, refs } of objects) {
        if (resetting || version !== workspaceVersion) return;
        const url = refs[0].segment.get_urls?.[0]?.url;
        const check = await store.checkStorage(action, id, url, AbortSignal.timeout(10000));
        if (resetting || version !== workspaceVersion) return;
        storageChecks.set(id, check);
      }
    });
  } catch (error) { if (!resetting) notify(`Storage check could not finish: ${(error as Error).message}`, true); }
  finally { checkingStorage = false; if (!resetting) { renderObjects(); if (version !== workspaceVersion) void verifyStorage(); } }
}
function renderObjects() {
  const focused = (document.activeElement as HTMLElement)?.dataset.object;
  const objects = mediaObjects(); let stored = 0, bytes = 0;
  if (!objects.some(o => o.id === selectedObject)) selectedObject = objects[0]?.id ?? '';
  $('storage').setAttribute('aria-busy', String(checkingStorage));
  $<HTMLButtonElement>('storage-refresh').disabled = busy || checkingStorage || !objects.length;
  $('storage-count').textContent = `${objects.length} object${objects.length === 1 ? '' : 's'}`;
  $('selected-object').hidden = !objects.length;
  $('objects').innerHTML = !objects.length ? '' : `<table><thead><tr><th scope="col">Object UUID</th><th scope="col">Media</th><th scope="col">Flow / segments</th><th scope="col">Size</th><th scope="col">State</th></tr></thead><tbody>${objects.map(({ id, refs, pending }) => {
    const check = storageChecks.get(id), uploaded = pending && !pending.reused && ['uploaded', 'registered'].includes(pending.state);
    const state = check?.state ?? (uploaded ? 'stored' : pending && !pending.reused ? pending.state : 'unchecked');
    const size = check?.state === 'stored' ? check.bytes : (uploaded ? pending.bytes : undefined);
    if (state === 'stored') { stored++; bytes += size ?? 0; }
    const label = ({ stored: 'Stored', missing: 'Missing', unknown: 'Not confirmed', unchecked: 'Not checked', prepared: 'Waiting', allocated: 'Uploading' } as Record<string, string>)[state] ?? state;
    return `<tr data-state="${state}" class="${selectedObject === id ? 'selected' : ''}"><td><button data-object="${escape(id)}" aria-pressed="${selectedObject === id}" title="${escape(id)}">${escape(id.split(':').at(-1))}</button></td><td>${[...new Set(refs.map(r => escape(r.block.sample.name)))].join('<br>') || escape(pending?.sample?.name ?? 'Save in progress')}</td><td>${refs.map(r => `${escape(r.lane.flow.label)} · ${r.index + 1}<small>${bounds(r.segment.timerange).map(n => seconds(n).toFixed(3)).join('–')} s</small>`).join('') || 'Not published'}</td><td>${size === undefined ? '—' : size.toLocaleString() + ' B'}</td><td>${label}${uploaded && !refs.length ? '<small>Not published</small>' : ''}</td></tr>`;
  }).join('')}</tbody></table>`;
  $('storage-summary').textContent = !objects.length ? 'No objects stored yet.' : checkingStorage ? 'Checking storage...' : `${stored} of ${objects.length} objects stored · ${bytes.toLocaleString()} bytes`;
  if (focused) $('objects').querySelector<HTMLButtonElement>(`[data-object="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  $('selected-object-id').textContent = selectedObject;
  const selected = objects.find(o => o.id === selectedObject);
  const segment = (selected?.refs.find(r => r.block.key === selectedBlock) ?? selected?.refs[0])?.segment ?? selected?.pending?.segment;
  $('time-details').hidden = !segment;
  if (!segment) { $('time-equation').textContent = ''; return; }
  const [start, end] = bounds(segment.timerange), offset = timestampToNumber(segment.ts_offset);
  $('time-equation').textContent = `Object time ${(seconds(start) - offset).toFixed(9)}–${(seconds(end) - offset).toFixed(9)} s + ts_offset ${offset.toFixed(9)} s = flow time ${seconds(start).toFixed(9)}–${seconds(end).toFixed(9)} s`;
}
function timestampToNumber(value = '0:0') { return seconds(parseTimestamp(value)); }
function correlateObject() {
  const related = (r: ActionRecord['requests'][number]) => r.objectId === selectedObject || !!r.objectIds?.includes(selectedObject);
  const action = store.actions.find(a => a.requests.some(related));
  if (action) { selectedAction = action.id; selectedRequest = action.requests.map(related).lastIndexOf(true); followRequests = false; }
  renderRequests();
}

// Each tour run owns one example. Completed writes survive dismissal and retries.
let example: { id: string; source_id: string; label?: string; root?: Flow; done: Set<string>; sourceRead?: string; query?: ActionRecord; saved?: { total: number; reused: string[]; added: number } };
const exampleSample = (id: string) => samples.find(sample => sample.id === id)!;
const exampleLane = (kind: Kind) => {
  if (workspace?.root.id !== example.id) throw new Error('Open the guided example or start a new tour to continue.');
  const lane = workspace.lanes.find(lane => lane.kind === kind);
  if (!lane) throw new Error(`The example needs its ${kind} flow. Start a new tour if it was removed.`);
  return lane;
};
async function persistExampleDraft() {
  await draftWrites;
  if (draftError) throw new Error('The draft could not be stored locally. Save it before continuing.');
}
async function createExample() {
  await persistExampleDraft();
  await withBusy(async () => {
    preview.pause();
    if (!example.root) {
      sources = await store.sources();
      let number = 1;
      while (sources.some(source => source.label === `Guided offset example${number === 1 ? '' : ` ${number}`}`)) number++;
      example.label ??= `Guided offset example${number === 1 ? '' : ` ${number}`}`;
      example.root = await store.action('Create guided example', action => store.createSource(action, example.label!, example));
    }
    localStorage.setItem(dataKey, example.id);
    await refresh(example.id);
  });
}
async function placeExample(id: string, time: bigint) {
  const sample = exampleSample(id), lane = exampleLane(sample.kind as Kind), key = `${id}:${time}`;
  preview.pause(); $('flows-tab').click();
  if (!example.done.has(key)) {
    if (!await place(sample, lane.id, time)) throw new Error($('notice-text').textContent || 'The sample could not be placed.');
    example.done.add(key);
  }
  await persistExampleDraft();
}
async function saveExample() {
  exampleLane('video');
  const before = new Set(publishedWorkspace?.lanes.flatMap(lane => lane.blocks.flatMap(block => block.segments.map(segment => segment.object_id))) ?? []);
  if (!draft) {
    await withBusy(() => refresh(example.id));
  } else {
    // The guided Save runs to completion; ordinary editing retains its chosen mode.
    if (!await saveDraft(false)) throw new Error($('notice-text').textContent || 'Save failed. Your draft is retained.');
  }
  const after = new Set(publishedWorkspace?.lanes.flatMap(lane => lane.blocks.flatMap(block => block.segments.map(segment => segment.object_id))) ?? []);
  const reused = [...after].filter(id => before.has(id));
  example.saved = { total: after.size, reused, added: after.size - reused.length };
}
async function playExample(start: number, end: number, signal: AbortSignal) {
  exampleLane('video');
  if (draft) throw new Error('Save your changes before playing the example.');
  signal.throwIfAborted(); preview.pause();
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      preview.removeEventListener('rangeend', ended); preview.removeEventListener('rangecancel', cancelled);
      preview.removeEventListener('error', failed); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const ended = () => finish();
    const cancelled = () => finish(new Error('Playback stopped before the range finished. Replay this range to continue.'));
    const failed = (event: Event) => finish(new Error((event as CustomEvent<string>).detail));
    const aborted = () => finish(new DOMException('Tour ended', 'AbortError'));
    preview.addEventListener('rangeend', ended); preview.addEventListener('rangecancel', cancelled);
    preview.addEventListener('error', failed); signal.addEventListener('abort', aborted, { once: true });
    void preview.playRange(start, Math.min(end, sourceEnd(publishedWorkspace))).catch(finish);
  });
}
function savedExampleResult() {
  const saved = example.saved!;
  return { target: '#draft-status, #storage-count', title: 'The arrangement is saved',
    text: `${saved.total} media objects are referenced by this saved source. ${saved.reused.length} existing objects were reused and ${saved.added} new objects were added. ${previewBusy || !preview.loaded ? 'The preview is being prepared.' : 'The preview uses this saved arrangement.'}` };
}
function insertionResult(kind: Kind) {
  const lane = exampleLane(kind), blocks = [...lane.blocks].sort((a, b) => a.start < b.start ? -1 : 1);
  const inserted = blocks[1], resumed = blocks[2], cut = seconds(inserted.start).toFixed(3), resume = seconds(resumed.start).toFixed(3);
  return { target: `[data-block="${inserted.key}"], [data-block="${resumed.key}"]`, title: kind === 'audio' ? 'Voice A now resumes after Voice B' : 'The original video now resumes after the insertion',
    text: `${kind === 'audio' ? 'Voice A' : 'The original newsreader'} plays to ${cut} seconds. The inserted clip plays in full, then the original resumes at timeline ${resume} seconds from its ${cut}-second position. This is a local draft. Save to update playback.` };
}
const tour = createTour('playpen', [
  { target: '.source-toolbar', title: 'Build a separate example', text: 'Create a Guided offset example using newsreader and voice samples. Your existing sources and drafts stay available. Each action is followed by an explanation of its result.', actionLabel: 'Create example', action: createExample,
    result: () => ({ target: '#sources', title: 'Your example has its own source', text: `${example.label} is now selected. This source groups the video and audio you will arrange. Your other sources and drafts are still available.` }) },
  { target: '.timeline-tools', title: 'Give the source video and audio flows', text: 'Add separate flows for picture and voice, each with its own timeline.', actionLabel: 'Add flows', action: async () => {
    if (workspace?.root.id !== example.id) throw new Error('Open the guided example to continue.');
    let next = workspace;
    for (const kind of ['video', 'audio'] as const) if (!next.lanes.some(lane => lane.kind === kind)) next = addDraftLane(next, kind, kind === 'video' ? 'Newsreader' : 'Voice');
    changeDraft(next, 'Draft: add example flows'); await persistExampleDraft();
  }, result: () => ({ target: '.lane-header', title: 'Picture and voice have separate timelines', text: 'The Newsreader video flow and Voice audio flow are in your local draft. Editing one flow will leave the other at its existing times.' }) },
  { target: '#library-section', title: 'Arrange newsreader and voice samples', text: 'Place Newsreader and Voice A at zero. The newsreader is silent; the voice is assembled from the supplied words. You can also import your own H.264 video or AAC audio.', actionLabel: 'Add samples', action: async () => { await placeExample('newsreader-offset', 0n); await placeExample('voice-a', 0n); },
    result: () => ({ target: '.clip, #draft-status', title: 'The clips are placed in your draft', text: 'Newsreader and Voice A start together at zero. Their positions are stored locally. Save will register the media objects and segments and prepare playback.' }) },
  { target: '.draft-toolbar', title: 'Save the original arrangement', text: 'Save registers the clips and prepares the saved source for playback.', actionLabel: 'Save original', action: saveExample, result: savedExampleResult },
  { target: '.preview-panel', title: 'Listen to the original', text: 'Play the newsreader and Voice A before making an insertion. This stage finishes when the range ends; pausing or seeking lets you replay it.', actionLabel: 'Play original', ready: () => !previewBusy && preview.loaded, action: signal => playExample(0, sourceEnd(publishedWorkspace), signal),
    result: () => ({ target: '.preview-stage', title: 'You have played the original arrangement', text: 'The saved video and voice both started at zero. The shorter video ended first, so the remaining voice played over black. Next you can insert a complete voice clip into Voice A.' }) },
  { target: '#timeline-scroll', title: 'Interrupt Voice A with Voice B', text: 'Insert B near four seconds, at the nearest audio segment boundary. A plays to that point, B plays in full, then A resumes where it stopped. Only the audio flow shifts.', actionLabel: 'Insert Voice B', action: () => placeExample('voice-b', 4000000000n), result: () => insertionResult('audio') },
  { target: '.draft-toolbar', title: 'Save the voice insertion', text: 'Save this arrangement. The resumed part of A will reference its existing media objects at a later offset.', actionLabel: 'Save voice edit', action: saveExample, result: savedExampleResult },
  { target: '.preview-panel', title: 'Hear the interruption and resumption', text: 'Play from just before B into the resumed A. The video keeps its original timing because this edit changed only the audio flow.', actionLabel: 'Play voice edit', ready: () => !previewBusy && preview.loaded, action: signal => playExample(3, 4 + seconds(BigInt(exampleSample('voice-b').durationNs)) + 2, signal),
    result: () => ({ target: '.preview-stage', title: 'Voice A continued from its interrupted position', text: 'You played across the saved insertion: A, the complete B, then the rest of A. The video timeline stayed unchanged.' }) },
  { target: '#timeline-scroll', title: 'Insert a complete newsreader clip', text: 'Insert the ten-second newsreader at video time four seconds. The original will resume after the inserted clip. Voice timing stays unchanged.', actionLabel: 'Insert newsreader', action: () => placeExample('newsreader-offset', 4000000000n), result: () => insertionResult('video') },
  { target: '.draft-toolbar', title: 'Save the video insertion', text: 'Save the new video timeline. Both copies can reference the same stored newsreader objects.', actionLabel: 'Save video edit', action: saveExample, result: savedExampleResult },
  { target: '.preview-panel', title: 'Watch the video resume', text: 'Play across the inserted newsreader and into the resumed original.', actionLabel: 'Play video edit', ready: () => !previewBusy && preview.loaded, action: signal => playExample(3, 16, signal),
    result: () => ({ target: '.preview-stage', title: 'The original video resumed after the inserted clip', text: 'The inserted newsreader played in full, followed by the original from its interrupted position. Both parts reference the existing stored video objects.' }) },
  { target: '#storage', title: 'Inspect the resumed voice segment', text: 'Select the resumed A in Segments view to see how its stored media is mapped to the later flow time.', actionLabel: 'Inspect offset', action: async () => {
    preview.pause(); const lane = exampleLane('audio'), block = lane.blocks.find(block => block.sample.id === 'voice-a' && block.start > 0n);
    if (!block?.segments.length) throw new Error('The resumed Voice A is missing. Start a new example to repeat the insertion.');
    $('segments-tab').click(); selectedLane = lane.id; selectedBlock = block.key; selectedSegment = 0; selectedObject = block.segments[0].object_id; inspectIngest = false;
    renderTimeline(); correlateObject(); $<HTMLDetailsElement>('time-details').open = true;
  }, result: () => {
    const segment = currentItem()!.block.segments[0];
    return { target: `.segment-clip.selected, [data-object="${selectedObject}"], #time-equation`, title: 'The same media is referenced at a later time', text: `This segment uses the original voice object. Its offset of ${timestampToNumber(segment.ts_offset).toFixed(3)} seconds places that media later in the flow. Time mapping shows the exact values; the media bytes are unchanged.` };
  } },
  { target: '.range-exercise', title: 'Read media across the insertion', text: 'Query timeline seconds 3 to 16. TAMS returns the matching saved segments; Playpen reads each referenced object once.', actionLabel: 'Query time range', action: async () => {
    exampleLane('audio'); $<HTMLInputElement>('range-start').value = '3'; $<HTMLInputElement>('range-end').value = '16';
    example.query = await readRange(); if (!example.query) throw new Error($('notice-text').textContent || 'The query failed.');
  }, result: () => ({ target: '#range-result', title: 'The time range resolved to saved media', text: `${$('range-result').querySelector('p')!.textContent} Objects referenced more than once were read once.` }) },
  { target: '.api-panel', title: 'Inspect the real API request', text: 'Open the recorded range request and response used to read your saved example.', actionLabel: 'Show API request', action: async () => {
    if (!example.query) throw new Error('Query the time range before inspecting its request.');
    followRequests = false; selectedAction = example.query.id; selectedRequest = example.query.requests.findIndex(request => request.url.includes('/segments?'));
    renderRequests();
  }, result: () => ({ target: '#request-detail', title: 'This request read your saved timeline', text: 'The recorded GET request asks for segments in the chosen time range. Its response identifies the media objects and their offsets. Reviewing it does not send another request.' }) },
  { target: '#source-id button', title: 'Read the source in Terminal', text: 'Select the source ID in API activity to fill in its curl command. Press Enter in the prompt or choose Run to read the saved source.', actionLabel: '',
    result: () => ({ target: '#terminal-output', title: 'The source answered your GET', text: example.sourceRead! }) },
], { start: () => { example = { id: crypto.randomUUID(), source_id: crypto.randomUUID(), done: new Set() }; }, waiting: () => busy || libraryBusy || draftPending > 0 });

async function executeCurl(command: CurlRequest, file?: File): Promise<RequestRecord> {
  if (resetting || busy || libraryBusy) throw new Error('Wait for the current Playpen action to finish.');
  const write = !['GET', 'HEAD'].includes(command.method);
  const rootId = workspace?.root.id;
  let body: unknown = command.data;
  if (command.data !== undefined) {
    try { body = JSON.parse(command.data); } catch { /* Preserve literal data on the wire. */ }
  }
  const upload = file ? { name: file.name, bytes: file, type: command.headers['content-type'] ?? (file.type || 'application/octet-stream') } : undefined;
  const action = store.beginAction('Terminal ' + command.method);
  const send = () => store.action(action.name, a => store.request(a, command.url, command.method, body, upload, {
    headers: command.headers, rawBody: command.data,
    binary: command.method === 'GET' && new URL(command.url).pathname.startsWith(new URL('../media/', store.apiUrl).pathname),
  }), action);
  const execute = async () => {
    try {
      if (write && rootId) await store.locked(rootId, send);
      else await send();
    } catch (error) {
      if (!action.requests[0]?.error) throw error;
    }
  };
  if (write) await withBusy(async () => {
    tour.stop(false); preview.pause();
    const path = new URL(command.url).pathname;
    if ((command.method === 'PUT' && path.startsWith(new URL('../media/', store.apiUrl).pathname)) ||
        (command.method === 'POST' && /\/flows\/[^/]+\/segments$/.test(path))) {
      $<HTMLDetailsElement>('storage').open = true;
    }
    try { await execute(); }
    finally {
      try { await draftWrites; if (!resetting) await refresh(rootId, true); }
      catch (error) { notify('Could not reload the workspace: ' + (error as Error).message, true); }
    }
  });
  else await execute();
  return action.requests[0];
}

const terminal = wireTerminal({
  apiUrl: () => store?.apiUrl ?? new URL('/api/', location.href).href,
  ids: () => {
    const flows = [...sources, ...(workspace?.lanes ?? []).map(lane => lane.flow)];
    const sourceId = new Set(flows.map(flow => flow.source_id).filter(Boolean));
    const flowId = new Set(flows.map(flow => flow.id).filter(Boolean));
    const objectId = new Set(mediaObjects().map(obj => obj.id));
    for (const { requests } of store?.actions ?? []) {
      for (const record of requests) {
        if (record.flowId) flowId.add(record.flowId);
        if (record.objectId) objectId.add(record.objectId);
        for (const id of record.objectIds ?? []) objectId.add(id);
        const path = new URL(record.url).pathname;
        const resource = path.match(/\/api\/(flows|sources)\/([a-f0-9-]{36})(?:\/|$)/i);
        if (resource) (resource[1] === 'flows' ? flowId : sourceId).add(resource[2]);
        for (const data of [record.body, record.response]) {
          if (data && typeof data === 'object' && 'source_id' in data && typeof data.source_id === 'string') sourceId.add(data.source_id);
        }
      }
    }
    return { sourceId: [...sourceId], flowId: [...flowId], objectId: [...objectId] };
  },
  execute: executeCurl,
  success: record => {
    if (record.method !== 'GET' || !example || record.url !== new URL('sources/' + example.source_id, store.apiUrl).href) return;
    const source = record.response as { id?: string; label?: string } | null;
    if (source?.id !== example.source_id) return;
    example.sourceRead = `HTTP ${record.status} returned the saved source ${source.label ?? source.id}, with ID ${source.id}.`;
    tour.completeInteraction();
  },
});
const updateReview = wireReview(() => store?.actions ?? [], () => $<HTMLSelectElement>('action-history').value, terminal.fill);
renderSamples(); wire(); renderSources(); renderTimeline();
try {
  const client = await window.tasmStartup.wait((window as unknown as { tasmReady: Promise<TasmClient> }).tasmReady);
  store = new WorkspaceStore(client.apiUrl); store.addEventListener('requests', onFrame(() => { if (resetting) return; renderRequests(); if (busy && !reloadRequired) { const request = store.actions[0]?.requests.at(-1); setText($('runtime-status'), store.actions[0]?.playback ? 'Preparing preview…' : request?.method === 'PUT' && request.url.includes('/media/') && request.ms === undefined ? 'Uploading…' : 'Saving…'); } }));
  store.addEventListener('ingest', () => { const session = store.ingest!; if (session.actionId !== ingestId) { ingestId = session.actionId; inspectIngest = true; selectedObject = ''; followRequests = true; } renderIngest(); renderRequests(); renderPending(); });
  preview = new Preview(store); preview.addEventListener('time', updatePlayhead);
  preview.addEventListener('error', event => {
    $('preview-status').textContent = 'Preview could not play';
    notify(`Playback failed: ${(event as CustomEvent<string>).detail}`, true, () => void updatePreview());
  });
  window.addEventListener('tasm-reset', () => {
    if (resetting) return;
    window.tasmStartup.done();
    resetting = true; busy = true; clearTimeout(noticeTimer); $('notice').hidden = true;
    document.querySelector<HTMLElement>('.app-header')!.inert = true;
    document.querySelector<HTMLElement>('.app-layout')!.inert = true;
    controls(); importing?.abort(); draftAbort.abort(); preview.destroy();
    void store.stop();
  });
  window.addEventListener('pagehide', event => { if (!event.persisted) { void store.stop(); preview.destroy(); client.close(); } });
  // Library access also waits for the runtime lease, so a new tab cannot import during reset.
  await window.tasmStartup.wait(openLibrary(), 'Loading sample library');
  sources = await window.tasmStartup.wait(store.sources(), 'Loading saved workspace');
  const selected = sources.find(s => s.id === localStorage.getItem(dataKey)) ?? sources[0];
  if (selected) await window.tasmStartup.wait(store.recover(selected.id));
  await window.tasmStartup.wait(refresh(selected?.id));
  if (!resetting) {
    busy = false; controls(); $('runtime-status').textContent = 'Browser store ready'; document.body.dataset.ready = 'true';
    $<HTMLButtonElement>('terminal-run').disabled = false;
    window.tasmStartup.done(); tour.showWelcome();
  }
} catch (error) {
  if (!resetting) { window.tasmStartup.fail(error); void store?.stop(); preview?.destroy(); }
  const visualPreview = !isSecureContext && location.pathname.endsWith('/preview.html');
  $('runtime-status').textContent = visualPreview ? 'Visual preview' : 'Storage unavailable';
  $('preview-limitation').hidden = !visualPreview;
  if (visualPreview) { $('startup-notice').hidden = true; tour.showWelcome(); }
  $('sources').innerHTML = '<option value="">Storage unavailable</option>';
  controls();
}
