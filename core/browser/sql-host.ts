import type { StorageBackend } from './public.d.ts';
import type { PGlite, Transaction } from '@electric-sql/pglite';

/** Keep NUMERIC timestamps and BIGINT counts as text so Rust decodes them exactly. */
export const pgliteParsers = { 1700: (value: string) => value, 20: (value: string) => value };

/** Creates the TAMS schema, the browser file table and the storage backends in a new database. */
export async function createSchema(db: PGlite, schema: string, backends: StorageBackend[]): Promise<void> {
  await db.transaction(async (tx: Transaction) => {
    await tx.exec(schema);
    await tx.exec(`CREATE TABLE tasm_schema (version integer PRIMARY KEY);
      INSERT INTO tasm_schema VALUES (1);
      CREATE TABLE tasm_files (backend uuid NOT NULL, object_id text NOT NULL, name text NOT NULL UNIQUE,
        incarnation text NOT NULL, size bigint NOT NULL, content_type text NOT NULL, checksum text NOT NULL,
        md5 text NOT NULL, PRIMARY KEY(backend, object_id));`);
    for (const [i, b] of backends.entries()) {
      await tx.query(`INSERT INTO tamoss_storage_backends
        (id,label,provider,region,store_product,store_type,default_storage,tags,record)
        VALUES ($1,$2,'browser','local','tasm-opfs','http_object_store',$3,$4,'{}')`, [b.id, b.label, i === 0, JSON.stringify(b.tags ?? {})]);
    }
  });
}

type Param = { type: string; value: unknown };

/** The begin, commit, rollback and sql host operations the Rust core calls, run in order on one connection. */
export class SqlHost {
  inTransaction = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: PGlite) {}

  /** Resolves once every queued statement has finished. */
  drained(): Promise<unknown> { return this.queue; }

  handles(op: string): boolean { return op === 'begin' || op === 'commit' || op === 'rollback' || op === 'sql'; }

  call(op: string, p: { sql?: string; params?: Param[] }): Promise<unknown> {
    switch (op) {
      case 'begin':
      case 'commit': return this.run(async () => {
        await this.db.exec(op === 'begin' ? 'BEGIN' : 'COMMIT');
        this.inTransaction = op === 'begin';
        return null;
      });
      case 'rollback': return this.run(async () => {
        if (this.inTransaction) await this.db.exec('ROLLBACK');
        this.inTransaction = false;
        return null;
      });
      case 'sql': return this.run(async () => {
        const params = p.params!;
        const sql = p.sql!.replace(/\$(\d+)\b/g, (_: string, n: string) => `$${n}::${params[Number(n) - 1].type}`);
        // Keep JSON text intact so integers inside JSONB survive until Rust decodes them.
        // Return rows by position: unaliased columns such as two MIN() calls share a name.
        const result = await this.db.query<unknown[]>(sql, params.map(v => v.value), {
          rowMode: 'array', parsers: { 114: (value: string) => value, 3802: (value: string) => value },
        });
        return { affectedRows: result.affectedRows ?? 0, rows: result.rows };
      });
      default: throw new Error(`Unknown SQL operation ${op}`);
    }
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
}
