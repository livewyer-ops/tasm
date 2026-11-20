import { apiConfig as config, apiConfigPath, issuerConfigPath, checkMedia, verifier } from "./test-installation.ts";
import type { Bindings } from "./worker.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";
import { createAuth, ownerEmail, scopes } from "./auth/config.ts";

const server = createTestHarness({ workers: [
  { configPath: apiConfigPath, config: { ...config,
    services: [verifier],
    secrets: { required: [] },
    vars: { ...config.vars, AUTH_MODE: "oauth2", API_CORS: '{"origins":["http://localhost:3000"]}', R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret" },
  } },
  { configPath: issuerConfigPath, secrets: { BETTER_AUTH_SECRET: "local-auth-test-secret-at-least-32-characters" } },
] });
const api = server.getWorker<Bindings>("cf-tams-wasm-experiment");
const issuer = server.getWorker<Env>("cf-tams-auth");
let auth: ReturnType<typeof createAuth>;
let headers: Headers;
let env: Env;
before(async () => {
  await server.listen();
  await issuer.applyD1Migrations("DB");
  env = await issuer.getEnv();
  auth = createAuth(env);
  const owner = await auth.api.signUpEmail({ body: { email: ownerEmail, password: "local-owner-password-at-least-32-characters", name: "Test operator" }, returnHeaders: true });
  headers = new Headers({ cookie: owner.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ") });
  await auth.api.adminCreateOAuthResource({ headers, body: { identifier: env.TAMS_AUDIENCE, allowedScopes: scopes } });
});
after(async () => { await server.close(); });

async function token(scope: string) {
  const client = await auth.api.adminCreateOAuthClient({ headers, body: { client_name: "Wasm test", scope, client_credentials_scopes: [scope], grant_types: ["client_credentials"], token_endpoint_auth_method: "client_secret_basic" } });
  await auth.api.adminLinkClientResource({ headers, params: { identifier: env.TAMS_AUDIENCE, client_id: client.client_id } });
  const response = await issuer.fetch(`${env.AUTH_ISSUER}/api/auth/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(`${client.client_id}:${client.client_secret}`) }, body: "grant_type=client_credentials" });
  assert.equal(response.status, 200);
  return (await response.json() as { access_token: string }).access_token;
}

test("Paid OAuth identity and existing Workers integration checks", async () => {
  const reader = await token("tams-api/read");
  const get = await api.fetch("https://wasm.example/flows", { headers: { Authorization: "Bearer " + reader } });
  assert.equal(get.status, 200);
  const denied = await api.fetch("https://wasm.example/service", { method: "POST", headers: { Authorization: "Bearer " + reader, "Content-Type": "application/json" }, body: '{"name":"denied"}' });
  assert.equal(denied.status, 403);
  for (const authorization of ["Bearer malformed", "Basic " + btoa("test:password")]) {
    const invalid = await api.fetch("https://wasm.example/service", { headers: { authorization } });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get("WWW-Authenticate"), "Bearer");
  }
  const admin = await token("tams-api/admin");
  await checkMedia(api, "Bearer " + admin);
});
