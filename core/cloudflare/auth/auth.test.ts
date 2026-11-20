import { apiConfig, apiConfigPath, issuerConfigPath, verifier as verifierBinding, checkMedia } from "../test-installation.ts";
import type { Bindings } from "../worker.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAuth, ownerEmail, scopes } from "./config.ts";

const basicUsername = "demo-operator";
const basicPassword = "local-basic-test-password-at-least-32-characters";
const basicHeader = "Basic " + btoa(`${basicUsername}:${basicPassword}`);
const server = createTestHarness({ workers: [
  { configPath: apiConfigPath, config: { ...apiConfig, services: [verifierBinding] }, secrets: { R2_ACCESS_KEY_ID: "local-access-key", R2_SECRET_ACCESS_KEY: "local-secret-key", BASIC_AUTH_USERNAME: basicUsername, BASIC_AUTH_PASSWORD: basicPassword }, vars: { AUTH_MODE: "oauth2", API_CORS: '{"origins":["http://localhost:3000"]}' } },
  { configPath: issuerConfigPath, secrets: { BETTER_AUTH_SECRET: "local-auth-test-secret-at-least-32-characters" } },
] });
const issuer = server.getWorker<Env>("cf-tams-auth");
const api = server.getWorker<Bindings & { AUTH: { verify(token: string): Promise<string | null> } }>("cf-tams-wasm-experiment");
let env: Env;
let auth: ReturnType<typeof createAuth>;
let ownerHeaders: Headers;

before(async () => {
  await server.listen();
  await issuer.applyD1Migrations("DB");
  env = await issuer.getEnv();
  auth = createAuth(env);
  const owner = await auth.api.signUpEmail({ body: { email: ownerEmail, password: "owner-password-only-for-local-tests-123", name: "Test operator" }, returnHeaders: true });
  ownerHeaders = new Headers({ cookie: owner.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ") });
  await auth.api.adminCreateOAuthResource({ headers: ownerHeaders, body: { identifier: env.TAMS_AUDIENCE, allowedScopes: scopes } });
});
after(async () => { await server.close(); });

async function createClient(scope = "tams-api/read", method = "client_secret_basic") {
  const client = await auth.api.adminCreateOAuthClient({ headers: ownerHeaders, body: {
    client_name: "test-client", scope, client_credentials_scopes: scope.split(" "),
    grant_types: ["client_credentials"], token_endpoint_auth_method: method,
  } });
  await auth.api.adminLinkClientResource({ headers: ownerHeaders, params: { identifier: env.TAMS_AUDIENCE, client_id: client.client_id } });
  return client;
}

async function issue(client: { client_id: string; client_secret?: string }, fields: Record<string, string> = {}, method = "client_secret_basic") {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost:3000" });
  const body = new URLSearchParams({ grant_type: "client_credentials", ...fields });
  if (method === "client_secret_basic") headers.set("Authorization", "Basic " + btoa(`${client.client_id}:${client.client_secret}`));
  else { body.set("client_id", client.client_id); body.set("client_secret", client.client_secret!); }
  return issuer.fetch(`${env.AUTH_ISSUER}/api/auth/oauth2/token`, { method: "POST", headers: Object.fromEntries(headers), body });
}

test("OAuth issuance, permissions, rotation and failure handling", async (t) => {
  const client = await createClient();
  const first = await issue(client);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(first.headers.get("cache-control"), "no-store");
  const token = await first.json() as { access_token: string; expires_in: number; token_type: string };
  assert.equal(token.expires_in, 900);
  const claims = decodeJwt(token.access_token);
  assert.equal(claims.iss, env.AUTH_ISSUER);
  assert.equal(claims.aud, env.TAMS_AUDIENCE);
  assert.equal(claims.scope, "tams-api/read");
  assert.equal(claims.sub, client.client_id);
  const headers = { Authorization: `Bearer ${token.access_token}`, Origin: "http://localhost:3000" };
  const verifier = (await api.getEnv()).AUTH;

  await t.test("API ingress, Durable Object RPC and CORS", async () => {
    assert.equal((await api.fetch("http://localhost/healthz")).status, 200);
    assert.equal((await api.fetch("http://localhost/service")).status, 401);
    assert.equal((await api.fetch("http://localhost/service", { headers: { Authorization: basicHeader } })).status, 401);
    const response = await api.fetch("http://localhost/service", { headers });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await api.fetch("http://localhost/readyz", { headers })).status, 200);
    const denied = await api.fetch("http://localhost/service", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.match(denied.headers.get("www-authenticate")!, /insufficient_scope/);
    assert.equal((await api.fetch("http://localhost/service", { headers: { "X-Auth-Subject": "admin", "X-Auth-Scopes": "tams-api/admin" } })).status, 401);
    assert.equal((await verifier.verify(token.access_token)) !== null, true);
  });

  await t.test("Client methods, scope limits and public endpoint restrictions", async () => {
    assert.equal((await issue(client, { scope: "tams-api/admin" })).status, 400);
    assert.equal((await issue({ ...client, client_secret: "incorrect" })).status, 401);
    assert.equal((await issue(client, {}, "client_secret_post")).status, 400);
    const posted = await createClient("tams-api/read", "client_secret_post");
    assert.equal((await issue(posted, {}, "client_secret_post")).status, 200);
    assert.equal((await issue(client, { resource: env.TAMS_AUDIENCE })).status, 200);
    assert.equal((await issue(client, { resource: "https://wrong.example" })).status, 400);
    assert.equal((await issue(client, { grant_type: "password" })).status, 400);
    for (const path of ["/sign-up/email", "/sign-in/email", "/oauth2/register", "/admin/oauth2/create-client", "/sign-jwt", "/token"]) {
      assert.equal((await issuer.fetch(`${env.AUTH_ISSUER}/api/auth${path}`, { method: "POST", body: "{}" })).status, 404);
    }
    const preflight = await issuer.fetch(`${env.AUTH_ISSUER}/api/auth/oauth2/token`, { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
    assert.equal(preflight.status, 204);
    assert.equal((await issuer.fetch(`${env.AUTH_ISSUER}/api/auth/oauth2/token`, { method: "OPTIONS", headers: { Origin: "https://untrusted.example", "Access-Control-Request-Method": "POST" } })).status, 403);
    const metadata = await issuer.fetch(`${env.AUTH_ISSUER}/.well-known/oauth-authorization-server`);
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json() as { issuer: string }).issuer, env.AUTH_ISSUER);
    const oversized = await issuer.fetch(`${env.AUTH_ISSUER}/api/auth/oauth2/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x".repeat(17000),
    });
    assert.equal(oversized.status, 413);
  });

  await t.test("Hashed secrets and disabling new issuance", async () => {
    const stored = await env.DB.prepare('SELECT "clientSecret" FROM "oauthClient" WHERE "clientId" = ?').bind(client.client_id).first<{ clientSecret: string }>();
    assert.notEqual(stored!.clientSecret, client.client_secret);
    const rotated = await auth.api.rotateClientSecret({ headers: ownerHeaders, body: { client_id: client.client_id } });
    assert.equal((await issue(client)).status, 401);
    assert.equal((await issue(rotated)).status, 200);
    await auth.api.adminUpdateOAuthClient({ headers: ownerHeaders, body: { client_id: client.client_id, update: { client_credentials_scopes: [] } } });
    assert.equal((await issue(rotated)).status, 400);
    assert.notEqual(await verifier.verify(token.access_token), null);
  });

  await t.test("Existing Workers media integration with an OAuth administrator", async () => {
    const admin = await createClient("tams-api/admin");
    const response = await issue(admin);
    assert.equal(response.status, 200);
    const { access_token } = await response.json() as { access_token: string };
    await checkMedia(api, "Bearer " + access_token);
  });

  await t.test("Invalid and expired JWTs, key refresh and outage", async () => {
    const oldKid = decodeProtectedHeader(token.access_token).kid!;
    await env.DB.prepare('UPDATE "jwks" SET "expiresAt" = ? WHERE "id" = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), oldKid).run();
    const rotatedClient = await createClient();
    const rotatedResponse = await issue(rotatedClient);
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json() as { access_token: string };
    assert.notEqual(decodeProtectedHeader(rotated.access_token).kid, oldKid);
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const key = await exportJWK(publicKey);
    const kid = "test-validation-key";
    await env.DB.prepare('INSERT INTO "jwks" ("id", "publicKey", "privateKey", "createdAt", "alg") VALUES (?, ?, ?, ?, ?)')
      .bind(kid, JSON.stringify(key), "unused-test-key", "2000-01-01T00:00:00.000Z", "RS256").run();
    // Eviction is simulated by reloading Worker isolates without changing D1 state.
    await server.update(options => options);
    env = await issuer.getEnv();
    const freshVerifier = (await api.getEnv()).AUTH;
    assert.notEqual(await freshVerifier.verify(rotated.access_token), null);
    assert.notEqual(await freshVerifier.verify(token.access_token), null);
    const now = Math.floor(Date.now() / 1000);
    const sign = (patch: Record<string, unknown> = {}, typ = "at+jwt") => new SignJWT({ ...claims, iat: now, exp: now + 900, ...patch }).setProtectedHeader({ alg: "RS256", kid, typ }).sign(privateKey);
    assert.notEqual(await freshVerifier.verify(await sign()), null);
    for (const patch of [{ exp: now - 60 }, { iss: "https://wrong.example" }, { aud: "https://wrong.example" }, { nbf: now + 600 }, { iat: now + 600 }, { sub: "another-client" }]) {
      assert.equal(await freshVerifier.verify(await sign(patch)), null);
    }
    assert.equal(await freshVerifier.verify(await sign({}, "JWT")), null);
    assert.equal(await freshVerifier.verify("malformed"), null);
    // Algorithm confusion and a token without a kid are rejections, not outages.
    const hmac = new TextEncoder().encode("a-shared-secret-of-at-least-32-bytes");
    const unsigned = (header: Record<string, unknown>) =>
      [header, { ...claims, iat: now, exp: now + 900 }].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".";
    assert.equal(await freshVerifier.verify(await new SignJWT({ ...claims, iat: now, exp: now + 900 }).setProtectedHeader({ alg: "HS256", kid, typ: "at+jwt" }).sign(hmac)), null);
    assert.equal(await freshVerifier.verify(unsigned({ alg: "none", kid, typ: "at+jwt" })), null);
    assert.equal(await freshVerifier.verify(await new SignJWT({ ...claims, iat: now, exp: now + 900 }).setProtectedHeader({ alg: "RS256", typ: "at+jwt" }).sign(privateKey)), null);
    const confused = await api.fetch("http://localhost/service", { headers: { Origin: headers.Origin, Authorization: `Bearer ${unsigned({ alg: "HS256", typ: "at+jwt" })}` } });
    assert.equal(confused.status, 401);
    const forged = token.access_token.slice(0, -12) + "aaaaaaaaaaaa";
    assert.equal(await freshVerifier.verify(forged), null);
    const signing = await env.DB.prepare('SELECT "privateKey" FROM "jwks" WHERE "id" = ?').bind(decodeProtectedHeader(token.access_token).kid).first<{ privateKey: string }>();
    assert.equal(signing!.privateKey.includes('"kty"'), false);
    let limited = false;
    // The limit is 60 per fixed 60 s window; allow for one window reset mid-loop.
    for (let attempt = 0; attempt < 130; attempt++) {
      const response = await issue({ ...client, client_secret: "wrong" });
      if (response.status === 429) {
        assert.equal(response.headers.get("retry-after"), "60");
        assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
    await env.DB.prepare('DROP TABLE "jwks"').run();
    await server.update(options => options);
    const unavailable = await api.fetch("http://localhost/service", { headers });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });

  await t.test("Basic profile without an OAuth Worker, credential rotation and media", async () => {
    const base = apiConfig;
    const config = {
      ...base,
      services: [],
      secrets: { required: [] },
      vars: {
        ...base.vars,
        AUTH_MODE: "basic",
        BASIC_AUTH_USERNAME: basicUsername,
        BASIC_AUTH_PASSWORD: basicPassword,
        R2_ACCESS_KEY_ID: "local-access-key",
        R2_SECRET_ACCESS_KEY: "local-secret-key",
        API_CORS: '{"origins":["http://localhost:3000"]}',
      },
    };
    const server = createTestHarness({ workers: [{ configPath: apiConfigPath, config: structuredClone(config) }] });
    const api = server.getWorker<Bindings>("cf-tams-wasm-experiment");
    t.after(async () => { await server.close(); });
    await server.listen();
    assert.equal((await api.getEnv()).AUTH, undefined);
    assert.equal((await api.fetch("http://localhost/healthz")).status, 200);
    for (const authorization of ["", "Bearer " + token.access_token, "Basic !invalid!", "Basic " + btoa(`${basicUsername}:incorrect`), "Basic " + "a".repeat(8193)]) {
      const denied = await api.fetch("http://localhost/service", { headers: { Authorization: authorization, Origin: "http://localhost:3000", "X-Auth-Subject": "admin", "X-Auth-Scopes": "tams-api/admin" } });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("www-authenticate"), 'Basic realm="cf-tams", charset="UTF-8"');
      assert.equal(denied.headers.get("access-control-allow-origin"), "http://localhost:3000");
    }
    assert.equal((await api.fetch("http://insecure.example/service", { headers: { Authorization: basicHeader } })).status, 403);
    assert.equal((await api.fetch("https://secure.example/service", { headers: { Authorization: basicHeader } })).status, 200);
    assert.equal((await api.fetch("http://localhost/readyz", { headers: { Authorization: basicHeader } })).status, 200);
    await checkMedia(api, basicHeader);
    for (const vars of [{ ...config.vars, BASIC_AUTH_PASSWORD: "" }, { ...config.vars, AUTH_MODE: "invalid" }]) {
      await server.update({ workers: [{ configPath: apiConfigPath, config: structuredClone({ ...config, vars }) }] });
      assert.equal((await api.fetch("http://localhost/service", { headers: { Authorization: basicHeader } })).status, 503);
    }
    const replacement = basicPassword + "-rotated";
    await server.update({ workers: [{ configPath: apiConfigPath, config: structuredClone({ ...config, vars: { ...config.vars, BASIC_AUTH_PASSWORD: replacement } }) }] });
    assert.equal((await api.fetch("http://localhost/service", { headers: { Authorization: basicHeader } })).status, 401);
    assert.equal((await api.fetch("http://localhost/service", { headers: { Authorization: "Basic " + btoa(`${basicUsername}:${replacement}`) } })).status, 200);
  });
});
