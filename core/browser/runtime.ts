import { PGlite } from '@electric-sql/pglite';
import { sha256 } from '@noble/hashes/sha2.js';
import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import init, { Tasm } from '../../pkg/browser/tasm.js';
import schema from './migrations/001.sql';
import operations from '../../pkg/operations.json';
import * as validators from '../../pkg/validators.js';
import type { TasmOptions } from './public.d.ts';

export interface BrowserRequest { method: string; url: string; headers: Record<string, string> }
export interface BrowserResponse { status: number; headers: Record<string, string>; body: string | Blob | null }
type FileRow = { backend: string; object_id: string; name: string; incarnation: string; size: number; content_type: string; checksum: string; md5: string };
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const defaultBackend = '81d13d58-5041-4580-91f9-38ce03daef19';
const bodyLimit = 16 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class Runtime {
  private db!: PGlite;
  private core!: Tasm;
  private files!: FileSystemDirectoryHandle;
  private queue: Promise<unknown> = Promise.resolve();
  private sqlQueue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private inTransaction = false;
  readonly api: string;
  readonly media: string;
  constructor(readonly base: string) { this.api = `${base}api/`; this.media = `${base}media/`; }

  async open(backends: TasmOptions['backends'] = [{ id: defaultBackend, label: 'Browser storage' }]): Promise<void> {
    if (!backends.length || backends.length > 1000 || new Set(backends.map(b => b.id.toLowerCase())).size !== backends.length ||
      backends.some(b => !uuid.test(b.id) || !b.label.trim())) {
      throw new Error('Storage backends require unique UUIDs and non-empty labels.');
    }
    const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
      WebAssembly.compileStreaming(fetch(new URL('pglite.wasm', this.base))),
      WebAssembly.compileStreaming(fetch(new URL('initdb.wasm', this.base))),
      fetch(new URL('pglite.data', this.base)).then(r => r.blob()),
    ]);
    this.db = await PGlite.create({ dataDir: `idb://tasm-${encodeURIComponent(new URL(this.base).pathname)}`, relaxedDurability: false,
      parsers: { 1700: value => value, 20: value => value },
      pgliteWasmModule, initdbWasmModule, fsBundle });
    const root = await navigator.storage.getDirectory();
    this.files = await root.getDirectoryHandle(`tasm-${encodeURIComponent(new URL(this.base).pathname)}`, { create: true });
    const found = await this.db.query<{ present: boolean }>("SELECT to_regclass('tasm_schema') IS NOT NULL AS present");
    if (found.rows[0].present) {
      const version = await this.db.query<{ version: number }>('SELECT version FROM tasm_schema');
      if (version.rows.length !== 1 || version.rows[0].version !== 1) throw new Error('Unsupported TASM database version.');
    } else {
      await this.db.transaction(async tx => {
        await tx.exec(schema);
        await tx.exec(`CREATE TABLE tasm_schema (version integer PRIMARY KEY);
          INSERT INTO tasm_schema VALUES (1);
          CREATE TABLE tasm_files (backend uuid NOT NULL, object_id text NOT NULL, name text NOT NULL UNIQUE,
            incarnation text NOT NULL, size bigint NOT NULL, content_type text NOT NULL, checksum text NOT NULL,
            md5 text NOT NULL, PRIMARY KEY(backend, object_id));`);
        for (const [i, b] of backends.entries()) {
          await tx.query(`INSERT INTO tamoss_storage_backends
            (id,label,provider,region,store_product,store_type,default_storage,record)
            VALUES ($1,$2,'browser','local','tasm-opfs','http_object_store',$3,'{}')`, [b.id, b.label, i === 0]);
        }
      });
    }
    // Every OPFS filename is generated internally. Unpublished files can be
    // removed after a crash because their SQL publication never committed.
    const names = new Set((await this.db.query<{ name: string }>('SELECT name FROM tasm_files')).rows.map(row => row.name));
    for await (const name of this.files.keys()) if (!names.has(name)) await this.files.removeEntry(name);
    await this.db.exec(`UPDATE tamoss_webhook_deliveries SET status='pending',claimed_by=NULL,claim_expires_at=NULL WHERE status='started';
      UPDATE tamoss_delete_requests SET status='created',claimed_by=NULL,claim_expires_at=NULL WHERE status='started';
      UPDATE tamoss_object_copies SET status='pending',claimed_by=NULL,claim_expires_at=NULL WHERE status='started';
      UPDATE tamoss_object_cleanups SET status='pending',claimed_by=NULL,claim_expires_at=NULL WHERE status='started';`);
    await init({ module_or_path: new URL('tasm_bg.wasm', this.base) });
    this.core = new Tasm((op: string, payload: string) => this.bridge(op, JSON.parse(payload)).then(stringify), this.media);
    this.schedule();
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    // API calls and background jobs share one PostgreSQL connection.
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }
  private sql<T>(run: () => Promise<T>): Promise<T> {
    const next = this.sqlQueue.then(run);
    this.sqlQueue = next.catch(() => {});
    return next;
  }
  private async bridge(op: string, p: any): Promise<unknown> {
    switch (op) {
      case 'begin':
      case 'commit': return this.sql(async () => {
        await this.db.exec(op === 'begin' ? 'BEGIN' : 'COMMIT');
        this.inTransaction = op === 'begin';
        return null;
      });
      case 'url': {
        const url = new URL(p.backend, this.media);
        url.searchParams.set('object_id', p.id);
        return url.href;
      }
      case 'sql': return this.sql(async () => {
        const sql = p.sql.replace(/\$(\d+)\b/g, (_: string, n: string) => `$${n}::${p.params[Number(n) - 1].type}`);
        // Preserve integers embedded in JSONB until Rust decodes them.
        const result = await this.db.query(sql, p.params.map((v: any) => v.value), {
          parsers: { 114: value => value, 3802: value => value },
        });
        return { affectedRows: result.affectedRows ?? 0,
          rows: result.rows.map(row => result.fields.map(field => (row as Record<string, unknown>)[field.name])) };
      });
      case 'rollback': return this.sql(async () => { if (this.inTransaction) await this.db.exec('ROLLBACK'); this.inTransaction = false; return null; });
      case 'head': {
        const row = await this.fileRow(p.backend, p.id, true);
        if (!row) return null;
        const file = await this.file(row);
        if (file.size !== Number(row.size)) throw new Error('Stored object size is inconsistent.');
        return { size: Number(row.size), contentType: row.content_type, etag: `"${row.checksum}"`, checksum: row.checksum };
      }
      case 'delete': {
        for (const { object_id: id } of p.allocations) {
          const row = await this.fileRow(p.backend, id);
          if (row) {
            await this.files.removeEntry(row.name).catch(ignoreMissing);
            await this.db.query('DELETE FROM tasm_files WHERE backend=$1 AND object_id=$2 AND name=$3', [p.backend, id, row.name]);
          }
        }
        return null;
      }
      case 'copy': {
        const source = await this.fileRow(p.source, p.id, true);
        if (!source) throw new Error('Copy source is missing.');
        const previous = await this.fileRow(p.destination, p.id);
        const file = await this.file(source), name = crypto.randomUUID();
        let published = false;
        try {
          const handle = await this.files.getFileHandle(name, { create: true });
          await file.stream().pipeTo(await handle.createWritable());
          const result = await this.db.query(`INSERT INTO tasm_files (backend,object_id,name,incarnation,size,content_type,checksum,md5)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (backend,object_id) DO UPDATE SET
              name=EXCLUDED.name,incarnation=EXCLUDED.incarnation,size=EXCLUDED.size,
              content_type=EXCLUDED.content_type,checksum=EXCLUDED.checksum,md5=EXCLUDED.md5
              WHERE tasm_files.incarnation<>EXCLUDED.incarnation`,
            [p.destination, p.id, name, source.incarnation, source.size, source.content_type, source.checksum, source.md5]);
          published = result.affectedRows === 1;
          if (!published) await this.files.removeEntry(name);
          // Once published, deletion of the old orphan can wait until startup.
          else if (previous) await this.files.removeEntry(previous.name).catch(() => {});
        } catch (error) { if (!published) await this.files.removeEntry(name).catch(ignoreMissing); throw error; }
        return null;
      }
      case 'webhook': {
        const headers = new Headers({ 'Content-Type': 'application/json', 'X-Tasm-Delivery-Id': p.id });
        if (p.webhook.api_key_name && p.webhook.api_key_value) headers.set(p.webhook.api_key_name, p.webhook.api_key_value);
        const response = await fetch(p.webhook.url, { method: 'POST', body: p.payload_json, headers,
          credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(p.timeout * 1000) });
        await response.body?.cancel();
        return { status: response.status, reason: response.statusText };
      }
      default: throw new Error(`Unknown host operation ${op}`);
    }
  }

  async request(request: BrowserRequest, chunks: AsyncIterable<Uint8Array>): Promise<BrowserResponse> {
    if (request.url.startsWith(this.media)) return this.mediaRequest(request, chunks);
    const body = await readBody(chunks, bodyLimit);
    return this.serial(async () => {
      const url = new URL(request.url);
      const path = `/${url.pathname.slice(new URL(this.api).pathname.length)}`;
      const operation = operations.find(op => op.method === request.method && matches(op.path, path));
      if (body && operation?.validator) {
        let value;
        try { value = JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON.'); }
        const validate = (validators as Record<string, (value: unknown) => boolean>)[operation.validator];
        if (!validate(value)) throw new HttpError(400, 'Request does not match the TAMS schema.');
      } else if (!body && operation?.required) throw new HttpError(400, 'JSON body is required.');
      url.pathname = path;
      const result = JSON.parse(await this.core.request(JSON.stringify({ ...request, url: url.href, body: body || null }))) as BrowserResponse;
      // Routers operate on TAMS API paths; transport mounting is handled once here.
      for (const header of ['location', 'link']) {
        if (result.headers[header]) result.headers[header] = result.headers[header].replace(
          new RegExp(`(${escape(new URL(this.api).origin)})?/(flow-delete-requests|flows|sources|service|objects)(?=[/?">]|$)`, 'g'),
          `${this.api}$2`);
      }
      await this.sqlQueue;
      return result;
    });
  }
  async poll(): Promise<void> {
    await this.serial(async () => { await this.core.poll(); await this.sqlQueue; });
  }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try { await this.poll(); } catch { /* Durable jobs are retried on the next poll. */ }
      this.schedule();
    }, 1000);
  }
  stopPolling(): void { this.stopped = true; clearTimeout(this.timer); }
  async close(): Promise<void> {
    this.stopPolling(); await this.queue; await this.sqlQueue; await this.db.close();
  }
  private async fileRow(backend: string, id: string, current = false): Promise<FileRow | undefined> {
    return (await this.db.query<FileRow>(`SELECT f.* FROM tasm_files f WHERE backend=$1 AND object_id=$2
      ${current ? 'AND EXISTS (SELECT 1 FROM tamoss_media_objects m WHERE m.id=f.object_id AND m.created_at::text=f.incarnation)' : ''}`, [backend, id])).rows[0];
  }
  private async file(row: FileRow): Promise<File> { return (await this.files.getFileHandle(row.name)).getFile(); }
  private async allocation(backend: string, id: string): Promise<any> {
    const row = (await this.db.query<any>(`SELECT m.record,m.created_at::text AS incarnation,m.referenced_by_flows,m.content_type,f.read_only
      FROM tamoss_media_objects m LEFT JOIN tamoss_flows f ON f.id=(m.record->>'allocated_by_flow')::uuid WHERE m.id=$1`, [id])).rows[0];
    if (!row || !row.record.instances?.some((v: any) => v.controlled && v.storage_backend_id === backend)) throw new HttpError(404, 'Object allocation does not exist.');
    if (row.read_only) throw new HttpError(403, 'Flow is read-only.');
    return row;
  }
  private async mediaRequest(request: BrowserRequest, chunks: AsyncIterable<Uint8Array>): Promise<BrowserResponse> {
    const url = new URL(request.url), backend = url.pathname.slice(new URL(this.media).pathname.length);
    const id = url.searchParams.get('object_id');
    if (!id || !uuid.test(backend)) throw new HttpError(404, 'Object does not exist.');
    if (request.method === 'PUT') {
      const ticket = await this.serial(() => this.allocation(backend, id));
      if (ticket.referenced_by_flows.length) throw new HttpError(409, 'Registered object bytes are immutable.');
      const type = request.headers['content-type'] ?? 'application/octet-stream';
      if (ticket.content_type !== type) throw new HttpError(400, 'Content-Type does not match the allocation.');
      const name = crypto.randomUUID();
      let writer: FileSystemWritableFileStream | undefined, published = false;
      try {
        writer = await (await this.files.getFileHandle(name, { create: true })).createWritable();
        const hash = sha256.create(), legacy = md5.create(); let size = 0;
        for await (const chunk of chunks) { await writer.write(chunk as Uint8Array<ArrayBuffer>); hash.update(chunk); legacy.update(chunk); size += chunk.byteLength; }
        await writer.close(); writer = undefined;
        const digest = hash.digest(), checksum = bytesToHex(digest), md5sum = base64(legacy.digest());
        if (request.headers['content-md5'] && request.headers['content-md5'] !== md5sum) throw new HttpError(400, 'Content-MD5 mismatch.');
        if (request.headers['x-amz-checksum-sha256'] && request.headers['x-amz-checksum-sha256'] !== base64(digest)) throw new HttpError(400, 'SHA-256 mismatch.');
        if (request.headers['content-length'] && Number(request.headers['content-length']) !== size) throw new HttpError(400, 'Content-Length mismatch.');
        await this.serial(async () => {
          const current = await this.allocation(backend, id);
          if (current.incarnation !== ticket.incarnation || current.referenced_by_flows.length) throw new HttpError(409, 'Object allocation changed during upload.');
          const old = await this.fileRow(backend, id);
          await this.db.query(`INSERT INTO tasm_files (backend,object_id,name,incarnation,size,content_type,checksum,md5)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (backend,object_id) DO UPDATE SET
            name=EXCLUDED.name,incarnation=EXCLUDED.incarnation,size=EXCLUDED.size,content_type=EXCLUDED.content_type,checksum=EXCLUDED.checksum,md5=EXCLUDED.md5`,
            [backend,id,name,ticket.incarnation,size,type,checksum,md5sum]);
          published = true;
          if (old) await this.files.removeEntry(old.name).catch(() => {});
        });
        return { status: 200, headers: { etag: `"${checksum}"`, 'x-amz-checksum-sha256': base64(digest) }, body: null };
      } finally {
        await writer?.abort().catch(() => {});
        if (!published) await this.files.removeEntry(name).catch(ignoreMissing);
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return { status: 405, headers: { allow: 'GET, HEAD, PUT' }, body: null };
    return this.serial(async () => {
      const row = await this.fileRow(backend, id, true);
      if (!row) throw new HttpError(404, 'Object bytes do not exist.');
      const file = await this.file(row), size = file.size, etag = `"${row.checksum}"`;
      const headers: Record<string, string> = { 'content-type': row.content_type, 'content-length': String(size),
        'accept-ranges': 'bytes', etag, 'content-md5': row.md5, 'cache-control': 'no-store' };
      const ifMatch = request.headers['if-match'];
      if (ifMatch && !matchesETag(ifMatch, etag, false)) {
        return { status: 412, headers: { ...headers, 'content-length': '0' }, body: null };
      }
      const ifNoneMatch = request.headers['if-none-match'];
      if (ifNoneMatch && matchesETag(ifNoneMatch, etag, true)) return { status: 304, headers, body: null };
      const range = request.headers.range;
      if (range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || !size || (!match[1] && !match[2])) return { status: 416, headers: { ...headers, 'content-range': `bytes */${size}`, 'content-length': '0' }, body: null };
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return { status: 416, headers: { ...headers, 'content-range': `bytes */${size}`, 'content-length': '0' }, body: null };
        headers['content-range'] = `bytes ${start}-${end}/${size}`; headers['content-length'] = String(end - start + 1);
        return { status: 206, headers, body: request.method === 'HEAD' ? null : file.slice(start, end + 1) };
      }
      return { status: 200, headers, body: request.method === 'HEAD' ? null : file };
    });
  }
}
function matchesETag(header: string, etag: string, weak: boolean): boolean {
  if (header.trim() === '*') return true;
  // A quoted tag may contain commas. Keep each opaque value intact.
  const tags = header.match(/(?:W\/)?"[^"]*"/g) ?? [];
  return tags.some(tag => tag === etag || (weak && tag === `W/${etag}`));
}
function ignoreMissing(error: unknown): void { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
function stringify(value: unknown): string { return JSON.stringify(value, (_, value) => typeof value === 'bigint' ? value.toString() : value); }
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function matches(template: string, path: string): boolean {
  return new RegExp(`^${template.split(/(\{[^}]+\})/).map(v => v.startsWith('{') ? (v === '{objectId}' || v === '{name}' ? '.+' : '[^/]+') : escape(v)).join('')}$`).test(path);
}
async function readBody(chunks: AsyncIterable<Uint8Array>, max: number): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true }); let body = '', size = 0;
  try {
    for await (const chunk of chunks) { size += chunk.byteLength; if (size > max) throw new HttpError(413, 'JSON request body is too large.'); body += decoder.decode(chunk, { stream: true }); }
    return body + decoder.decode();
  } catch (error) { if (error instanceof TypeError) throw new HttpError(400, 'JSON must be valid UTF-8.'); throw error; }
}
