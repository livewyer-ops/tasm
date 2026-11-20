import type { WasmStore } from "./store.ts";
import { cors } from "./cors.ts";
export { WasmStore } from "./store.ts";

export interface Bindings {
  STORE: DurableObjectNamespace<WasmStore>;
  STORE_ID: string;
  AUTH_MODE: "basic" | "oauth2";
  ANONYMOUS_READ?: string;
  API_CORS: string;
  AUTH?: { verify(token: string): Promise<string | null> };
  STORAGE_BACKENDS: string;
  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  WEBHOOK_ALLOWED_HOSTS?: string;
  MEDIA: R2Bucket;
  MEDIA_SECONDARY: R2Bucket;
  BASIC_AUTH_USERNAME: string;
  BASIC_AUTH_PASSWORD: string;
}

const maximumBodyBytes = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const challenge = 'Basic realm="cf-tams", charset="UTF-8"';

function error(status: number, type: string, summary: string, scheme = challenge): Response {
  return Response.json({ type, summary, time: new Date().toISOString() }, {
    status,
    headers: status === 401 ? { "WWW-Authenticate": scheme } : {},
  });
}

function authorised(request: Request, env: Bindings): boolean {
  const username = env.BASIC_AUTH_USERNAME;
  const password = env.BASIC_AUTH_PASSWORD;
  if (typeof username !== "string" || typeof password !== "string" ||
      [...username].length < 1 || [...username].length > 128 || username.includes(":") ||
      [...password].length < 32 || [...password].length > 1024 || /[\x00-\x1f\x7f]/.test(username + password)) {
    throw new Error("Invalid Basic configuration");
  }
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match || match[1].length > 8192 || match[1].length % 4 !== 0) return false;
  let supplied: Uint8Array;
  try { supplied = Uint8Array.from(atob(match[1]), c => c.charCodeAt(0)); }
  catch { return false; }
  const expected = encoder.encode(`${username}:${password}`);
  return supplied.length === expected.length && crypto.subtle.timingSafeEqual(supplied, expected);
}

async function boundedBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(error(408, "request_timeout", "Request body was not received within 30 seconds."));
    }, 30_000);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBodyBytes) {
        void reader.cancel().catch(() => {});
        throw error(413, "payload_too_large", "Request body exceeds 4 MiB.");
      }
      chunks.push(result.value);
    }
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
  catch { throw error(400, "bad_request", "Invalid UTF-8 request body."); }
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && ["GET", "HEAD"].includes(request.method)) {
      return new Response(request.method === "HEAD" ? null : "ok");
    }
    let policy: ReturnType<typeof cors>;
    try { policy = cors(env.API_CORS, request); }
    catch { return error(503, "configuration_error", "CORS is not configured correctly."); }
    if (policy.preflight) return policy.preflight;
    return policy.apply(await authenticated(request, env));
  },
} satisfies ExportedHandler<Bindings>;

async function authenticated(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return error(403, "forbidden", "Authentication requires HTTPS.");
    let actor: { subject: string; scopes: string[] } | undefined;
    const scheme = env.AUTH_MODE === "oauth2" ? "Bearer" : challenge;
    try {
      if (![undefined, "false", "true"].includes(env.ANONYMOUS_READ)) throw new Error("Invalid anonymous read configuration");
      if (env.AUTH_MODE === "basic") {
        if (authorised(request, env)) actor = { subject: env.BASIC_AUTH_USERNAME, scopes: ["tams-api/admin"] };
      } else if (env.AUTH_MODE === "oauth2") {
        if (!env.AUTH) throw new Error("OAuth verifier is missing");
        const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("Authorization") ?? "");
        if (match && match[1].length <= 16384) {
          let timer: ReturnType<typeof setTimeout>;
          try {
            const identity = await Promise.race([env.AUTH.verify(match[1]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Verifier timeout")), 10_000); })]);
            if (identity) {
              const value = JSON.parse(identity);
              if (typeof value.subject !== "string" || !value.subject || !Array.isArray(value.scopes) || value.scopes.some((scope: unknown) => typeof scope !== "string")) throw new Error("Invalid identity");
              actor = value;
            }
          } finally { clearTimeout(timer!); }
        }
      } else { throw new Error("Invalid authentication mode"); }
    } catch { return error(503, "configuration_error", "Authentication is unavailable."); }
    if (!actor && env.ANONYMOUS_READ === "true" && !request.headers.has("Authorization") && ["GET", "HEAD"].includes(request.method)) {
      actor = { subject: "anonymous", scopes: ["tams-api/read"] };
    }
    if (!actor) return error(401, "unauthorized", "Valid authentication credentials are required.", scheme);
    try {
      const wire = JSON.stringify({
        method: request.method, url: request.url,
        headers: { "content-type": request.headers.get("content-type") ?? "" },
        body: await boundedBody(request),
        actor,
      });
      const result = JSON.parse(await env.STORE.getByName(env.STORE_ID).request(wire));
      const headers = new Headers(result.headers);
      if (env.AUTH_MODE !== "oauth2") headers.delete("WWW-Authenticate");
      return new Response(request.method === "HEAD" ? null : result.body, { status: result.status, headers });
    } catch (cause) {
      if (cause instanceof Response) return cause;
      return error(500, "internal_server_error", "The store could not complete the request.");
    }
}
