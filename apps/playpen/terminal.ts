import operations from '../../pkg/operations.json' with { type: 'json' };
import type { RequestRecord } from '../shared/workspace-store';

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'];
const flags = ['-X', '--request', '-H', '--header', '-d', '--data', '--data-binary', '-I', '--head'];

function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function curlCommand(record: Pick<RequestRecord, 'method' | 'url' | 'headers' | 'body' | 'rawBody'>) {
  const parts = ['curl', '-X', record.method, quote(record.url)];
  for (const [name, value] of Object.entries(record.headers)) parts.push('-H', quote(name + ': ' + value));
  if (record.rawBody !== undefined) parts.push('--data', quote(record.rawBody));
  else if (record.body !== undefined) {
    const upload = record.body as { file?: string } | null;
    if (upload?.file && new URL(record.url).pathname.includes('/media/')) parts.push('--data-binary', quote('@' + upload.file));
    else parts.push('--data', quote(JSON.stringify(record.body)));
  }
  return parts.join(' ');
}

// Read quoted curl arguments as data. The browser never evaluates shell syntax.
function words(line: string, allowIncomplete = false) {
  const result: { value: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue; }
    const start = i;
    let value = '', quoted = '';
    while (i < line.length && (quoted || !/\s/.test(line[i]))) {
      const c = line[i++];
      if (quoted && c === quoted) quoted = '';
      else if (!quoted && (c === "'" || c === '"')) quoted = c;
      else if (c === '\\' && quoted !== "'") {
        if (i === line.length && !allowIncomplete) throw new Error('Complete the escaped character.');
        value += line[i++] ?? '';
      } else value += c;
    }
    if (quoted && !allowIncomplete) throw new Error('Close the quoted argument.');
    result.push({ value, start, end: i });
  }
  return result;
}

export interface CurlRequest { url: string; method: string; headers: Record<string, string>; data?: string; filename?: string }

export function parseCurl(line: string, apiUrl: string): CurlRequest {
  const args = words(line).map(token => token.value);
  if (args.shift() !== 'curl') throw new Error('Start the command with curl.');
  const headers = new Headers();
  let url: URL | undefined, method: string | undefined, data: string | undefined, filename: string | undefined;
  const argument = (flag: string) => {
    const value = args.shift();
    if (value === undefined) throw new Error('Missing argument for ' + flag);
    return value;
  };
  while (args.length) {
    const arg = args.shift()!;
    switch (arg) {
      case '-X': case '--request': method = argument(arg).toUpperCase(); break;
      case '-I': case '--head': method = 'HEAD'; break;
      case '-H': case '--header': {
        const header = argument(arg), colon = header.indexOf(':');
        if (colon <= 0) throw new Error('Enter a header name and value separated by a colon.');
        headers.append(header.slice(0, colon).trim(), header.slice(colon + 1).trim());
        break;
      }
      case '-d': case '--data': case '--data-binary': {
        if (data !== undefined || filename !== undefined) throw new Error('Supply one request body.');
        const value = argument(arg);
        if (arg === '--data-binary' && value.startsWith('@')) {
          filename = value.slice(1);
          if (!filename) throw new Error('Enter the filename after @.');
        } else data = value;
        break;
      }
      default:
        if (arg.startsWith('-')) throw new Error('Unsupported curl option ' + arg);
        if (url) throw new Error('Supply one Playpen URL.');
        url = new URL(arg, apiUrl);
    }
  }
  if (!url) throw new Error('Enter a Playpen API or media URL.');
  const media = new URL('../media/', apiUrl).href;
  if (!url.href.startsWith(apiUrl) && !url.href.startsWith(media)) throw new Error('Choose a URL in this Playpen’s /api/ or /media/ routes.');
  method ??= data !== undefined || filename !== undefined ? 'POST' : 'GET';
  if (!methods.includes(method)) throw new Error('Unsupported HTTP method ' + method);
  if ((method === 'GET' || method === 'HEAD') && (data !== undefined || filename !== undefined)) throw new Error(method + ' cannot send a body.');
  return { method, url: url.href, headers: Object.fromEntries(headers), data, filename };
}

export type ResourceIds = { sourceId: string[]; flowId: string[]; objectId: string[] };

function completions(line: string, cursor: number, apiUrl: string, ids: ResourceIds) {
  const tokens = words(line, true);
  const token = tokens.find(t => t.start <= cursor && t.end >= cursor);
  const start = token?.start ?? cursor, end = token?.end ?? cursor;
  const prefix = words(line.slice(start, cursor), true)[0]?.value ?? '';
  const before = tokens.filter(t => t.end <= start).map(t => t.value);
  const previous = before.at(-1);
  let values: string[];
  if (!before.length) values = ['curl'];
  else if (previous === '-X' || previous === '--request') values = methods.filter(v => v.startsWith(prefix.toUpperCase()));
  else if (prefix.startsWith('-')) values = flags;
  else if (['-d', '--data', '-H', '--header', '--data-binary'].includes(previous ?? '')) values = [];
  else {
    const base = prefix.startsWith('/') ? new URL(apiUrl).pathname : /^https?:/.test(prefix) ? apiUrl : '';
    const routes = new Set<string>();
    for (const { path } of operations) {
      const match = path.match(/\{([^}]+)\}/);
      if (!match) routes.add(base + path.slice(1));
      else {
        const [resource, field] = match;
        // Also complete the collection prefix before the first resource exists.
        routes.add(base + path.slice(1, match.index));
        for (const id of ids[field as keyof ResourceIds] ?? []) {
          const route = path.slice(1).replace(resource, encodeURIComponent(id));
          routes.add(base + route.split('{')[0]);
        }
      }
    }
    // Offer the next path component, so completing an ID doesn't also offer every child route.
    values = [...new Set([...routes].filter(route => route.startsWith(prefix) && route !== prefix).map(route => {
      const slash = route.indexOf('/', Math.max(base.length, prefix.length));
      const component = slash < 0 ? route : route.slice(0, slash);
      return component === prefix ? route : component;
    }))];
    if (!prefix) values.push(...flags);
  }
  const choices = values.filter(value => value && value.startsWith(previous === '-X' || previous === '--request' ? prefix.toUpperCase() : prefix)).sort();
  return { start, end, choices };
}

interface TerminalOptions {
  apiUrl: () => string;
  ids: () => ResourceIds;
  execute: (request: CurlRequest, file?: File) => Promise<RequestRecord>;
  success: (record: RequestRecord) => void;
}

export function wireTerminal(options: TerminalOptions) {
  const panel = document.querySelector<HTMLDetailsElement>('#terminal')!;
  const input = document.querySelector<HTMLInputElement>('#terminal-command')!;
  const fileInput = document.querySelector<HTMLInputElement>('#terminal-file')!;
  const form = document.querySelector<HTMLFormElement>('#terminal-form')!;
  const output = document.getElementById('terminal-output')!;
  const status = document.getElementById('terminal-status')!;
  const list = document.getElementById('terminal-options')!;
  const run = document.querySelector<HTMLButtonElement>('#terminal-run')!;
  let submitting = false, fileCommand: string | undefined;
  function fill(record: Parameters<typeof curlCommand>[0]) {
    fileCommand = undefined;
    input.value = curlCommand(record);
    list.replaceChildren();
    panel.open = true;
  }
  input.oninput = () => { fileCommand = undefined; list.replaceChildren(); };
  input.onkeydown = event => {
    if (event.key === 'Escape' && list.childElementCount) {
      event.stopPropagation(); list.replaceChildren(); return;
    }
    if (event.key !== 'Tab' || event.shiftKey || list.childElementCount) return;
    const { start, end, choices } = completions(input.value, input.selectionStart ?? input.value.length, options.apiUrl(), options.ids());
    if (!choices.length) return;
    event.preventDefault();
    const choose = (value: string) => {
      input.setRangeText(value + (end === input.value.length && !value.endsWith('/') ? ' ' : ''), start, end, 'end');
      list.replaceChildren(); input.focus();
    };
    if (choices.length === 1) { choose(choices[0]); return; }
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = choice; button.onclick = () => choose(choice);
      list.append(button);
    }
    list.querySelector('button')?.focus();
  };
  async function submit(file?: File) {
    if (submitting || run.disabled) return;
    list.replaceChildren();
    try {
      const request = parseCurl(input.value, options.apiUrl());
      if (request.filename && !file) {
        fileCommand = input.value; fileInput.value = '';
        output.textContent = status.textContent = 'Choose ' + request.filename + ' to send this upload.';
        fileInput.click(); return;
      }
      if (file && file.name !== request.filename) throw new Error('Choose the file named ' + request.filename);
      submitting = true; run.disabled = true;
      output.textContent = status.textContent = 'Running ' + request.method + '…';
      const record = await options.execute(request, file);
      status.textContent = request.method + ' · HTTP ' + (record.status ?? 'request failed');
      const body = record.method === 'HEAD' ? record.responseHeaders : record.response;
      output.textContent = ['HTTP ' + (record.status ?? 'request failed'), record.error, body == null ? '' : JSON.stringify(body, null, 2)].filter(Boolean).join('\n');
      if (!record.error && record.status && record.status < 400) options.success(record);
    } catch (error) { output.textContent = status.textContent = (error as Error).message; }
    finally { submitting = false; run.disabled = false; }
  }
  form.onsubmit = event => { event.preventDefault(); void submit(); };
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    if (file && fileCommand === input.value) { fileCommand = undefined; void submit(file); }
  };
  fileInput.oncancel = () => { if (fileCommand === input.value) output.textContent = status.textContent = 'Upload canceled.'; };
  return { fill };
}
