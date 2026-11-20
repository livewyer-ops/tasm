import { onFrame, setText } from '../shared/render';
import { startTasm } from '../../core/browser/index';
import type { TasmClient } from '../../core/browser/public.d.ts';
import { WorkspaceStore, RequestError, samples, bounds, seconds, type Workspace, type ActionRecord, type RequestRecord, type Flow, type Lane, type Segment } from '../shared/workspace-store';
import { Preview, sourceEnd } from '../shared/player';
import { ChromingTheme } from '@byomakase/omakase-player';
import type {} from '../shared/startup';
import { createResultTips, type ResultTip } from './result-tips';

const $ = (id: string) => document.getElementById(id)!;
const sample = samples.find(s => s.id === 'orbit')!;
const duration = seconds(BigInt(sample.durationNs));
const fmt = (value: number) => Number(value.toFixed(2)) + ' s';
let client: TasmClient | undefined, store: WorkspaceStore, preview: Preview | undefined, workspace: Workspace | undefined;
let step = 1, busy = false, ready = false, resetting = false, selectedObject = '', selectedAction = '', preset = 'whole';
let nextStep = 1, played = false, introPlaying = false, deleted = false;
const queried = new Set<number>();
const titles = ['Create a source', 'Add a video flow', 'Store the sample media', 'Play a time range', 'Find the available video flows', 'Inspect the flow’s segments', 'Create a four-second excerpt', 'Delete the original flow'];
const deletedText = 'The original flow has been deleted. The four-second excerpt is still playable using the same two media objects. Two unused media objects were removed from storage.';
let retry: (() => void) | undefined;
let rangePendingOrFailed = false;
let rangeResult: Awaited<ReturnType<WorkspaceStore['readRange']>> | undefined;
let selectedFlow = '';
let description: { title: string; text?: string; query?: ActionRecord } | undefined;
interface Deletion { flowId: string; requestId?: string; accepted: boolean; objects: Segment[] }
interface DeleteRequest { id: string; flow_id: string; status: string; error?: unknown }
let deletion: Deletion | undefined;
const flowTemplate = $('flow').cloneNode(true) as HTMLElement;
const outcomes = new Map<string, string>();
const storageChecks = new Map<string, { state: string; bytes?: number }>();
let checkingStorage = false;
const videoLanes = () => workspace?.lanes.filter(l => l.kind === 'video' && !(deletion?.accepted && deletion.flowId === l.flow.id)) ?? [];
const lane = () => videoLanes().find(l => l.flow.id === selectedFlow) ?? videoLanes()[0];
const excerpt = () => videoLanes().find(l => l.flow.tags?.['tasm.demo.role']?.[0] === 'excerpt');
const original = () => videoLanes().find(l => l.flow.tags?.['tasm.demo.role']?.[0] !== 'excerpt' && l.segments.length === 4);
const playbackWorkspace = () => workspace && { ...workspace, lanes: videoLanes() };
const ingest = () => store?.ingest?.laneId === lane()?.id ? store?.ingest : undefined;
const segments = () => lane()?.segments ?? [];
const prepared = () => segments().length > 0;
const visibleSegments = () => ingest()?.block?.segments ?? segments();
const published = () => ingest()?.block ? ingest()!.published : prepared();
const interval = (): [number, number] => {
  const end = sourceEnd(playbackWorkspace());
  return preset === 'first' ? [0, Math.min(2, end)] : preset === 'last' ? [Math.max(0, end - 2), end] : [0, end];
};
function status(message: string) { if (!resetting) $('status').textContent = message; }
const resultTips = createResultTips(() => render());
let recoveringDeletion = false;
const backgroundAction = (action: ActionRecord) => action.playback || ['Read preview media', 'Verify stored media'].includes(action.name);
function mediaObjects() {
  return [...new Map([...visibleSegments(), ...(deletion?.accepted ? deletion.objects : []), ...videoLanes().flatMap(l => l.segments)].map(s => [s.object_id, s])).values()];
}
function objectLabels() {
  const ids = mediaObjects().map(s => s.object_id);
  return new Map(ids.map(id => {
    let length = 6;
    while (length < id.length && ids.some(other => other !== id && other.slice(-length) === id.slice(-length))) length += 2;
    return [id, id.slice(-length)];
  }));
}
function selectObject(id: string, activate = true) {
  selectedObject = id; $('copy-status').textContent = '';
  const action = store.actions.find(a => !backgroundAction(a) && a.requests.some(r => requestObject(r) === id));
  if (activate && action) activateAction(action.id);
  renderTimeline(); renderRequests();
}
function renderStorage() {
  if (resetting) return;
  const objects = mediaObjects(), labels = objectLabels();
  let count = 0, bytes = 0;
  $('storage').setAttribute('aria-busy', String(checkingStorage));
  ($('storage-refresh') as HTMLButtonElement).disabled = busy || checkingStorage || !objects.length;
  $('storage-table').hidden = !objects.length;
  for (const row of $('storage-objects').querySelectorAll<HTMLTableRowElement>('tr')) {
    if (!objects.some(s => s.object_id === row.dataset.object)) row.remove();
  }
  for (const segment of objects) {
    const id = segment.object_id, object = store.ingest?.objects.find(o => o.segment.object_id === id);
    const upload = store.actions.flatMap(a => a.requests).find(r => r.objectId === id && r.stage === 'upload');
    const check = storageChecks.get(id);
    const state = deletion?.accepted && deletion.objects.some(s => s.object_id === id) ? 'deleting' : check?.state ?? (upload?.error ? 'failed' : upload && upload.ms === undefined ? 'uploading'
      : object && !object.reused && ['uploaded', 'registered'].includes(object.state) ? 'stored'
      : object && !object.reused ? 'waiting' : 'unchecked');
    const size = check?.bytes ?? (state === 'stored' && object && !object.reused ? object.bytes : undefined);
    if (state === 'stored') { count++; bytes += size ?? 0; }
    let row = $('storage-objects').querySelector<HTMLTableRowElement>('[data-object="' + CSS.escape(id) + '"]');
    if (!row) {
      row = document.createElement('tr'); row.dataset.object = id;
      row.innerHTML = '<td><button></button></td><td></td><td></td><td></td>';
      row.onclick = () => selectObject(id);
      $('storage-objects').append(row);
    }
    row.dataset.state = state; row.classList.toggle('selected', selectedObject === id);
    const button = row.querySelector('button')!;
    button.textContent = labels.get(id)!; button.title = id;
    button.setAttribute('aria-label', 'Inspect object ' + labels.get(id));
    button.setAttribute('aria-pressed', String(selectedObject === id));
    row.cells[1].textContent = [...new Set([...videoLanes().flatMap(l => l.segments.flatMap((s, i) => s.object_id === id ? [i + 1] : [])),
      ...visibleSegments().flatMap((s, i) => s.object_id === id ? [i + 1] : [])])].join(', ');
    row.cells[2].textContent = size === undefined ? '—' : size.toLocaleString() + ' B';
    row.cells[3].textContent = ({ stored: 'Stored', missing: 'Missing', unknown: 'Not confirmed', unchecked: 'Not checked',
      uploading: 'Uploading', waiting: 'Waiting', failed: 'Upload failed', deleting: 'Deletion requested' } as Record<string, string>)[state];
  }
  $('storage-summary').textContent = objects.length ? count + ' of ' + objects.length + ' objects stored · ' + bytes.toLocaleString() + ' bytes' : 'No objects stored yet.';
  $('storage-note').textContent = !objects.length ? '' : checkingStorage ? 'Checking storage...'
    : 'Match these object IDs to the timeline to see which stored media each segment uses.';
  resultTips.refresh();
}
async function verifyStorage() {
  const objects = mediaObjects();
  if (resetting || checkingStorage || !objects.length) return;
  checkingStorage = true; renderStorage();
  try {
    await store.action('Verify stored media', async action => {
      for (const segment of objects) {
        const id = segment.object_id;
        const url = segment.get_urls?.[0]?.url ?? store.actions.flatMap(a => a.requests).find(r => r.objectId === id && r.stage === 'upload')?.url;
        if (!url) { storageChecks.set(id, { state: 'unknown' }); continue; }
        try {
          const { record } = await store.requestWithRecord(action, url, 'HEAD', undefined, undefined, { objectId: id, signal: AbortSignal.timeout(30000) });
          const length = record.responseHeaders?.['content-length'];
          const bytes = length && /^\d+$/.test(length) ? Number(length) : NaN;
          storageChecks.set(id, Number.isSafeInteger(bytes) ? { state: 'stored', bytes } : { state: 'unknown' });
        } catch (error) {
          storageChecks.set(id, { state: error instanceof RequestError && error.record.status === 404 ? 'missing' : 'unknown' });
        }
        renderStorage();
      }
    });
  } finally { checkingStorage = false; renderStorage(); renderRequests(); }
}
function render() {
  if (resetting) return;
  document.querySelector('.walkthrough')!.setAttribute('aria-busy', String(busy));
  const completed = [!!workspace, !!lane(), prepared(), played, queried.has(5), queried.has(6), !!excerpt(), deleted];
  const available = [true, !!workspace, !!lane(), prepared(), !!workspace, !!lane(), !!original() || !!excerpt(), !!deletion || deleted || !!(original() && excerpt())];
  document.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => {
    const value = Number(button.dataset.step);
    if (value === step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    button.classList.toggle('complete', !!completed[value - 1]);
    button.querySelector('span')!.textContent = value < 5 && completed[value - 1] ? '✓' : String(value);
    button.disabled = busy || !ready || !available[value - 1];
  });
  $('step-label').textContent = 'Step ' + step + ' of 8';
  renderDescription();
  const label = nextStep === 1 ? workspace ? 'Use saved source' : titles[0]
    : nextStep === 2 ? lane() ? 'Use saved flow' : titles[1]
    : nextStep === 3 ? prepared() ? 'Use saved media' : titles[2]
    : nextStep === 9 ? 'Restart walkthrough' : titles[nextStep - 1];
  $('primary').textContent = introPlaying ? 'Playing section...' : (nextStep > step && nextStep < 9 ? 'Next: ' : '') + label;
  ($('primary') as HTMLButtonElement).disabled = busy || !ready || introPlaying || (nextStep < 9 && !available[nextStep - 1]);
  $('primary').classList.toggle('start-hint', ready && !busy && nextStep === 1 && !workspace);
  ($('restart') as HTMLButtonElement).disabled = busy || !ready;
  ($('retry') as HTMLButtonElement).disabled = busy;
  $('range-result').hidden = !rangeResult && !rangePendingOrFailed;
  $('playback-controls').hidden = !ready || !prepared();
  ($('pause') as HTMLButtonElement).disabled = busy || !preview?.loaded;
  ($('replay') as HTMLButtonElement).disabled = busy || !played || !prepared();
  $('poster').hidden = !!preview?.loaded;
  ($('range-select') as HTMLSelectElement).disabled = busy || !prepared();
  ($('range-select') as HTMLSelectElement).value = preset;
  renderTimeline();
}
function renderDescription() {
  $('step-title').textContent = 'Step ' + step + '. ' + (description?.title ?? titles[step - 1]);
  $('explanation').textContent = description ? description.text ?? '' : [
    'Start by creating a source for this sample video. A source identifies a piece of content, such as a recording. Its flows describe the media available for that content.',
    'Add a video flow for the sample. A flow represents the content with a particular media format and timeline. For example, a recording could have separate flows for its full-quality video and a lower-resolution proxy.',
    'Store the 6.4-second sample as four media objects. Each object holds a short piece of video. A segment records which object to use and where it belongs on the flow’s timeline. Watch the timeline and storage table fill as the media becomes ready to play.',
    'Choose a time range and play it. TAMS finds the segments covering that range and the player reads their media objects. An object can extend beyond the requested range; playback uses only the section you chose.',
    'Ask TAMS which video flows are available for this example. Applications use this to find the media they can work with. Run the request to see the flow records returned by the API.',
    'Inspect the segments in the selected flow. Each record links a time range to a stored media object. Match the object IDs in the response to the timeline and storage table.',
    'Create a new flow for the first four seconds of the sample. It references the first two stored media objects, so no media needs to be copied or uploaded. Compare the object IDs in both timelines.',
    deleted ? deletedText : 'Delete the original flow and keep the excerpt. The excerpt still references the first two media objects, so those stay available. The other two objects are removed after background cleanup confirms they are no longer used.',
  ][step - 1];
  $('tams-reference').hidden = !!description || step > 3;
  ($('tams-reference') as HTMLAnchorElement).hash = step === 1 ? 'sources' : 'design';
  $('description').hidden = !!description?.query;
  $('api-result').hidden = !description?.query;
  if (description?.query) $('api-result').textContent = description.query.requests.filter(r => r.stage === 'query')
    .map(r => `${r.method} ${r.url}\n${r.status === undefined ? 'Waiting for response...' : 'HTTP ' + r.status}\n${JSON.stringify(r.response, null, 2) ?? ''}${r.error ? '\n' + r.error : ''}`).join('\n\n');
}
function showStep(value: number) {
  step = value; nextStep = value === 8 && deleted ? 9 : value;
  description = undefined; render(); $('step-title').focus({ preventScroll: true });
}
function updatePlayhead() {
  const time = Math.max(0, Math.min(duration, preview?.currentTime ?? 0));
  for (const row of document.querySelectorAll<HTMLElement>('.flow-row')) {
    const active = row.dataset.flow === lane()?.flow.id;
    const head = row.querySelector<HTMLElement>('.playhead')!;
    head.hidden = !active || !preview?.loaded;
    head.style.left = Math.min(100, time / duration * 100) + '%';
    row.querySelector('.playhead-time')!.textContent = active ? 'Playback ' + fmt(time) : '';
  }
}
async function selectFlow(value: Lane) {
  resultTips.clear();
  selectedFlow = value.flow.id; rangeResult = undefined; rangePendingOrFailed = false;
  preview!.pause(); preview!.select(playbackWorkspace()!, 'video', value.id);
  if (preview!.loaded) await preview!.update(playbackWorkspace());
  render();
}
function renderFlow(row: HTMLElement, value: Lane) {
  const find = <T extends HTMLElement>(selector: string) => row.querySelector<T>(selector)!;
  const heading = find('.flow-label'), isExcerpt = value.flow.tags?.['tasm.demo.role']?.[0] === 'excerpt';
  heading.textContent = isExcerpt ? 'Four-second excerpt' : 'Original video';
  heading.hidden = !isExcerpt && videoLanes().length < 2;
  heading.title = 'Flow ' + value.flow.id;
  const session = store?.ingest?.laneId === value.id ? store.ingest : undefined;
  const displayed = session?.block?.segments ?? value.segments, isPublished = session?.block ? session.published : value.segments.length > 0, labels = objectLabels();
  find('.timeline-state').textContent = isPublished ? displayed.length + ' segments · ready to play'
    : session?.status === 'failed' ? 'Interrupted · not ready to play'
    : displayed.length ? 'Preparing segments · not playable yet' : session?.status === 'running' ? 'Preparing segments...' : 'Empty flow';
  find('.track-empty').hidden = displayed.length > 0;
  for (const button of find('.pieces').querySelectorAll<HTMLButtonElement>('button')) {
    if (!displayed[Number(button.dataset.piece)]) button.remove();
  }
  displayed.forEach((segment, i) => {
    let button = find('.pieces').querySelector<HTMLButtonElement>('[data-piece="' + i + '"]');
    if (!button) {
      button = document.createElement('button');
      button.innerHTML = '<span></span><small class="object-label"></small>';
      find('.pieces').append(button);
    }
    button.onclick = () => {
      selectObject(segment.object_id);
      if (matchMedia('(min-width:761px)').matches) $('requests').querySelector('.action[open] .related')?.scrollIntoView({ block: 'nearest' });
      // Inspect provisional segments without interrupting the ingest or claiming they can play.
      if (busy || !isPublished) return;
      resultTips.clear();
      void perform('Open segment', async () => {
        if (lane()?.flow.id !== value.flow.id) await selectFlow(value);
        if (!preview!.loaded) await preview!.update(playbackWorkspace());
        preview!.pause(); await preview!.seek(bounds(segment.timerange).map(seconds)[0]);
        status('Segment ' + (i + 1) + ' selected.');
      });
    };
    const [start, end] = bounds(segment.timerange).map(seconds);
    const object = session?.objects.find(o => o.segment.object_id === segment.object_id);
    const state = isPublished ? 'published' : object?.state ?? 'prepared';
    button.dataset.piece = String(i); button.dataset.state = state; button.dataset.object = segment.object_id;
    button.querySelector('span')!.textContent = String(i + 1);
    button.querySelector('small')!.textContent = labels.get(segment.object_id)!;
    button.style.left = start / duration * 100 + '%'; button.style.width = (end - start) / duration * 100 + '%';
    button.setAttribute('aria-label', 'Segment ' + (i + 1) + ', ' + fmt(start) + ' to ' + fmt(end) + ', ' + state + ', object ' + labels.get(segment.object_id));
    button.title = button.getAttribute('aria-label')!;
    button.setAttribute('aria-pressed', String(segment.object_id === selectedObject));
    button.classList.toggle('matched', !!rangeResult?.segments.some(s => s.object_id === segment.object_id));
  });
  const outline = find('.requested-range');
  outline.hidden = !rangeResult || value.flow.id !== lane()?.flow.id;
  if (rangeResult) {
    const [start, end] = interval();
    outline.style.left = start / duration * 100 + '%'; outline.style.width = (end - start) / duration * 100 + '%';
    outline.setAttribute('aria-label', 'Requested range ' + fmt(start) + ' to ' + fmt(end));
  }
}
function renderTimeline() {
  if (resetting) return;
  const lanes = videoLanes();
  $('source-empty').hidden = !!workspace;
  $('source-state').textContent = workspace ? lanes.length + ' video flow' + (lanes.length === 1 ? '' : 's') : '';
  document.querySelector<HTMLElement>('.source-heading')!.title = workspace ? 'Source ' + workspace.root.source_id + ' · Collection flow ' + workspace.root.id : '';
  $('flow-empty').hidden = !!lane(); $('flow-empty').textContent = workspace ? 'No video flow yet.' : '';
  $('flow').hidden = !lanes.length;
  for (const row of $('flows').querySelectorAll<HTMLElement>('.flow-row:not(#flow)')) {
    if (!lanes.slice(1).some(l => l.flow.id === row.dataset.flow)) row.remove();
  }
  lanes.forEach((value, i) => {
    let row = i === 0 ? $('flow') : $('flows').querySelector<HTMLElement>('[data-flow="' + value.flow.id + '"]');
    if (!row) {
      row = flowTemplate.cloneNode(true) as HTMLElement; row.removeAttribute('id');
      row.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      $('flows').append(row);
    }
    row.hidden = false; row.dataset.flow = value.flow.id; renderFlow(row, value);
  });
  const session = ingest(), displayed = visibleSegments(), isPublished = published();
  const selected = displayed.find(s => s.object_id === selectedObject);
  $('object-details').hidden = !selected;
  if (selected) {
    $('full-object-id').textContent = selected.object_id;
    const [start, end] = bounds(selected.timerange).map(seconds), index = displayed.indexOf(selected);
    const object = session?.objects.find(o => o.segment.object_id === selected.object_id);
    $('piece-description').textContent = 'Segment ' + (index + 1) + ': ' + fmt(start) + ' to ' + fmt(end) + '.'
      + (isPublished ? '' : ' State: ' + (object?.state ?? 'prepared') + '. Not ready to play yet.');
    $('object-detail').textContent = JSON.stringify({ source_id: workspace?.root.source_id, collection_flow_id: workspace?.root.id,
      published_video_flow_id: lane()?.flow.id, state: isPublished ? 'published' : object?.state,
      ...(object ? { bytes: object.bytes, reused: object.reused } : {}), segment: segments().find(s => s.object_id === selected.object_id) ?? selected }, null, 2);
  } else $('piece-description').textContent = displayed.length
    ? isPublished ? 'Select a segment to see the media object it uses.'
      : 'Playback becomes available once the media is stored and the completed flow is ready.'
    : '';
  updatePlayhead();
  renderStorage();
}
function requestObject(record: RequestRecord) {
  return record.objectId ?? mediaObjects().find(s => s.get_urls?.some(u => new URL(u.url, store.apiUrl).href === record.url))?.object_id;
}
function requestLabel(record: RequestRecord) {
  const url = new URL(record.url);
  const index = visibleSegments().findIndex(s => s.object_id === requestObject(record));
  const object = index < 0 ? 'object' : 'object for segment ' + (index + 1);
  if (record.stage === 'allocate') return 'Allocate storage for ' + object;
  if (record.stage === 'upload') return 'Store ' + object;
  if (record.stage === 'register') return 'Register segment' + (index < 0 ? '' : ' ' + (index + 1));
  if (record.stage === 'query') return url.searchParams.has('collected_by_ids') ? 'Find the available video flows'
    : url.searchParams.has('timerange') ? 'Find segments covering the selected range' : 'Inspect the flow’s segments';
  if (record.stage === 'read') return 'Read ' + object;
  if (record.method === 'HEAD') return 'Check stored ' + object;
  const path = url.pathname;
  if (record.method === 'DELETE') return 'Retire previous flow';
  if (path.endsWith('/flow_collection')) return record.method === 'GET' ? 'Read collection' : record.stage === 'update' ? 'Publish completed timeline' : 'Link video flow to the source collection';
  if (record.method === 'PUT' && record.body && typeof record.body === 'object' && 'format' in record.body) {
    const body = record.body as { format: string };
    return body.format.endsWith(':multi') ? 'Create source collection' : record.stage === 'segment' ? 'Prepare replacement video flow' : 'Create empty video flow';
  }
  if (record.method === 'GET') return path.includes('/media/') ? 'Read preview object' : path.endsWith('/segments') ? 'Read stored segments' : 'Read saved source and flows';
  return record.method + ' ' + path;
}
function activateAction(id: string) {
  selectedAction = id;
  document.querySelectorAll<HTMLDetailsElement>('.action').forEach(item => item.open = item.dataset.action === id);
}
function renderRequests() {
  if (resetting || !store) return;
  renderDescription();
  const actions = store.actions;
  $('background-count').textContent = '(' + actions.filter(backgroundAction).length + ')';
  for (const action of [...actions].reverse()) {
    const background = backgroundAction(action);
    const container = $(background ? 'background-requests' : 'requests');
    let item = container.querySelector<HTMLDetailsElement>('[data-action="' + action.id + '"]');
    if (!item) {
      container.querySelector(':scope > .muted')?.remove();
      item = document.createElement('details'); item.className = 'action'; item.dataset.action = action.id;
      item.innerHTML = '<summary></summary><p class="action-outcome"></p><p class="preparation" hidden></p><ol class="operations"></ol><details class="supporting" hidden><summary></summary><ol class="operations"></ol></details>';
      item.open = action.id === selectedAction; container.prepend(item);
    }
    setText(item.querySelector(':scope > summary')!, action.name + (action.pending ? ' · Working' : action.error ? ' · Failed' : ' · Done'));
    const outcome = item.querySelector<HTMLElement>('.action-outcome')!;
    outcome.textContent = outcomes.get(action.id) ?? (action.error ? 'Retry to continue.' : '');
    outcome.hidden = !outcome.textContent;
    const session = store.ingest?.actionId === action.id ? store.ingest : undefined;
    const preparation = item.querySelector<HTMLElement>('.preparation')!;
    preparation.hidden = !session;
    if (session) preparation.textContent = session.completed.has('segment') ? 'Done · Prepare ' + session.objects.length + ' segments'
      : session.status === 'failed' ? 'Failed · Prepare segments' : 'Working · Prepare segments';
    const supporting = item.querySelector<HTMLDetailsElement>('.supporting')!;
    const operations = item.querySelector<HTMLOListElement>(':scope > ol')!;
    const following = operations.scrollTop + operations.clientHeight >= operations.scrollHeight - 8;
    let supportCount = 0;
    let addedOperation = false;
    action.requests.forEach((record, i) => {
      const support = !background && action.name !== 'Delete the original flow' && (record.method === 'DELETE' || (record.method === 'GET' && !record.stage));
      if (support) supportCount++;
      let row = item!.querySelector<HTMLLIElement>('[data-request="' + i + '"]');
      if (!row) {
        row = document.createElement('li'); row.dataset.request = String(i);
        row.innerHTML = '<details><summary></summary><pre></pre></details>';
        row.querySelector('summary')!.addEventListener('click', () => {
          const id = requestObject(record);
          if (id) selectObject(id, false);
        });
        (support ? supporting.querySelector('ol')! : item!.querySelector(':scope > ol')!).append(row);
        if (!support) addedOperation = true;
      }
      const state = record.error ? 'failed' : record.ms === undefined ? 'working' : 'done';
      row.dataset.state = state; row.dataset.object = requestObject(record) ?? '';
      row.classList.toggle('related', !!selectedObject && requestObject(record) === selectedObject);
      setText(row.querySelector('summary')!, (state === 'working' ? 'Working' : state === 'failed' ? 'Failed' : 'Done') + ' · ' + requestLabel(record));
      setText(row.querySelector('pre')!, JSON.stringify(record, null, 2));
    });
    supporting.hidden = supportCount === 0;
    supporting.querySelector('summary')!.textContent = 'Supporting reads and cleanup (' + supportCount + ')';
    if (addedOperation && following && action.pending && action.id === selectedAction && !operations.querySelector('details[open]')) operations.scrollTop = operations.scrollHeight;
  }
  document.querySelectorAll<HTMLElement>('.action').forEach(item => {
    if (!actions.some(a => a.id === item.dataset.action)) item.remove();
  });
  for (const id of outcomes.keys()) if (!actions.some(a => a.id === id)) outcomes.delete(id);
}
async function action(name: string, work: (record: ActionRecord) => Promise<string>) {
  return store.action(name, async record => {
    activateAction(record.id); renderRequests();
    const outcome = await work(record); outcomes.set(record.id, outcome); return outcome;
  });
}
async function perform(label: string, work: () => Promise<void>) {
  if (busy || resetting) return;
  busy = true; retry = undefined; $('error').hidden = true; status(label + '...'); render();
  try { await work(); }
  catch (error) {
    if (resetting) return;
    $('error-message').textContent = label + ' failed. Retry to continue.';
    $('error-detail').textContent = error instanceof Error ? error.message : String(error);
    $('error').hidden = false; status('');
    if (rangePendingOrFailed && !rangeResult) $('range-result').textContent = 'The section could not be read. Retry to continue.';
    retry = window.tasmStartup.signal.aborted ? () => location.reload() : () => void perform(label, work);
  } finally { busy = false; render(); renderRequests(); }
}
async function buildStep(value: number) {
  let saved = false;
  const name = $('primary').textContent!;
  const outcome = await navigator.locks.request('tasm-demo:' + store.apiUrl, () => action(name, async record => {
    let root = (await store.sources(record))[0];
    const existingRoot = !!root;
    if (value === 1) saved = existingRoot;
    if (!root) {
      if (value !== 1) throw new Error('Create the source first.');
      root = await store.createSource(record, 'Orbit demonstration');
    }
    workspace = await store.load(root.id, record); render();
    if (value === 1) return existingRoot ? 'Using the saved source for this sample.' : 'Source created. Next, add its video flow.';
    const existingLane = !!lane();
    if (value === 2) saved = existingLane;
    if (!existingLane) {
      if (value !== 2) throw new Error('Add a video flow first.');
      await store.addLane(record, root.id, 'video', 'Orbit video');
      workspace = await store.load(root.id, record); render();
    }
    if (value === 2) return existingLane ? 'Using saved video flow.' : 'Video flow created. Next, store the sample media on its timeline.';
    await store.recover(root.id, record);
    const reused = prepared(); saved = reused;
    if (!reused) await store.edit(record, root.id, { laneId: lane()!.id, sample, start: 0n });
    workspace = await store.load(root.id, record); render();
    return reused ? 'Using stored media.' : segments().length + ' segments stored and ready to play.';
  })).catch(async error => {
    // The storage action records its own error. Keep the step failure available for Retry.
    if (value === 3) await verifyStorage().catch(() => {});
    throw error;
  });
  if (value === 3) await verifyStorage();
  if (resetting) return;
  if (value === 3) { status('Preparing playback...'); await preview!.update(playbackWorkspace()); }
  nextStep = value + 1;
  if (!showResult(value, saved)) showStep(nextStep);
  status(outcome);
}
async function readSection() {
  preview!.pause(); rangeResult = undefined; rangePendingOrFailed = true; render();
  $('range-result').textContent = 'Reading selected range...';
  const [start, end] = interval();
  const outcome = await action('Read selected section', async record => {
    rangeResult = await store.readRange(record, playbackWorkspace()!, preview!.choices(playbackWorkspace()), BigInt(Math.round(start * 1e9)), BigInt(Math.round(end * 1e9)));
    return fmt(start) + ' to ' + fmt(end) + ' · ' + rangeResult.objects + ' stored ' + (rangeResult.objects === 1 ? 'object read' : 'objects read') + ' (' + rangeResult.bytes.toLocaleString() + ' bytes).';
  });
  rangePendingOrFailed = false;
  $('range-result').textContent = outcome + ' Outline: selected range. Shading: objects read.';
  renderTimeline(); status('Selected range ready.');
}
async function listDetails(kind: 'flows' | 'segments') {
  let items: (Flow | Segment)[] = [];
  const title = kind === 'flows' ? titles[4] : titles[5];
  const outcome = await action(title, async record => {
    description = { title, query: record }; renderDescription();
    const path = kind === 'flows' ? `flows?collected_by_ids=${workspace!.root.id}` : `flows/${lane()!.flow.id}/segments`;
    items = await store.list<Flow | Segment>(record, path, { stage: 'query' });
    return kind === 'flows'
      ? `${items.length} video flow${items.length === 1 ? '' : 's'} found for this example. Each record describes an available video representation.`
      : `${items.length} segment${items.length === 1 ? '' : 's'} found in this flow. Match their object IDs to the stored media below.`;
  });
  status(outcome); return items;
}
async function createExcerpt() {
  description = { title: 'Create a four-second excerpt', text: 'Create a new flow for the first four seconds of the sample. It references the first two stored media objects, so no media needs to be copied or uploaded. Compare the object IDs in both timelines.' };
  await action(description.title, record => store.locked(workspace!.root.id, async () => {
    workspace = await store.load(workspace!.root.id, record);
    if (excerpt()) return 'Using the saved four-second excerpt.';
    const previous = original();
    if (!previous) throw new Error('Add the original four segments first.');
    const parts = previous.segments.slice(0, 2);
    const staged = await store.list<Flow>(record, `flows?tag.tasm.playpen.root=${workspace.root.id}&tag.tasm.demo.role=excerpt&limit=100`);
    if (staged.length > 1) throw new Error('The demo has multiple unfinished excerpts. Reload before continuing.');
    const flow: Flow = staged[0] ?? { ...sample.technical, id: crypto.randomUUID(), source_id: previous.flow.source_id, label: 'Orbit excerpt', tags: {
      'tasm.playpen.root': [workspace.root.id], 'tasm.playpen.lane': [crypto.randomUUID()], 'tasm.demo.role': ['excerpt'],
      'tasm.playpen.blocks.v1': [JSON.stringify({ id: crypto.randomUUID(), sample: sample.id, checksum: sample.sha256,
        profile: previous.blocks[0].profile, partial: true, segments: parts.map(({ object_id, timerange }) => ({ object_id, timerange })) })],
    } };
    if (!staged.length) await store.request(record, `flows/${flow.id}`, 'PUT', flow, undefined, { stage: 'segment', flowId: flow.id });
    const registered = await store.list<Segment>(record, `flows/${flow.id}/segments`);
    if (registered.some(s => !parts.some(p => p.object_id === s.object_id && p.timerange === s.timerange))) throw new Error('The unfinished excerpt has changed. Reload before continuing.');
    for (const { object_id, timerange, ts_offset } of parts) {
      if (!registered.some(s => s.object_id === object_id && s.timerange === timerange)) {
        await store.request(record, `flows/${flow.id}/segments`, 'POST', { object_id, timerange, ts_offset }, undefined, { stage: 'register', flowId: flow.id, objectId: object_id });
      }
    }
    const collection = [...workspace.root.flow_collection ?? [], { id: flow.id, role: 'video' }];
    try { await store.request(record, `flows/${workspace.root.id}/flow_collection`, 'PUT', collection, undefined, { stage: 'update' }); }
    catch (error) {
      const root = await store.request<Flow>(record, `flows/${workspace.root.id}`);
      if (!root.flow_collection?.some(m => m.id === flow.id)) throw error;
    }
    workspace = await store.load(workspace.root.id, record); render();
    return 'The original and excerpt flows share the first two media objects. There are still only four objects in storage.';
  }));
  status('Four-second excerpt created. It uses the same two media objects as the original.');
}
function saveDeletion() {
  const key = `tasm-preview:${workspace!.root.id}`;
  let preferences: Record<string, unknown> = {};
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) preferences = saved;
  } catch { /* replace malformed preferences */ }
  if (deletion) preferences.demoDeletion = deletion; else delete preferences.demoDeletion;
  try { localStorage.setItem(key, JSON.stringify(preferences)); }
  catch { if (deletion && !deletion.accepted) { deletion = undefined; throw new Error('Allow local storage to save deletion progress, then retry.'); } }
}
async function deletePrevious() {
  description = { title: 'Delete the original flow', text: 'Delete the original flow and keep the excerpt. The excerpt still references the first two media objects, so those stay available. The other two objects are removed after background cleanup confirms they are no longer used.' };
  await action(description.title, record => store.locked(workspace!.root.id, async () => {
    workspace = await store.load(workspace!.root.id, record, deletion?.accepted ? deletion.flowId : undefined);
    if (!deletion) {
      const previous = original(), kept = excerpt();
      if (!previous || !kept || kept.segments.length !== 2 || !previous.segments.slice(0, 2).every((s, i) => s.object_id === kept.segments[i].object_id && s.timerange === kept.segments[i].timerange)) {
        throw new Error('Create the four-second excerpt before deleting the original flow.');
      }
      const retained = new Set(workspace.lanes.filter(l => l.flow.id !== previous.flow.id).flatMap(l => l.segments.map(s => s.object_id)));
      deletion = { flowId: previous.flow.id, accepted: false, objects: previous.segments.filter(s => !retained.has(s.object_id)) };
      // Keep the object identities before requesting deletion so a lost response or reload can be reconciled.
      saveDeletion();
    }
    if (!deletion.requestId) {
      const existing = (await store.list<DeleteRequest>(record, 'flow-delete-requests?limit=100')).find(r => r.flow_id === deletion!.flowId);
      if (existing) deletion.requestId = existing.id;
      else if (workspace.lanes.some(l => l.flow.id === deletion!.flowId)) {
        const previous = workspace.lanes.find(l => l.flow.id === deletion!.flowId)!, kept = excerpt();
        if (!kept || kept.segments.length !== 2 || !previous.segments.slice(0, 2).every((s, i) => s.object_id === kept.segments[i].object_id && s.timerange === kept.segments[i].timerange)) {
          throw new Error('The excerpt changed. Reload before requesting deletion.');
        }
        const { value: response, record: deletionRecord } = await store.requestWithRecord<DeleteRequest | null>(record, `flows/${deletion.flowId}`, 'DELETE', undefined, undefined, { stage: 'update', flowId: deletion.flowId });
        const location = deletionRecord.responseHeaders?.location;
        deletion.requestId = location?.match(/\/flow-delete-requests\/([^/?#]+)$/)?.[1] ?? response?.id;
      }
    }
    deletion.accepted = true; saveDeletion(); rangeResult = undefined; rangePendingOrFailed = false;
    const kept = excerpt();
    if (!kept) throw new Error('The excerpt is unavailable. Reload to check the saved flows.');
    selectedFlow = kept.flow.id; render();
    await selectFlow(kept);
    const deadline = Date.now() + 60000;
    let removed = false;
    while (Date.now() < deadline) {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const job = deletion.requestId ? await store.request<DeleteRequest>(record, `flow-delete-requests/${deletion.requestId}`, 'GET', undefined, undefined, { signal }) : undefined;
      if (job?.status === 'failed') throw new Error('Background deletion failed: ' + JSON.stringify(job.error));
      if (!job || job.status === 'done') {
        let missing = 0;
        for (const object of deletion.objects) {
          const url = object.get_urls?.[0]?.url;
          if (!url) throw new Error('The deleted object has no storage URL to verify.');
          try { await store.request(record, url, 'HEAD', undefined, undefined, { objectId: object.object_id, signal }); }
          catch (error) {
            if (!(error instanceof RequestError) || error.record.status !== 404) throw error;
            delete error.record.error; missing++;
          }
        }
        if (missing === deletion.objects.length) { removed = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!removed) throw new Error('Deletion is still pending. Retry to check progress; the unused objects remain listed.');
    for (const object of deletion.objects) storageChecks.delete(object.object_id);
    deletion = undefined; saveDeletion(); workspace = await store.load(workspace.root.id, record);
    await verifyStorage(); render();
    deleted = true; description!.text = deletedText;
    return 'The original flow is deleted. The excerpt keeps its two media objects; two unused objects were removed.';
  }));
  status('Original flow deleted. The four-second excerpt and its two media objects remain available.');
}
async function boot() {
  resultTips.restart();
  ready = false; preview?.destroy(); client?.close(); preview = undefined; workspace = undefined;
  step = nextStep = 1; played = introPlaying = deleted = false; queried.clear();
  selectedObject = ''; selectedAction = ''; selectedFlow = ''; description = undefined; deletion = undefined; rangeResult = undefined; rangePendingOrFailed = false; outcomes.clear(); storageChecks.clear();
  $('requests').innerHTML = '<p class="muted">No actions yet.</p>'; $('background-requests').replaceChildren();
  $('range-result').textContent = 'Choose a range to see which stored objects it reads.';
  client = await startTasm({ basePath: '/', signal: window.tasmStartup.signal });
  store = new WorkspaceStore(client.apiUrl); preview = new Preview(store, ChromingTheme.CHROMELESS);
  store.addEventListener('requests', onFrame(() => { renderRequests(); renderStorage(); }));
  store.addEventListener('ingest', () => {
    renderTimeline(); renderRequests();
    const ingest = store.ingest;
    if (!ingest || !busy || ingest.status === 'failed') return;
    status(ingest.published ? 'Preparing playback...' : ingest.stage === 'segment' ? 'Preparing segments...'
      : ingest.stage === 'allocate' || ingest.stage === 'upload' ? 'Storing objects: ' + ingest.objects.filter(o => o.state === 'uploaded' || o.state === 'registered').length + ' of ' + ingest.objects.length + '.'
      : ingest.stage === 'register' ? 'Placing segments on the timeline...' : 'Making the completed flow available...');
  });
  preview.addEventListener('time', updatePlayhead);
  preview.addEventListener('rangeend', () => {
    if (resetting || !introPlaying) return;
    introPlaying = false; played = true; nextStep = 5;
    if (!showResult(4)) showStep(5);
    status('Section finished. Continue to find the video flows available for this example.');
  });
  preview.addEventListener('rangecancel', () => {
    if (!introPlaying) return;
    introPlaying = false; status('Section interrupted. Play it to finish this step.'); render();
  });
  preview.addEventListener('error', event => {
    if (resetting) return;
    introPlaying = false; render();
    $('error-message').textContent = 'Playback failed. Retry to reload the preview.';
    $('error-detail').textContent = (event as CustomEvent<string>).detail;
    $('error').hidden = false;
    retry = () => void perform('Reload preview', async () => { await preview!.update(playbackWorkspace()); status('Preview ready.'); });
  });
  window.addEventListener('tasm-reset', () => {
    if (resetting) return;
    window.tasmStartup.done(); resultTips.clear();
    resetting = true; busy = true; ready = false;
    $('playback-controls').hidden = true;
    document.querySelector('header')!.inert = true;
    document.querySelector('main')!.inert = true;
    $('status').textContent = 'Resetting TAMS in Practice...';
    preview?.destroy(); preview = undefined;
    void store.stop();
  });
  const root = (await window.tasmStartup.wait(store.sources(), 'Loading saved demo'))[0];
  if (root) {
    try {
      const saved = JSON.parse(localStorage.getItem(`tasm-preview:${root.id}`) ?? '{}').demoDeletion;
      if (saved && typeof saved.flowId === 'string' && typeof saved.accepted === 'boolean' && Array.isArray(saved.objects)
        && saved.objects.every((s: Segment) => typeof s.object_id === 'string' && typeof s.timerange === 'string')) deletion = saved;
    } catch { /* no saved deletion */ }
    workspace = await window.tasmStartup.wait(store.load(root.id, undefined, deletion?.accepted ? deletion.flowId : undefined));
    const choices = preview!.choices(playbackWorkspace());
    selectedFlow = videoLanes().find(l => l.id === choices.video)?.flow.id ?? '';
  }
  await window.tasmStartup.wait(verifyStorage());
  deleted = !deletion && excerpt()?.segments.length === 2 && !original();
  if (resetting) return;
  ready = true; document.body.dataset.ready = 'true'; render();
  status(workspace ? 'Saved demo loaded.' : ''); window.tasmStartup.done();
  showWelcome();
  if (deletion) setTimeout(() => {
    if (!resetting) void perform('Delete the original flow', async () => {
      recoveringDeletion = true;
      try { await runStep(8); } finally { recoveringDeletion = false; }
    });
  }, 0);
}
const welcome = $('demo-about') as HTMLDialogElement, welcomeKey = 'tasm-onboarding:demo:v1';
let firstVisit = true;
try { firstVisit = !localStorage.getItem(welcomeKey); } catch { /* Show once for this page load. */ }
function showWelcome() { if (firstVisit) { firstVisit = false; welcome.showModal(); } }
function dismissWelcome() {
  firstVisit = false;
  try { localStorage.setItem(welcomeKey, 'seen'); } catch { /* The welcome still works without preference storage. */ }
}
// Save before the asynchronous close event so an immediate reload remembers dismissal.
welcome.addEventListener('submit', dismissWelcome);
welcome.addEventListener('cancel', dismissWelcome);
welcome.addEventListener('close', dismissWelcome);
$('about-demo').onclick = () => { resultTips.dismiss(); welcome.showModal(); };
$('reset-demo').addEventListener('click', () => resultTips.dismiss(), { capture: true });
async function playSection(guided: boolean) {
  try {
    if (!preview!.loaded) await preview!.update(playbackWorkspace());
    if (!rangeResult) await readSection();
    const [start, end] = interval();
    const outcome = await action('Play selected section', async () => {
      const playing = preview!.playRange(start, end);
      introPlaying = guided; render();
      await playing;
      return 'Playing ' + fmt(start) + ' to ' + fmt(end) + '.';
    });
    status(outcome);
  } catch (error) { introPlaying = false; throw error; }
}
function showResult(value: number, saved = false, items: (Flow | Segment)[] = []) {
  const flow = (id: string) => `.flow-row[data-flow="${CSS.escape(id)}"]`;
  const selected = lane() ? flow(lane()!.flow.id) : '#flow';
  const tip: ResultTip = { step: value, title: '', text: '', targets: [] };
  switch (value) {
    case 1:
      tip.title = saved ? 'Using your saved source' : 'Source created';
      tip.text = saved ? `This source identifies the content already saved in this browser. ${videoLanes().length ? 'Its video flows are still available.' : 'Next, you can add its video flow.'}`
        : 'This identifies the content you are working with. No media has been stored yet. Next, you’ll add a video representation of this source.';
      tip.targets = ['.source-heading']; break;
    case 2:
      tip.title = saved ? 'Using your saved video flow' : 'Video flow added';
      tip.text = saved ? `This flow describes the video representation and its existing timeline. ${prepared() ? 'Its stored media is still available.' : 'It is empty until you add media.'}`
        : 'This flow describes the video representation and its timeline. It is empty until you add media.';
      tip.targets = [selected]; break;
    case 3:
      tip.title = saved ? 'Your saved media is ready' : 'Media stored';
      tip.text = `Your video is ${saved ? 'already' : 'now'} stored as ${mediaObjects().length} media objects. The segments place those objects on the timeline. Match the object IDs to see how the timeline connects to storage.`;
      tip.targets = [selected, '#storage-table']; tip.objects = segments().map(s => s.object_id); break;
    case 4:
      tip.title = 'Your selected range played';
      tip.text = 'The outline shows the time range you requested. The shaded segments show which stored objects were read. An object can extend beyond your selection; playback uses the section you chose.';
      tip.targets = [selected + ' .track', '#range-result']; tip.objects = rangeResult?.segments.map(s => s.object_id); break;
    case 5:
      tip.title = items.length === 1 ? 'Video flow found' : `${items.length} video flows found`;
      tip.text = `TAMS returned ${items.length === 1 ? 'the video flow' : items.length + ' video flows'} you created. An application can use this response to discover the media available for this content.`;
      tip.targets = ['#api-result', ...(items as Flow[]).map(item => flow(item.id) + ' .flow-heading')]; break;
    case 6:
      tip.title = 'Timeline records returned';
      tip.text = `TAMS returned ${items.length} segment${items.length === 1 ? '' : 's'}. Each segment identifies a time range and the stored media object used there. These records describe how to retrieve the video; the video data is stored separately.`;
      tip.targets = ['#api-result', selected + ' .track']; tip.objects = (items as Segment[]).map(s => s.object_id); break;
    case 7:
      tip.title = saved ? 'Your saved excerpt is available' : 'Excerpt created without copying media';
      tip.text = original() ? `Your excerpt uses the same first two media objects as the original. You ${saved ? 'still' : 'now'} have ${videoLanes().length} flows, but still only ${mediaObjects().length} stored objects.`
        : 'Your saved excerpt still uses its two stored media objects. The original flow has already been deleted.';
      tip.targets = [flow(excerpt()!.flow.id)]; tip.objects = excerpt()!.segments.map(s => s.object_id); break;
    case 8:
      tip.title = 'The excerpt remains available';
      tip.text = 'The original flow has gone. Its two unused media objects have been removed, while the two objects used by the excerpt remain available for playback.';
      tip.targets = [flow(excerpt()!.flow.id), '#storage-table']; tip.objects = excerpt()!.segments.map(s => s.object_id); break;
  }
  return resultTips.show(tip);
}
async function runStep(value: number) {
  resultTips.clear();
  if (value < 4) { if (step !== value) showStep(value); return buildStep(value); }
  if (value === 9) return restartWalkthrough();
  preview?.pause(); showStep(value);
  if (value === 4) return playSection(true);
  const saved = value === 7 ? !!excerpt() : deleted;
  let items: (Flow | Segment)[] = [];
  if (value === 5 || value === 6) { items = await listDetails(value === 5 ? 'flows' : 'segments'); queried.add(value); }
  if (value === 7) await createExcerpt();
  if (value === 8 && !deleted) await deletePrevious();
  if (!resetting) { nextStep = value + 1; if (!recoveringDeletion) showResult(value, saved, items); }
}
$('primary').onclick = () => {
  const value = nextStep;
  void perform($('primary').textContent!, () => runStep(value));
};
$('replay').onclick = () => { resultTips.clear(); void perform('Replay section', () => playSection(false)); };
$('pause').onclick = () => { preview?.pause(); status('Paused at ' + fmt(preview?.currentTime ?? 0) + '.'); };
$('retry').onclick = () => retry?.();
async function restartWalkthrough() {
  resultTips.restart();
  preview?.pause(); if (preview?.loaded) await preview.seek(0);
  played = introPlaying = false; queried.clear();
  selectedObject = ''; preset = 'whole'; rangeResult = undefined; rangePendingOrFailed = false;
  $('range-result').textContent = 'Choose a range to see which stored objects it reads.';
  showStep(1); status('Walkthrough restarted. Stored media retained.');
}
$('restart').onclick = () => void perform('Restart walkthrough', restartWalkthrough);
$('range-select').onchange = () => {
  if (busy) return;
  resultTips.clear();
  preset = ($('range-select') as HTMLSelectElement).value; void perform('Read selected section', readSection);
};
$('storage-refresh').onclick = () => { if (!busy) void verifyStorage(); };
$('copy-object-id').onclick = async () => {
  try { await navigator.clipboard.writeText(selectedObject); $('copy-status').textContent = 'ID copied.'; }
  catch { $('copy-status').textContent = 'Copy unavailable. Select the full ID to copy it.'; }
};
document.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => button.onclick = () => {
  if (busy || button.disabled) return;
  resultTips.clear(); preview?.pause(); showStep(Number(button.dataset.step));
  status('');
});
document.addEventListener('pause', event => {
  if (!busy && step === 4 && event.target instanceof HTMLVideoElement) status('Paused at ' + fmt(event.target.currentTime) + '.');
}, true);
window.addEventListener('pagehide', () => { preview?.destroy(); client?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
void perform('Opening browser storage', async () => {
  try { await boot(); }
  catch (error) {
    if (!resetting) {
      window.tasmStartup.fail(error); void store?.stop(); preview?.destroy();
      if (!isSecureContext && location.pathname.endsWith('/preview.html')) showWelcome();
    }
    throw error;
  }
});
