export interface StorageBackend {
  id: string;
  label: string;
  tags?: Record<string, string | string[]>;
}
export interface TasmOptions {
  basePath?: string;
  /** Cancel startup, including pending store locks. */
  signal?: AbortSignal;
  /** Backend definitions are persisted on first initialisation. The first is the default. */
  backends?: StorageBackend[];
}
export interface TasmClient {
  apiUrl: string;
  close(): void;
  /** Exclusively stop this runtime. Keep other clients out until close() or page unload.
   * prepare runs only after exclusive access has been obtained. */
  shutdown(prepare?: () => Promise<void>): Promise<void>;
}
export function startTasm(options?: TasmOptions): Promise<TasmClient>;
