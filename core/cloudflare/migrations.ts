import initialSchema from "./migrations/002.sql";
import collectionMembers from "./migrations/003.sql";
import retentionIndexes from "./migrations/004.sql";
import unfinishedCleanup from "./migrations/005.sql";
import allocationLeases from "./migrations/006.sql";

const revisions = [
  [2, initialSchema],
  [3, collectionMembers],
  [4, retentionIndexes],
  [5, unfinishedCleanup],
  [6, allocationLeases],
] as const;

// The caller holds the Durable Object storage transaction through backend registration.
export function migrateSchema(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS wasm_schema_versions (version INTEGER PRIMARY KEY)");
  const applied = sql.exec<{ version: number }>("SELECT version FROM wasm_schema_versions ORDER BY version").toArray().map(row => row.version);
  if (applied.some((version, i) => version !== revisions[i]?.[0])) {
    throw new Error(`Unsupported TASM database version: ${JSON.stringify(applied)}.`);
  }
  if (!applied.length && sql.exec(`SELECT 1 FROM sqlite_master WHERE type='table'
      AND (name GLOB 'tamoss_*' OR name GLOB 'wasm_*') AND name<>'wasm_schema_versions' LIMIT 1`).toArray().length) {
    throw new Error("Unsupported TASM database version: existing tables have no revision.");
  }
  for (const [version, statements] of revisions.slice(applied.length)) {
    sql.exec(statements);
    if (version === 2 && sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_metadata'").toArray().length) {
      sql.exec("INSERT OR IGNORE INTO tamoss_service_metadata(id,name,description) SELECT id,name,description FROM service_metadata");
    }
    sql.exec("INSERT INTO wasm_schema_versions(version) VALUES (?)", version);
  }
}
