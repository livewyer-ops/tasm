import type { PGlite } from '@electric-sql/pglite';
import type { StorageBackend } from './public.d.ts';
import initialSchema from './migrations/003.sql';

const baseline = 3;
const migrations: readonly string[] = [];

export async function migrateSchema(db: PGlite, backends: StorageBackend[], updates = migrations): Promise<void> {
  await db.transaction(async tx => {
    const { rows: [schema] } = await tx.query<{ present: boolean }>("SELECT to_regclass('tasm_schema') IS NOT NULL AS present");
    let version: number;
    if (schema.present) {
      const { rows } = await tx.query<{ version: number }>('SELECT version FROM tasm_schema');
      if (rows.length !== 1 || !Number.isInteger(rows[0].version) || rows[0].version < baseline || rows[0].version > baseline + updates.length) {
        throw new Error(`Unsupported TASM database version: ${JSON.stringify(rows.map(row => row.version))}.`);
      }
      version = rows[0].version;
    } else {
      if ((await tx.query("SELECT 1 FROM pg_tables WHERE schemaname='public' LIMIT 1")).rows.length) {
        throw new Error('Unsupported TASM database version: existing tables have no revision.');
      }
      await tx.exec(initialSchema);
      for (const [i, backend] of backends.entries()) {
        await tx.query(`INSERT INTO tamoss_storage_backends
          (id,label,provider,region,store_product,store_type,default_storage,tags,record)
          VALUES ($1,$2,'browser','local','tasm-opfs','http_object_store',$3,$4,'{}')`,
          [backend.id, backend.label, i === 0, JSON.stringify(backend.tags ?? {})]);
      }
      version = baseline;
      await tx.query('INSERT INTO tasm_schema VALUES ($1)', [version]);
    }
    for (let next = version + 1; next <= baseline + updates.length; next++) {
      await tx.exec(updates[next - baseline - 1]);
      await tx.query('UPDATE tasm_schema SET version=$1', [next]);
    }
  });
}
