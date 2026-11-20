import { apiConfigPath } from "./test-installation.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";
import { runCloudflareContract } from "./contract-host.ts";
import type { Bindings } from "./worker.ts";

const username = "contract-test";
const password = "local-contract-password-at-least-32-characters";
const server = createTestHarness({ workers: [{
  configPath: apiConfigPath,
  secrets: { BASIC_AUTH_USERNAME: username, BASIC_AUTH_PASSWORD: password, R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret" },
  vars: { WEBHOOK_ALLOWED_HOSTS: '["hooks.example.com"]' },
}] });
before(async () => { await server.listen(); });
after(async () => { await server.close(); });

test("Every TAMS 8.2 operation matches the contract with HTTP Basic", { timeout: 120_000 }, async t => {
  const api = server.getWorker<Bindings>("cf-tams-wasm");
  const { operations, remainingFlow } = await runCloudflareContract(api, "https://wasm.example", "Basic " + btoa(`${username}:${password}`));
  assert.ok(operations.length > 0);
  t.diagnostic(`${operations.length} operations covered (Basic): ${operations.join(", ")}`);
  // The adapter's create-only PUT relies on this R2 precondition.
  const env = await api.getEnv() as unknown as { MEDIA: R2Bucket };
  const createOnly = { onlyIf: { etagDoesNotMatch: "*" } };
  assert.ok(await env.MEDIA.put("contract/create-only", "first", createOnly));
  assert.equal(await env.MEDIA.put("contract/create-only", "second", createOnly), null);
  assert.equal((await api.fetch(`https://wasm.example/flows/${remainingFlow}`, { headers: { authorization: "Basic " + btoa(`${username}:${password}`) } })).status, 200);
});
