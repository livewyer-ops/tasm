declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.sql" { const sql: string; export default sql; }
