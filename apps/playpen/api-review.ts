import type { ActionRecord, RequestRecord } from '../shared/workspace-store';

export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function describeRequest(record: RequestRecord) {
  const url = new URL(record.url), path = url.pathname, method = record.method;
  const body = object(record.body), response = object(record.response);
  const flow = path.match(/\/api\/flows\/([^/]+)(?:\/([^/]+))?$/);
  const media = path.includes('/media/');
  let title = 'API request', purpose = `Send ${method} to the recorded endpoint.`, effect = 'The server returned a successful response.';
  if (flow && !flow[2] && method === 'PUT') {
    const source = body.format === 'urn:x-nmos:format:multi';
    title = source ? 'Create source collection' : record.stage === 'segment' ? 'Prepare replacement flow' : 'Create media flow';
    purpose = source ? 'Create the collection that groups related video and audio flows.' : 'Create flow metadata describing the media format. This request does not upload media bytes.';
    effect = source ? 'The source collection was created. It can now hold references to media flows.' : 'The flow metadata was saved. Collection membership is published by a separate request.';
  } else if (flow?.[2] === 'storage' && method === 'POST') {
    title = 'Allocate media storage'; purpose = 'Request an upload location for each object ID before sending its media bytes.';
    effect = 'Upload locations were returned. Allocation alone does not store the media bytes.';
  } else if (media && method === 'PUT') {
    title = 'Upload media bytes'; purpose = 'Send one prepared media object to its allocated upload URL.';
    effect = 'The media bytes were stored. A segment registration still has to connect the object to a flow time range.';
  } else if (flow?.[2] === 'segments' && method === 'POST') {
    title = Array.isArray(record.body) ? 'Register segments' : 'Register a segment'; purpose = 'Link stored objects to time ranges in this flow. The same object can be referenced again without uploading its bytes again.';
    effect = 'The segment reference was registered. This request does not publish the source collection.';
    if (Array.isArray(record.body)) effect = `${record.body.length} segment references were registered. This request does not publish the source collection.`;
  } else if (flow?.[2] === 'segments' && method === 'GET') {
    title = url.searchParams.has('timerange') ? 'Query a time range' : 'Read flow segments';
    purpose = 'Read segment references and object URLs' + (url.searchParams.has('timerange') ? ' overlapping the requested time range.' : ' to inspect the flow arrangement.');
    effect = `${Array.isArray(record.response) ? `${record.response.length} segment ${record.response.length === 1 ? 'reference was' : 'references were'} returned in this response.` : 'The segment query completed.'} Media bytes are read separately; this call changes no stored media.`;
  } else if (flow?.[2] === 'flow_collection' && method === 'PUT') {
    title = 'Publish flow collection'; purpose = 'Update which flows belong to the source. During an edit, this switches the source to the replacement flows after segment registration.';
    effect = 'Collection membership was updated. Playback can now use the referenced flows; it may still need to read their media bytes.';
  } else if (flow && !flow[2] && method === 'DELETE') {
    title = 'Retire a flow'; purpose = 'Remove a flow no longer needed by this action, such as a superseded flow or an unpublished replacement during cleanup.';
    effect = 'The flow deletion request succeeded. This response alone does not prove that every associated media object was deleted.';
    if (record.status === 202) effect = 'FLOW deletion was accepted and is pending background processing. The FLOW has not yet been confirmed deleted.';
  } else if (/\/api\/flow-delete-requests\/[^/]+$/.test(path) && method === 'GET') {
    title = 'Check FLOW deletion'; purpose = 'Check the background job that retires the previous FLOW. Shared media objects remain referenced by the replacement.';
    effect = response.status === 'done' ? 'The FLOW deletion job completed. Unreferenced media may still await garbage collection.' : response.status === 'failed' ? 'The FLOW deletion job failed.' : 'FLOW deletion is still pending.';
  } else if (media && method === 'GET') {
    title = 'Read media bytes'; purpose = 'Read stored object bytes for preview or a time-range read. Whole-object reads can include media outside the selected playback range.';
    effect = 'Media bytes were returned to the browser. Reading them does not change the stored object.';
  } else if (media && method === 'HEAD') {
    title = 'Check stored object'; purpose = 'Check whether an object can be read and inspect its headers without downloading its media body.';
    effect = 'The object responded to the storage check. Its headers are recorded below.';
  } else if (/\/api\/(flows|sources)\/[^/]+\/label$/.test(path) && method === 'PUT') {
    title = 'Rename source or flow'; purpose = 'Update the recorded display label without changing media bytes or segment timing.';
    effect = 'The label was updated.';
  } else if (/\/api\/(flows|sources)(\/[^/]+)?$/.test(path) && method === 'GET') {
    title = 'Read source or flow metadata'; purpose = 'Read the stored metadata and collection relationships needed by this action.';
    effect = 'Metadata was returned. No media bytes were changed.';
  }
  const context: [string, string][] = [];
  const add = (label: string, value: unknown) => { if (typeof value === 'string' || typeof value === 'number') context.push([label, String(value)]); };
  add('Flow ID', record.flowId ?? flow?.[1]);
  add('Source ID', body.source_id ?? response.source_id);
  add('Object ID', record.objectId ?? body.object_id);
  if (Array.isArray(body.object_ids)) add('Object IDs', body.object_ids.join(', '));
  if (Array.isArray(record.body)) { add('Segments', record.body.length); add('Object IDs', [...new Set(record.body.map(s => object(s).object_id))].join(', ')); }
  add('Label', body.label ?? response.label);
  add('Requested time range', url.searchParams.get('timerange'));
  add('Flow time range', record.timerange ?? body.timerange); add('Object time range', body.object_timerange); add('Time offset (ts_offset)', body.ts_offset);
  add('File', body.file); add('Bytes sent', body.bytes); add('Bytes received', response.bytes);
  if (method === 'HEAD') add('Stored bytes (Content-Length)', record.responseHeaders?.['content-length']);
  const failed = !!record.error || (Array.isArray(response.failed_segments) && response.failed_segments.length > 0) || (title === 'Check FLOW deletion' && response.status === 'failed') || (record.status !== undefined && (record.status < 200 || record.status >= 300));
  const pending = record.ms === undefined;
  const state = failed ? 'Failed' : pending ? 'Pending' : record.status === undefined ? 'Unknown' : record.status === 202 ? 'Accepted' : title === 'Check FLOW deletion' && response.status !== 'done' ? 'Pending' : 'Succeeded';
  const outcome = failed ? `The call failed${record.status === undefined ? '' : ` (HTTP ${record.status})`}. ${record.error ?? 'See the recorded response.'} Do not assume the intended change completed.`
    : pending ? 'The call is still in progress. Its final result has not been recorded.'
      : record.status === undefined ? 'No HTTP result was recorded.' : `HTTP ${record.status}. ${effect}`;
  return { title, purpose, outcome, context, state };
}

export function walkthrough(action: ActionRecord) {
  const steps: { title: string; purpose: string; outcome: string; state: string; context: [string, string][]; ms?: number; firstRequest?: number; records: RequestRecord[] }[] = [];
  for (let index = 0; index <= action.requests.length; index++) {
    for (const event of action.events?.filter(e => e.position === index) ?? []) steps.push({ title: event.title, purpose: event.detail, outcome: event.state === 'Pending' ? 'This stage is in progress.' : `Stage ${event.state.toLowerCase()}.`, state: event.state, context: [], ms: event.ms, records: [] });
    const record = action.requests[index]; if (!record) continue;
    const description = describeRequest(record);
    const reading = ['Read source or flow metadata', 'Read flow segments'].includes(description.title);
    const title = reading ? 'Read current arrangement' : description.title === 'Prepare replacement flow' ? 'Create replacement FLOW' : description.title;
    const previous = steps.at(-1);
    if (previous?.title === title && previous.records.length && (reading || previous.records[0].flowId === record.flowId)) previous.records.push(record);
    else steps.push({ ...description, purpose: reading ? 'Read persisted SOURCE and FLOW metadata and their segment arrangement.' : description.purpose, title, firstRequest: index, records: [record] });
  }
  for (const step of steps) if (step.records.length) {
    const descriptions = step.records.map(describeRequest);
    step.state = descriptions.some(d => d.state === 'Failed') ? 'Failed' : descriptions.some(d => d.state === 'Pending' && d.title !== 'Check FLOW deletion') ? 'Pending' : descriptions.at(-1)!.state;
    step.ms = step.records.reduce((sum, r) => sum + (r.ms ?? 0), 0);
    const flows = [...new Set(descriptions.flatMap(d => d.context.filter(([label]) => label === 'Flow ID').map(([, id]) => id)))];
    const objects = new Set(step.records.flatMap(r => r.objectIds ?? (r.objectId ? [r.objectId] : Array.isArray(object(r.body).object_ids) ? object(r.body).object_ids as string[] : Array.isArray(r.body) ? r.body.map(s => String(object(s).object_id)) : [])));
    step.context = flows.map(id => ['FLOW ID', id]);
    if (objects.size) step.context.push(['Media objects', String(objects.size)]);
    const segments = step.records.filter(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/segments')).reduce((sum, r) => sum + (Array.isArray(r.body) ? r.body.length : 1), 0);
    if (segments) step.context.push(['Segments requested', String(segments)]);
    const bytes = step.records.reduce((sum, r) => sum + Number(object(r.body).bytes ?? object(r.response).bytes ?? 0), 0);
    if (bytes) step.context = [...step.context.filter(([label]) => !label.startsWith('Bytes ')), ['Media bytes', bytes.toLocaleString()]];
    step.outcome = step.state === 'Failed' ? 'This stage failed. The recorded results do not confirm the intended change.' : step.state === 'Pending' ? 'This stage is still in progress.' : step.state === 'Accepted' ? 'Accepted for background processing; deletion is still pending.' : descriptions.at(-1)!.outcome.replace(/^HTTP \d+\. /, '');
  }
  return steps;
}

export function resourceButton(kind: 'sources' | 'flows' | 'objects', id: string, label = id) {
  return `<button type="button" class="resource-id${kind === 'flows' ? ' flow-id' : ''}" data-resource="${kind}/${escape(encodeURIComponent(id))}" title="${escape(id)}">${escape(label)}</button>`;
}
export function requestDetails(record: RequestRecord) {
  const pretty = (value: unknown) => escape(JSON.stringify(value, null, 2));
  const url = new URL(record.url);
  const endpoint = url.pathname.match(/\/api\/(flows|sources|objects)(?:\/[^/]+)?\/?$/)?.[1] as 'flows' | 'sources' | 'objects' | undefined;
  const payload = (value: unknown) => {
    const primaryIds = new Set((Array.isArray(value) ? value : [value]).map(item => object(item).id));
    return JSON.stringify(value, null, 2).split('\n').map(line => {
      const match = line.match(/^(\s*)"(source_id|flow_id|object_id|id)": ("(?:[^"\\]|\\.)*")(,?)$/);
      if (!match) return escape(line);
      const [, indent, field, quoted, comma] = match;
      const id: string = JSON.parse(quoted);
      const kind = field === 'id' ? primaryIds.has(id) && endpoint : field === 'source_id' ? 'sources' : field === 'flow_id' ? 'flows' : 'objects';
      return kind && id ? indent + '"' + field + '": "' + resourceButton(kind, id, quoted.slice(1, -1)) + '"' + comma : escape(line);
    }).join('\n');
  };
  return `<div class="request-line"><span>${escape(record.method)}</span><span class="request-path">${escape(url.pathname + url.search)}</span><span class="request-status">${record.status ?? '…'}</span></div><details><summary>Request payload</summary><pre>${record.body === undefined ? '(no body)' : payload(record.body)}</pre></details><details><summary>Request headers and URL</summary><pre>${escape(record.url)}\n${pretty(record.headers)}</pre></details><details><summary>Response · ${record.ms === undefined ? 'pending' : `${record.ms} ms`}</summary><pre>${record.error ? escape(record.error) + '\n' : ''}${record.response === undefined ? record.ms === undefined && !record.error ? 'Waiting…' : '(no response body)' : record.response === null ? '(empty)' : payload(record.response)}</pre></details><details><summary>Response headers</summary><pre>${pretty(record.responseHeaders)}</pre></details>`;
}

// Review holds the selected action by reference; it never drives or replays requests.
export function wireReview(actions: () => ActionRecord[], selectedAction: () => string, selectRequest?: (record: RequestRecord) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = $<HTMLDialogElement>('api-review'), apiOpener = $<HTMLButtonElement>('review-requests'), walkOpener = $<HTMLButtonElement>('walkthrough-requests');
  const picker = $<HTMLSelectElement>('review-action'), list = $('review-requests-list'), detail = $('review-detail');
  let action: ActionRecord | undefined, index = 0, detailKey = '', detailHtml = '', optionsHtml = '';
  let mode: 'api' | 'walkthrough' = 'api', opener = apiOpener;
  const render = () => {
    apiOpener.disabled = walkOpener.disabled = !actions().length;
    if (!dialog.open || !action) return;
    const available = actions().includes(action) ? actions() : [action, ...actions()];
    const options = available.map(a => `<option value="${escape(a.id)}" ${a === action ? 'selected' : ''}>${escape(a.name)}</option>`).join('');
    if (optionsHtml !== options) { picker.innerHTML = options; optionsHtml = options; }
    const stages = walkthrough(action), narrative = mode === 'walkthrough';
    const count = narrative ? stages.length : action.requests.length, record = action.requests[index];
    $('review-title').textContent = narrative ? 'API call explanations' : 'API call review';
    $('review-help').textContent = narrative ? 'A timeline of recorded work in this tab. Inspecting it does not run or replay the operation.' : 'Calls recorded in this tab. Reviewing does not send requests or pause the running action.';
    $('review-mode').textContent = narrative ? 'View raw requests' : 'Explain API calls';
    $('review-requests-list').setAttribute('aria-label', narrative ? 'Operation stages' : 'Recorded API calls');
    $('review-position').textContent = count ? `${narrative ? 'Stage' : 'Call'} ${index + 1} of ${count}` : narrative ? 'No stages' : 'No calls';
    $('review-action-status').textContent = action.error ? `Action failed: ${action.error}` : action.pending ? 'Action in progress. New calls appear here without changing your selection.' : 'Action finished.';
    $<HTMLButtonElement>('review-previous').disabled = index === 0;
    $<HTMLButtonElement>('review-next').disabled = index >= count - 1;
    const items = narrative ? stages : action.requests.map(describeRequest);
    const rows = items.map((description, i) => {
      const r = action!.requests[i], stage = stages[i];
      return `<button class="request-row ${narrative ? 'walkthrough-stage' : ''} ${i === index ? 'selected' : ''}" data-review-request="${i}" aria-pressed="${i === index}"><strong>${i + 1}. ${escape(description.title)}</strong><small>${narrative ? `${description.state}${stage.ms === undefined ? '' : ` · ${stage.ms} ms recorded work`}` : `${escape(r.method)} · ${description.state}${r.status === undefined ? '' : ` · ${r.status}`}`}</small></button>`;
    }).join('');
    // Keep keyboard focus and scroll position when a running action appends a call.
    if (list.innerHTML !== rows) {
      const focused = (document.activeElement as HTMLElement)?.dataset.reviewRequest, scroll = list.scrollTop;
      list.innerHTML = rows;
      if (focused) list.querySelector<HTMLElement>(`[data-review-request="${focused}"]`)?.focus({ preventScroll: true });
      list.scrollTop = scroll;
    }
    const description = items[index], key = `${action.id}:${mode}:${index}`;
    const html = description ? `<h3>${escape(description.title)}</h3><p>${escape(description.purpose)}</p>${description.context.length ? `<dl class="review-context">${description.context.map(([label, value]) => `<dt>${escape(label)}</dt><dd ${narrative && label === 'FLOW ID' ? `title="${escape(value)}" aria-label="${escape(value)}"` : ''}>${escape(narrative && label === 'FLOW ID' ? value.slice(0, 8) : value)}</dd>`).join('')}</dl>` : ''}<p class="review-outcome ${description.state === 'Failed' ? 'danger' : ''}">${escape(description.outcome)}</p>${narrative ? '' : requestDetails(record)}` : `<p>No ${narrative ? 'stages' : 'API calls'} have been recorded for this action.</p>`;
    if (key !== detailKey || html !== detailHtml) {
      const same = key === detailKey, scroll = same ? detail.scrollTop : 0;
      const expanded = same ? [...detail.querySelectorAll('details')].map(d => d.open) : [];
      const focused = same ? [...detail.querySelectorAll('summary')].indexOf(document.activeElement as HTMLElement) : -1;
      detail.innerHTML = html;
      detail.querySelectorAll('details').forEach((d, i) => d.open = !!expanded[i]);
      if (focused >= 0) detail.querySelectorAll('summary')[focused]?.focus({ preventScroll: true });
      detail.scrollTop = scroll; detailKey = key; detailHtml = html;
    }
  };
  const open = (nextMode: typeof mode, button: HTMLButtonElement) => {
    action = actions().find(a => a.id === selectedAction()) ?? actions()[0];
    if (!action) return;
    mode = nextMode; opener = button; index = 0; if (!dialog.open) dialog.showModal(); render();
  };
  apiOpener.onclick = () => open('api', apiOpener);
  walkOpener.onclick = () => open('walkthrough', walkOpener);
  $('review-mode').onclick = () => {
    if (!action) return;
    const stages = walkthrough(action);
    index = mode === 'api' ? Math.max(0, stages.findIndex(s => s.firstRequest !== undefined && index >= s.firstRequest && index < s.firstRequest + s.records.length)) : stages[index]?.firstRequest ?? 0;
    mode = mode === 'api' ? 'walkthrough' : 'api'; render();
  };
  picker.onchange = () => { action = actions().find(a => a.id === picker.value) ?? action; index = 0; render(); };
  const move = (next: number) => {
    if (!action || !Number.isInteger(next) || next < 0 || next >= (mode === 'api' ? action.requests.length : walkthrough(action).length)) return;
    if (mode === 'api') selectRequest?.(action.requests[next]);
    index = next; render(); list.querySelector(`[data-review-request="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  $('review-previous').onclick = () => move(index - 1);
  $('review-next').onclick = () => move(index + 1);
  list.onclick = event => {
    const value = (event.target as HTMLElement).closest<HTMLElement>('[data-review-request]')?.dataset.reviewRequest;
    if (value !== undefined) move(Number(value));
  };
  $('review-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    action = undefined; detailKey = ''; detailHtml = ''; optionsHtml = ''; list.replaceChildren(); detail.replaceChildren(); picker.replaceChildren();
    opener.focus({ preventScroll: true });
  });
  return render;
}
