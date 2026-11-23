import initialSchema from "./migrations/007.sql";

const baseline = 7;
const migrations: readonly string[] = [];

// The caller holds the Durable Object storage transaction through backend registration.
export function migrateSchema(sql: SqlStorage, updates = migrations): void {
  sql.exec("CREATE TABLE IF NOT EXISTS wasm_schema_versions (version INTEGER PRIMARY KEY)");
  const applied = sql.exec<{ version: number }>("SELECT version FROM wasm_schema_versions ORDER BY version").toArray().map(row => row.version);
  const revisions = [initialSchema, ...updates];
  if (applied.length > revisions.length || applied.some((version, i) => version !== baseline + i)) {
    throw new Error(`Unsupported TASM database version: ${JSON.stringify(applied)}.`);
  }
  if (!applied.length && sql.exec(`SELECT 1 FROM sqlite_master WHERE type='table'
      AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*' AND name<>'wasm_schema_versions' LIMIT 1`).toArray().length) {
    throw new Error("Unsupported TASM database version: existing tables have no revision.");
  }
  for (let i = applied.length; i < revisions.length; i++) {
    sql.exec(revisions[i]);
    sql.exec("INSERT INTO wasm_schema_versions(version) VALUES (?)", baseline + i);
  }
}
