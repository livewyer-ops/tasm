import type { PGlite, Transaction } from '@electric-sql/pglite';

/** Keep NUMERIC timestamps and BIGINT counts as text so Rust decodes them exactly. */
export const pgliteParsers = { 1700: (value: string) => value, 20: (value: string) => value };

type Param = { type: string; value: unknown };

/** The begin, commit, rollback and sql host operations the Rust core calls, run in order on one connection. */
export class SqlHost {
  private transaction?: Transaction;
  private finish?: (commit: boolean) => void;
  private completion?: Promise<void>;
  get inTransaction(): boolean { return !!this.transaction; }
  get connection(): PGlite | Transaction { return this.transaction ?? this.db; }
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: PGlite) {}

  /** Resolves once every queued statement has finished. */
  drained(): Promise<unknown> { return this.queue; }

  handles(op: string): boolean { return op === 'begin' || op === 'commit' || op === 'rollback' || op === 'sql' || op === 'transaction_check'; }

  call(op: string, p: { sql?: string; params?: Param[] }): Promise<unknown> {
    switch (op) {
      case 'begin': return this.run(async () => {
        if (this.transaction) throw new Error('Nested transaction');
        let finish!: (commit: boolean) => void;
        const decision = new Promise<boolean>(resolve => { finish = resolve; });
        await new Promise<void>((ready, failed) => {
          this.completion = this.db.transaction(async tx => {
            this.transaction = tx;
            this.finish = finish;
            ready();
            if (!await decision) await tx.rollback();
          });
          this.completion.catch(failed);
        });
        return null;
      });
      case 'transaction_check': return this.run(async () => {
        if (!this.transaction) throw new Error('Metadata mutation requires a transaction');
        return null;
      });
      case 'commit':
      case 'rollback': return this.run(async () => {
        if (!this.finish) {
          if (op === 'commit') throw new Error('No transaction to commit');
          return null;
        }
        this.finish(op === 'commit');
        try {
          await this.completion;
          // PGlite 0.5 executes COMMIT while its in-transaction flag is set.
          if (op === 'commit') await this.db.syncToFs();
        } finally {
          this.transaction = undefined;
          this.finish = undefined;
          this.completion = undefined;
        }
        return null;
      });
      case 'sql': return this.run(async () => {
        const params = p.params!;
        const sql = p.sql!.replace(/\$(\d+)\b/g, (_: string, n: string) => `$${n}::${params[Number(n) - 1].type}`);
        // Keep JSON text intact so integers inside JSONB survive until Rust decodes them.
        // Return rows by position: unaliased columns such as two MIN() calls share a name.
        const result = await this.connection.query<unknown[]>(sql, params.map(v => v.value), {
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
