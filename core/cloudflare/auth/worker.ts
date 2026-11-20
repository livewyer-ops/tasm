import { WorkerEntrypoint } from "cloudflare:workers";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { createAuth } from "./config.ts";

const instances = new WeakMap<Env, ReturnType<typeof createAuth>>();
const verifiers = new WeakMap<Env, ReturnType<typeof createRemoteJWKSet>>();

function authFor(env: Env) {
  let auth = instances.get(env);
  if (!auth) {
    auth = createAuth(env);
    instances.set(env, auth);
  }
  return auth;
}

export class TokenVerifier extends WorkerEntrypoint<Env> {
  async verify(token: string): Promise<string | null> {
    if (typeof token !== "string" || token.length > 16384) return null;
    let keys = verifiers.get(this.env);
    if (!keys) {
      keys = createRemoteJWKSet(new URL("/api/auth/jwks", this.env.AUTH_ISSUER), {
        cacheMaxAge: 300000,
        cooldownDuration: 30000,
        [customFetch]: async (url, options) => authFor(this.env).handler(new Request(url, options)),
      });
      verifiers.set(this.env, keys);
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: this.env.AUTH_ISSUER,
        audience: this.env.TAMS_AUDIENCE,
        algorithms: ["RS256"],
        typ: "at+jwt",
        requiredClaims: ["sub", "client_id", "scope", "iat", "exp"],
        maxTokenAge: 900,
        clockTolerance: 30,
      });
      if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 512 ||
          payload.client_id !== payload.sub || typeof payload.scope !== "string" ||
          payload.scope.length > 4096) return null;
      return JSON.stringify({ subject: payload.sub, scopes: payload.scope.split(" ").filter(Boolean) });
    } catch (error) {
      if (error instanceof errors.JWTExpired || error instanceof errors.JWTClaimValidationFailed ||
          error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid ||
          error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSENotSupported ||
          error instanceof errors.JWKSNoMatchingKey) return null;
      throw new Error("Token verification unavailable");
    }
  }
}

const publicGetPaths = new Set([
  "/api/auth/jwks",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
]);
const tokenPath = "/api/auth/oauth2/token";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const origin = request.headers.get("Origin");
    const origins: string[] = JSON.parse(env.CORS_ORIGINS);
    const allowed = !!origin && (origins.includes(origin) || origins.includes("*"));
    const headers = new Headers({ "Cache-Control": "no-store", "Vary": "Origin" });
    if (allowed) {
      headers.set("Access-Control-Allow-Origin", origin!);
      headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Retry-After");
    }
    const finish = (response: Response) => {
      const result = new Response(response.body, response);
      headers.forEach((value, key) => result.headers.set(key, value));
      return result;
    };
    if (path !== tokenPath && !publicGetPaths.has(path)) return finish(new Response(null, { status: 404 }));
    if (request.method === "OPTIONS") {
      const method = request.headers.get("Access-Control-Request-Method");
      const requested = (request.headers.get("Access-Control-Request-Headers") ?? "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
      if (!allowed || method !== (path === tokenPath ? "POST" : "GET") ||
          requested.some(x => !["authorization", "content-type"].includes(x))) {
        return finish(new Response(null, { status: 403 }));
      }
      headers.set("Access-Control-Allow-Methods", path === tokenPath ? "POST" : "GET");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      headers.set("Access-Control-Max-Age", "3600");
      return finish(new Response(null, { status: 204 }));
    }
    if (origin && !allowed) return finish(new Response(null, { status: 403 }));
    if (request.method !== (path === tokenPath ? "POST" : "GET")) {
      return finish(new Response(null, { status: 405, headers: { Allow: path === tokenPath ? "POST, OPTIONS" : "GET, OPTIONS" } }));
    }
    try {
      if (path === tokenPath) {
        const limit = await env.TOKEN_RATE_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "local" });
        if (!limit.success) return finish(Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { "Retry-After": "60" } }));
        if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") {
          return finish(Response.json({ error: "invalid_request" }, { status: 415 }));
        }
        const reader = request.body?.getReader();
        const chunks: ArrayBuffer[] = [];
        let size = 0;
        if (reader) {
          const deadline = AbortSignal.timeout(10000);
          const cancel = () => { void reader.cancel().catch(() => {}); };
          deadline.addEventListener("abort", cancel, { once: true });
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (deadline.aborted) return finish(Response.json({ error: "invalid_request" }, { status: 408 }));
              if (done) break;
              size += value.byteLength;
              if (size > 16384) {
                await reader.cancel();
                return finish(Response.json({ error: "invalid_request" }, { status: 413 }));
              }
              chunks.push(value.slice().buffer);
            }
          } finally {
            deadline.removeEventListener("abort", cancel);
            reader.releaseLock();
          }
        }
        request = new Request(request, { body: new Blob(chunks) });
      }
      const auth = authFor(env);
      const response = path.startsWith("/.well-known/")
        ? await oauthProviderAuthServerMetadata(auth)(request)
        : await auth.handler(request);
      console.log(JSON.stringify({ event: "oauth_request", path, status: response.status, ray: request.headers.get("CF-Ray") }));
      return finish(response);
    } catch {
      console.error(JSON.stringify({ event: "oauth_unavailable", path, ray: request.headers.get("CF-Ray") }));
      return finish(Response.json({ error: "temporarily_unavailable" }, { status: 503 }));
    }
  },
} satisfies ExportedHandler<Env>;
