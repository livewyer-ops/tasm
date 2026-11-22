import { DurableObject } from "cloudflare:workers";
import { initSync, Tasm } from "../../pkg/cloudflare/tasm_cloudflare.js";
import module from "../../pkg/cloudflare/tasm_cloudflare_bg.wasm";
import openapi from "../../pkg/cloudflare/openapi.json";
import { migrateSchema } from "./migrations.ts";
import uuidSchema from "../../contracts/tams/api/schemas/uuid.json";
import type { Bindings } from "./worker.ts";
import { presign } from "./signing.ts";

initSync({ module });
const storageUuid = new RegExp(uuidSchema.pattern);

type Backend = { storage_id: string; bucket_name: string; label: string; default_storage: boolean; tags?: Record<string, string[]> };
type Transaction = { finish(): void; rollback(): void; promise: Promise<void> };
type HostPayload = { sql: string; params: SqlStorageValue[]; backend: string; id: string; source: string; destination: string; allocationId: string; method: string; presigned: boolean; contentType: string; allocations: { allocation_id: string; not_before: number }[]; webhook: { url: string; api_key_name?: string; api_key_value?: string }; payload_json: string; timeout: number };

function queueRetentionSeconds(value: Bindings["WORKER_QUEUE_RETENTION_SECONDS"]): number | undefined {
  if (value === undefined) return undefined;
  const seconds = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error("WORKER_QUEUE_RETENTION_SECONDS must be a non-negative whole number of seconds.");
  }
  return seconds;
}

/** A FIFO lock whose holder can step aside while it waits on unrelated I/O. */
class Lock {
  #held = false;
  readonly #waiting: (() => void)[] = [];
  async acquire(): Promise<void> {
    if (this.#held) await new Promise<void>(resolve => this.#waiting.push(resolve));
    else this.#held = true;
  }
  release(): void {
    const next = this.#waiting.shift();
    if (next) next(); else this.#held = false;
  }
}

export class WasmStore extends DurableObject<Bindings> {
  readonly #core: Tasm;
  readonly #backends: Map<string, Backend & { bucket: R2Bucket }>;
  #transaction?: Transaction;
  #closing?: Promise<void>;
  readonly #lock = new Lock();
  #polling = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const configured = JSON.parse(env.STORAGE_BACKENDS) as Record<string, Backend>;
    const entries = Object.entries(configured);
    for (const [, backend] of entries) if (typeof backend.storage_id === "string") backend.storage_id = backend.storage_id.toLowerCase();
    if (!entries.length || entries.filter(([, b]) => b.default_storage === true).length !== 1 ||
        ["storage_id", "bucket_name", "label"].some(field => new Set(entries.map(([, b]) => b[field as keyof Backend])).size !== entries.length) ||
        entries.some(([binding, b]) => !/^[A-Z][A-Z0-9_]*$/.test(binding) || !storageUuid.test(b.storage_id) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(b.bucket_name) || !b.label?.trim() || typeof b.default_storage !== "boolean" || !(env[binding as keyof Bindings] as R2Bucket)?.head)) {
      throw new Error("Invalid storage backend configuration");
    }
    const endpoint = new URL(env.R2_ENDPOINT);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error("Invalid R2 endpoint");
    this.#backends = new Map(entries.map(([binding, b]) => [b.storage_id, { ...b, bucket: env[binding as keyof Bindings] as R2Bucket }]));
    ctx.storage.transactionSync(() => {
      migrateSchema(ctx.storage.sql);
      for (const old of ctx.storage.sql.exec<{ id: string; bucket_name: string; endpoint_url: string }>("SELECT id,bucket_name,endpoint_url FROM tamoss_storage_backends").toArray()) {
        if (this.#backends.get(old.id)?.bucket_name !== old.bucket_name || old.endpoint_url !== endpoint.origin) throw new Error("Existing storage identities cannot be removed or remapped");
      }
      ctx.storage.sql.exec("UPDATE tamoss_storage_backends SET default_storage=0");
      for (const [, b] of entries) {
        const record = { id: b.storage_id, label: b.label, provider: "cloudflare", region: "auto", store_product: "r2", store_type: "http_object_store", default_storage: b.default_storage, bucket_name: b.bucket_name, endpoint_url: endpoint.origin, public_endpoint_url: null, tags: b.tags ?? {} };
        ctx.storage.sql.exec("INSERT INTO tamoss_storage_backends(id,label,provider,region,store_product,store_type,default_storage,bucket_name,endpoint_url,tags,record) VALUES(?,?,'cloudflare','auto','r2','http_object_store',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,default_storage=excluded.default_storage,tags=excluded.tags,record=excluded.record", b.storage_id, b.label, Number(b.default_storage), b.bucket_name, endpoint.origin, JSON.stringify(b.tags ?? {}), JSON.stringify(record));
      }
    });
    this.#core = new Tasm(async (operation: string, payload: string) => JSON.stringify(await this.#call(operation, JSON.parse(payload))), JSON.stringify({ webhook_allowed_hosts: JSON.parse(env.WEBHOOK_ALLOWED_HOSTS ?? "[]"), worker_queue_retention_seconds: queueRetentionSeconds(env.WORKER_QUEUE_RETENTION_SECONDS) }));
  }

  #key(allocation: string): string {
    if (!/^[0-9a-f]{32}$/.test(allocation)) throw new Error("Invalid allocation incarnation");
    return `wasm/${this.ctx.id}/${allocation}`;
  }

  #backend(id: string) {
    const backend = this.#backends.get(id);
    if (!backend) throw new Error("Unknown storage backend");
    return backend;
  }

  #allocation(id: string): string {
    return this.ctx.storage.sql.exec<{ allocation_id: string }>("SELECT allocation_id FROM tamoss_media_objects WHERE id=?", id).one().allocation_id;
  }

  async #call(operation: string, payload: HostPayload): Promise<unknown> {
    if (operation === "openapi") return openapi;
    if (operation === "sql") {
      const cursor = this.ctx.storage.sql.exec(payload.sql, ...payload.params);
      const rows = Array.from(cursor.raw());
      const affectedRows = this.ctx.storage.sql.exec<{ count: number }>("SELECT changes() AS count").one().count;
      return { rows, affectedRows };
    }
    if (operation === "transaction_check") {
      if (!this.#transaction) throw new Error("Metadata mutation requires a transaction");
      return null;
    }
    if (operation === "begin") {
      if (this.#transaction) throw new Error("Nested transaction");
      let finish!: () => void;
      let rollback!: () => void;
      let entered!: () => void;
      let failed!: (cause: unknown) => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const ready = new Promise<void>((resolve, reject) => { entered = resolve; failed = reject; });
      const promise = this.ctx.storage.transaction(async transaction => {
        rollback = () => transaction.rollback();
        entered();
        await done;
      });
      void promise.catch(failed);
      this.#transaction = { finish, rollback: () => rollback(), promise };
      await ready;
      return null;
    }
    if (operation === "commit" || operation === "rollback") { await this.#end(operation === "commit"); return null; }
    if (operation === "ready") {
      this.ctx.storage.sql.exec("SELECT 1");
      await Promise.all([...this.#backends.values()].map(b => b.bucket.head("__cf_tams_wasm_readiness__")));
      return null;
    }
    if (operation === "url") {
      const backend = this.#backend(payload.backend);
      const key = this.#key(this.#allocation(payload.id));
      const url = new URL(`/${backend.bucket_name}/${key}`, this.env.R2_ENDPOINT);
      if (!payload.presigned) return url.href;
      const headers: Record<string, string> = payload.method === "PUT" ? { "Content-Type": payload.contentType, "If-None-Match": "*" } : {};
      const signed = await presign(payload.method, url, this.env.R2_ACCESS_KEY_ID, this.env.R2_SECRET_ACCESS_KEY, this.#core.signedUrlLifetimeSeconds, headers);
      this.ctx.storage.sql.exec("UPDATE tamoss_media_objects SET access_expires_at=MAX(access_expires_at,?) WHERE id=?", Math.floor(Date.now()/1000)+3660, payload.id);
      return signed;
    }
    if (operation === "head") {
      const object = await this.#backend(payload.backend).bucket.head(this.#key(this.#allocation(payload.id)));
      if (!object) return null;
      return { size: object.size, contentType: object.httpMetadata?.contentType, etag: object.etag };
    }
    if (operation === "copy") {
      if (this.#allocation(payload.id) !== payload.allocationId) throw new Error("Stale object copy");
      const key = this.#key(payload.allocationId);
      const destination = this.#backend(payload.destination).bucket;
      this.ctx.storage.sql.exec("INSERT INTO wasm_r2_deletions VALUES(?,?,?) ON CONFLICT(backend,allocation_id) DO UPDATE SET not_before=MAX(not_before,excluded.not_before)", payload.destination, payload.allocationId, Math.floor(Date.now()/1000) + Number(this.#core.allocationLifetimeSeconds));
      await this.#outsideTransaction(async () => {
        const source = await this.#backend(payload.source).bucket.get(key);
        if (!source) throw new Error("Copy source is absent");
        try {
          const copied = await destination.put(key, source.body, { httpMetadata: source.httpMetadata, customMetadata: { ...source.customMetadata, cf_tams_source_etag: source.etag }, onlyIf: new Headers({ "If-None-Match": "*" }) });
          const stored = copied ?? await destination.head(key);
          if (!stored || stored.size !== source.size || (!copied && stored.customMetadata?.cf_tams_source_etag !== source.etag)) throw new Error("Copy destination differs from source");
        } finally { if (!source.body.locked) await source.body.cancel(); }
      });
      return null;
    }
    if (operation === "delete") {
      this.#backend(payload.backend);
      this.ctx.storage.transactionSync(() => {
        for (const allocation of payload.allocations) {
          this.#key(allocation.allocation_id);
          if (!Number.isSafeInteger(allocation.not_before)) throw new Error("Missing cleanup retention");
          this.ctx.storage.sql.exec("INSERT INTO wasm_r2_deletions VALUES(?,?,?) ON CONFLICT(backend,allocation_id) DO UPDATE SET not_before=MAX(not_before,excluded.not_before)", payload.backend, allocation.allocation_id, allocation.not_before);
        }
      });
      return null;
    }
    if (operation === "webhook") {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (payload.webhook.api_key_name && payload.webhook.api_key_value !== undefined) headers.set(payload.webhook.api_key_name, payload.webhook.api_key_value);
      headers.set("X-Tasm-Delivery-Id", payload.id);
      const send = async () => {
        const response = await fetch(payload.webhook.url, { method: "POST", headers, body: payload.payload_json, redirect: "manual", signal: AbortSignal.timeout(Math.min(10_000, payload.timeout*1000)) });
        await response.body?.cancel();
        return { status: response.status, reason: response.statusText };
      };
      return this.#outsideTransaction(send);
    }
    throw new Error("Unsupported host operation");
  }

  async #outsideTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#polling || this.#transaction) return operation();
    this.#lock.release();
    try { return await operation(); } finally { await this.#lock.acquire(); }
  }

  async #end(commit: boolean): Promise<void> {
    const transaction = this.#transaction;
    if (!transaction) { await this.#closing; return; }
    this.#transaction = undefined;
    this.#closing = transaction.promise;
    try {
      try { if (!commit) transaction.rollback(); }
      finally { transaction.finish(); }
      await transaction.promise;
    } finally { this.#closing = undefined; }
  }

  async #serial<T>(action: () => Promise<T>): Promise<T> {
    await this.#lock.acquire();
    try { return await action(); }
    finally {
      try { await this.#end(false); } finally { this.#lock.release(); }
    }
  }

  async #schedule(): Promise<void> {
    let next = Infinity;
    for (const table of ["tamoss_delete_requests", "tamoss_object_copies", "tamoss_object_cleanups"]) {
      const due = this.ctx.storage.sql.exec<{ due: number | null }>(`SELECT MIN(MAX(COALESCE(unixepoch(claim_expires_at),0),CASE WHEN status='error' THEN unixepoch(updated)+30 ELSE unixepoch() END)) AS due FROM ${table} WHERE status IN ('created','pending','started','error')`).one().due;
      if (due !== null) next = Math.min(next, due);
    }
    for (const query of [
      "SELECT MIN(MAX(COALESCE(unixepoch(next_attempt_at),0),COALESCE(unixepoch(claim_expires_at),0))) AS due FROM tamoss_webhook_deliveries WHERE status IN ('pending','started')",
      `SELECT MIN(unixepoch(created_at)+${this.#core.allocationLifetimeSeconds}) AS due FROM tamoss_media_objects WHERE json_array_length(referenced_by_flows)=0`,
      "SELECT MIN(not_before) AS due FROM wasm_r2_deletions",
    ]) {
      const due = this.ctx.storage.sql.exec<{ due: number | null }>(query).one().due;
      if (due !== null) next = Math.min(next, due);
    }
    let deadline = next * 1000;
    const retention = Number(this.#core.queueRetentionSeconds);
    if (retention > 0) {
      const oldest = this.ctx.storage.sql.exec<{ updated: string | null }>(`SELECT MIN(updated) AS updated FROM (
        SELECT MIN(updated_at) AS updated FROM tamoss_delete_requests WHERE status='done'
        UNION ALL SELECT MIN(updated_at) FROM tamoss_object_copies WHERE status='done'
        UNION ALL SELECT MIN(updated_at) FROM tamoss_object_cleanups WHERE status='done'
        UNION ALL SELECT MIN(updated_at) FROM tamoss_webhook_deliveries WHERE status IN ('done','dead')
      )`).one().updated;
      // Purges use updated_at < cutoff. SQLite's clock advances in milliseconds.
      if (oldest !== null) deadline = Math.min(deadline, Date.parse(oldest) + retention * 1000 + 1);
    }
    const current = await this.ctx.storage.getAlarm();
    if (Number.isFinite(deadline)) {
      const due = Math.max(Date.now() + 1000, deadline);
      if (current === null || due < current) await this.ctx.storage.setAlarm(due);
    } else if (current !== null) await this.ctx.storage.deleteAlarm();
  }

  async request(wire: string): Promise<string> {
    return this.#serial(async () => {
      const response = await this.#core.request(wire);
      await this.#end(false);
      await this.#schedule();
      return response;
    });
  }
  async alarm(): Promise<void> {
    await this.#serial(async () => {
      try {
        this.#polling = true;
        try { await this.#core.poll(); } finally { this.#polling = false; }
        await this.#purgeDeletions();
      } finally {
        // A failed poll must still leave an alarm for the remaining work.
        await this.#schedule();
      }
    });
  }
  async #purgeDeletions(): Promise<void> {
    const batches = this.ctx.storage.sql.exec<{ backend: string; allocations: string; unused: string }>(`
      WITH due AS (SELECT backend,allocation_id FROM wasm_r2_deletions WHERE not_before<=unixepoch() ORDER BY not_before LIMIT 100)
      SELECT backend,json_group_array(allocation_id) AS allocations,json_group_array(allocation_id) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM tamoss_media_objects m,json_each(m.record,'$.instances') i
        WHERE m.allocation_id=due.allocation_id AND i.value->>'controlled'=1 AND i.value->>'storage_backend_id'=due.backend
      )) AS unused FROM due GROUP BY backend`).toArray();
    for (const { backend, allocations, unused } of batches) {
      const keys = (JSON.parse(unused) as string[]).map(id => this.#key(id));
      if (keys.length) await this.#backend(backend).bucket.delete(keys);
      this.ctx.storage.sql.exec("DELETE FROM wasm_r2_deletions WHERE backend=? AND allocation_id IN (SELECT value FROM json_each(?))", backend, allocations);
    }
  }
  async fetch(): Promise<Response> { return Response.json({ type: "unauthorized", summary: "Use the authenticated Worker entrypoint.", time: new Date().toISOString() }, { status: 401 }); }
}
