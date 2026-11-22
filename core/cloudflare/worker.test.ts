import { apiConfig, apiConfigPath } from "./test-installation.ts";
import assert from "node:assert/strict";
import { checkLegacyRanges } from "../../tests/contract/legacy-ranges.ts";
import { checkUuidFilters } from "../../tests/contract/uuid-filters.ts";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WasmStore } from "./store.ts";
import { after, before, test } from "node:test";
import { ReadableStream } from "node:stream/web";
import { createTestHarness } from "wrangler";
import type { Bindings } from "./worker.ts";

const username = "wasm-test";
const password = "local-test-password-at-least-32-characters";
const authorization = "Basic " + btoa(`${username}:${password}`);
const server = createTestHarness({ workers: [{
  configPath: apiConfigPath,
  secrets: { BASIC_AUTH_USERNAME: username, BASIC_AUTH_PASSWORD: password, R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret" },
  vars: { API_CORS: '{"origins":["https://client.example"]}', WEBHOOK_ALLOWED_HOSTS: '["hooks.example.com","*.example.net"]' },
}] });
const api = server.getWorker<Bindings>("cf-tams-wasm");
const origin = "https://wasm.example";
type RequestOptions = NonNullable<Parameters<typeof api.fetch>[1]>;
const request = (path: string, init: Omit<RequestOptions, "headers"> & { headers?: Record<string, string>; duplex?: "half" } = {}) => api.fetch(origin + path, {
  ...init, headers: { authorization, "content-type": "application/json", ...init.headers },
});
before(async () => { await server.listen(); });
after(async () => { await server.close(); });

test("Authenticated Rust service with native SQLite and R2", async t => {
  await t.test("HTTP Basic fails closed and health remains public", async () => {
    assert.equal((await api.fetch(origin + "/healthz")).status, 200);
    for (const value of ["", "Bearer token", "Basic !!!!", "Basic " + btoa(username + ":wrong")]) {
      const response = await api.fetch(origin + "/service", { headers: { authorization: value } });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("WWW-Authenticate")!, /^Basic /);
    }
    assert.equal((await api.fetch("http://wasm.example/service", { headers: { authorization } })).status, 403);
  });

  await t.test("Service metadata validates, persists after reload and supports HEAD", async () => {
    const original = await (await request("/service")).json() as Record<string, unknown>;
    assert.equal(original.api_version, "8.2");
    assert.match(String(original.type), /^urn:x-tams:service/);
    assert.deepEqual(original.event_stream_mechanisms, [{ name: "webhooks" }]);
    assert.equal((await request("/service", { method: "POST", body: JSON.stringify({ name: "Rust service", description: "SQLite metadata" }) })).status, 200);
    await server.update(options => options);
    const stored = await (await request("/service")).json() as Record<string, unknown>;
    assert.equal(stored.name, "Rust service");
    assert.equal(stored.description, "SQLite metadata");
    const head = await request("/service", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    for (const body of ['{"name":null}', '{"name":12}', "[]", "{broken"]) {
      const invalid = await request("/service", { method: "POST", body });
      assert.equal(invalid.status, 400);
      assert.equal(typeof (await invalid.json() as { summary: string }).summary, "string");
    }
    assert.equal((await (await request("/service")).json() as Record<string, unknown>).name, "Rust service");
    assert.equal((await request("/service", { method: "POST", body: '{}', headers: { "content-type": "text/plain" } })).status, 400);
    assert.equal((await request("/service?unexpected=true")).status, 400);
    assert.equal((await request("/service", { method: "POST", body: '{"extension":true}' })).status, 200);
    const retained = await (await request("/service")).json() as Record<string, unknown>;
    assert.equal(retained.name, "Rust service");
    assert.equal(retained.description, "SQLite metadata");
    assert.equal((await request("/flows")).status, 200);
    const unsupported = await request("/service", { method: "PUT", body: "{}" });
    assert.equal(unsupported.status, 405);
    assert.equal((await unsupported.json() as { type: string }).type, "method_not_allowed");
  });

  await t.test("stored ranges and queued deletes retain their original endpoints", async () => {
    const env = await api.getEnv();
    const sql = await api.getDurableObjectStorage("STORE", { name: env.STORE_ID });
    await checkLegacyRanges(async (method, path, body) => {
      const response = await request(path, { method, body: JSON.stringify(body) });
      return { status: response.status, body: await response.text() };
    }, (statement, ...params) => sql.exec(statement.replace(/\$(\d+)/g, "?$1"), ...params),
    () => new Promise(resolve => setTimeout(resolve, 100)), JSON.parse(readFileSync(new URL("./video-flow.test.json", import.meta.url), "utf8")));
  });

  await t.test("UUID filters follow the TAMS wire format", async () => {
    const videoFlow = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    await checkUuidFilters(async (method, path, body) => {
      const response = await request(path, { method, body: JSON.stringify(body) });
      return { status: response.status, body: await response.text() };
    }, videoFlow);
  });

  await t.test("Each Wasm instance uses its own SQLite host", async () => {
    const env = await api.getEnv();
    const first = env.STORE.getByName("first-isolated-store");
    const second = env.STORE.getByName("second-isolated-store");
    const wire = (method: string, name?: string) => JSON.stringify({ method, actor: { subject: username, scopes: ["tams-api/admin"] }, url: origin + "/service", headers: { "content-type": "application/json" }, body: name ? JSON.stringify({ name }) : null });
    await first.request(wire("GET"));
    await second.request(wire("GET"));
    await first.request(wire("POST", "first"));
    await second.request(wire("POST", "second"));
    assert.equal(JSON.parse(JSON.parse(await first.request(wire("GET"))).body).name, "first");
    assert.equal(JSON.parse(JSON.parse(await second.request(wire("GET"))).body).name, "second");
    assert.equal((await first.fetch(origin + "/service")).status, 401);
    assert.equal((await request("/readyz")).status, 200);
  });

  await t.test("Collection membership is backfilled on upgrade and follows flow writes", async () => {
    const name = "membership-upgrade";
    const call = async (method: string, path: string, body?: unknown) => {
      const env = await api.getEnv();
      const result = JSON.parse(await env.STORE.getByName(name).request(JSON.stringify({ method, url: origin + path, headers: { "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body), actor: { subject: username, scopes: ["tams-api/admin"] } })));
      return { status: result.status as number, value: result.body ? JSON.parse(result.body) : null };
    };
    const ids = (value: { id: string }[]) => value.map(item => item.id);
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const [a, b, c, parent] = [0, 1, 2, 3].map(() => ({ id: crypto.randomUUID(), source: crypto.randomUUID() }));
    for (const flow of [a, b, c]) assert.equal((await call("PUT", `/flows/${flow.id}`, { ...video, id: flow.id, source_id: flow.source })).status, 201);
    assert.equal((await call("PUT", `/flows/${parent.id}`, { ...video, id: parent.id, source_id: parent.source, flow_collection: [{ id: a.id, role: "a" }, { id: b.id, role: "b" }] })).status, 201);
    // Responses before the downgrade, compared in order after the upgrade.
    const listings = ["/flows?collected_by_ids=" + parent.id, "/flows?collected_by_ids=", "/sources?collected_by_ids=" + parent.source, "/sources?collected_by_ids="];
    const list = () => Promise.all(listings.map(async path => ids((await call("GET", path)).value)));
    const listed = await list();
    assert.deepEqual([...listed[0]].sort(), [a.id, b.id].sort());
    let sql = await api.getDurableObjectStorage("STORE", { name });
    // Recreate a version 2 store: no membership table, plus a duplicate and a dangling member.
    await sql.exec("DROP TRIGGER tamoss_flow_members_insert");
    await sql.exec("DROP TRIGGER tamoss_flow_members_update");
    await sql.exec("DROP TRIGGER tamoss_flow_members_delete");
    await sql.exec("DROP TABLE tamoss_flow_collection_members");
    await sql.exec("DROP INDEX idx_tamoss_unfinished_cleanup");
    await sql.exec("DELETE FROM wasm_schema_versions WHERE version>=3");
    const dangling = crypto.randomUUID();
    await sql.exec("UPDATE tamoss_flows SET flow_collection_ids=? WHERE id=?", JSON.stringify([a.id, b.id, a.id, dangling]), parent.id);
    await server.update(options => options);
    assert.equal((await call("GET", "/service")).status, 200);
    sql = await api.getDurableObjectStorage("STORE", { name });
    const members = async () => (await sql.exec<{ child_id: string }>("SELECT child_id FROM tamoss_flow_collection_members WHERE parent_id=? ORDER BY position", parent.id)).map(row => row.child_id);
    assert.deepEqual(await members(), [a.id, b.id, a.id, dangling]);
    assert.deepEqual(await list(), listed);
    const matching = async (query: string) => ids((await call("GET", `/flows?${query}`)).value).includes(c.id);
    assert.equal(await matching(`codec=${video.codec}&frame_width=${video.essence_parameters.frame_width}&frame_height=${video.essence_parameters.frame_height}`), true);
    assert.equal(await matching("frame_width=1"), false);
    assert.equal(await matching("codec=video/x-none"), false);
    const [, topLevel, collectedSources, topSources] = listed;
    assert.ok(topLevel.includes(parent.id) && topLevel.includes(c.id) && !topLevel.includes(a.id) && !topLevel.includes(b.id));
    assert.deepEqual([...collectedSources].sort(), [a.source, b.source].sort());
    assert.ok(topSources.includes(parent.source) && !topSources.includes(a.source));
    // A write that keeps the collection leaves its member rows alone.
    await sql.exec("CREATE TABLE member_writes(n INTEGER)");
    await sql.exec("CREATE TRIGGER count_member_inserts AFTER INSERT ON tamoss_flow_collection_members BEGIN INSERT INTO member_writes VALUES (1); END");
    await sql.exec("CREATE TRIGGER count_member_deletes AFTER DELETE ON tamoss_flow_collection_members BEGIN INSERT INTO member_writes VALUES (1); END");
    assert.equal((await call("PUT", `/flows/${parent.id}/label`, "renamed")).status, 204);
    assert.equal((await call("GET", `/flows/${parent.id}`)).value.label, "renamed");
    assert.equal((await sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM member_writes"))[0].n, 0);
    await sql.exec("DROP TRIGGER count_member_inserts");
    await sql.exec("DROP TRIGGER count_member_deletes");
    await sql.exec("DROP TABLE member_writes");
    // Replacing the collection replaces its members in the same write.
    assert.equal((await call("PUT", `/flows/${parent.id}/flow_collection`, [{ id: c.id, role: "c" }])).status, 204);
    assert.deepEqual(await members(), [c.id]);
    assert.deepEqual(ids((await call("GET", `/flows?collected_by_ids=${parent.id}`)).value), [c.id]);
    assert.ok(ids((await call("GET", "/flows?collected_by_ids=")).value).includes(a.id));
    // Deleting a child removes it from its parent; deleting the parent removes its rows.
    assert.equal((await call("DELETE", `/flows/${c.id}`)).status, 204);
    assert.deepEqual(await members(), []);
    assert.equal((await call("PUT", `/flows/${parent.id}/flow_collection`, [{ id: a.id, role: "a" }])).status, 204);
    assert.equal((await call("DELETE", `/flows/${parent.id}`)).status, 204);
    assert.deepEqual(await members(), []);
    assert.ok(ids((await call("GET", "/flows?collected_by_ids=")).value).includes(a.id));
  });

  await t.test("CORS errors and preflight use the configured policy", async () => {
    const headers = { Origin: "https://client.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" };
    assert.equal((await api.fetch(origin + "/service", { method: "OPTIONS", headers })).status, 200);
    assert.equal((await api.fetch(origin + "/service", { method: "OPTIONS", headers: { ...headers, Origin: "https://denied.example" } })).status, 400);
    const denied = await api.fetch(origin + "/service", { headers: { Origin: headers.Origin } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), headers.Origin);
    assert.match(denied.headers.get("Vary")!, /Origin/);
  });

  await t.test("Rust enforces scopes and webhook egress policy", async () => {
    const env = await api.getEnv();
    const store = env.STORE.getByName("scope-tests");
    const call = async (method: string, path: string, scope: string | string[], body?: unknown) => JSON.parse(await store.request(JSON.stringify({ method, url: origin + path, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : null, actor: { subject: "scoped-client", scopes: Array.isArray(scope) ? scope : [scope] } })));
    const hook = { url: "https://hooks.example.com/receive", events: [], status: "disabled" };
    const both = ["tams-api/read", "tams-api/write"];
    const registered = await call("POST", "/service/webhooks", both, hook);
    assert.equal(registered.status, 201);
    const saved = JSON.parse(registered.body);
    const hookPath = "/service/webhooks/" + saved.id;
    for (const scope of both) {
      assert.equal((await call("POST", "/service/webhooks", scope, hook)).status, 403);
      assert.equal((await call("PUT", hookPath, scope, saved)).status, 403);
    }
    assert.equal((await call("PUT", hookPath, both, saved)).status, 201);
    assert.equal((await call("DELETE", hookPath, "tams-api/write")).status, 204);
    assert.equal((await call("GET", "/flows", "tams-api/read")).status, 200);
    assert.equal((await call("GET", "/flows", "tams-api/write")).status, 403);
    assert.equal((await call("POST", "/service", "tams-api/write", { name: "denied" })).status, 403);
    assert.equal((await call("GET", "/service", "unknown")).status, 403);
    assert.equal((await call("GET", "/service", "tams-api/delete")).status, 200);
    assert.equal((await call("GET", "/flow-delete-requests", "tams-api/delete")).status, 403);
    const id = crypto.randomUUID();
    const flow = { ...JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8")), id, source_id: crypto.randomUUID(), read_only: true };
    assert.equal((await call("PUT", `/flows/${id}`, "tams-api/write", flow)).status, 403);
    assert.equal((await call("PUT", `/flows/${id}`, "tams-api/admin", flow)).status, 201);
    assert.equal((await call("PUT", `/flows/${id}/read_only`, "tams-api/write", false)).status, 403);
    // Deleting flows, segments and reading deletion jobs need tams-api/delete, not write.
    const disposable = crypto.randomUUID();
    assert.equal((await call("PUT", `/flows/${disposable}`, "tams-api/write", { ...flow, id: disposable, read_only: false })).status, 201);
    assert.equal((await call("PUT", `/flows/${disposable}/tags/stage`, "tams-api/write", ["draft"])).status, 204);
    assert.equal((await call("DELETE", `/flows/${disposable}/tags/stage`, "tams-api/write")).status, 204);
    assert.equal((await call("DELETE", `/flows/${disposable}/tags/stage`, "tams-api/delete")).status, 403);
    for (const scope of ["tams-api/read", "tams-api/write"]) {
      assert.equal((await call("DELETE", `/flows/${disposable}/segments`, scope)).status, 403);
      assert.equal((await call("DELETE", `/flows/${disposable}`, scope)).status, 403);
      assert.equal((await call("GET", `/flow-delete-requests/${crypto.randomUUID()}`, scope)).status, 403);
    }
    assert.equal((await call("GET", `/flow-delete-requests/${crypto.randomUUID()}`, "tams-api/delete")).status, 404);
    assert.equal((await call("GET", `/flows/${disposable}`, "tams-api/delete")).status, 403);
    assert.equal((await call("DELETE", `/flows/${disposable}/segments`, "tams-api/delete")).status, 204);
    assert.equal((await call("DELETE", `/flows/${disposable}`, "tams-api/delete")).status, 204);
    for (const url of ["https://unlisted.example", "http://hooks.example.com", "https://hooks.example.com:444/", "https://hooks.example.com/#fragment", "https://127.0.0.1/", "https://[::ffff:127.0.0.1]/"]) {
      const response = await request("/service/webhooks", { method: "POST", body: JSON.stringify({ url, events: ["flows/created"] }) });
      assert.equal(response.status, 400, url + ": " + await response.text());
    }
    const response = await request("/service/webhooks", { method: "POST", body: JSON.stringify({ url: "https://hooks.example.com/receive", events: ["flows/created"], status: "disabled" }) });
    assert.equal(response.status, 201, await response.text());
  });

  await t.test("Flow writes commit, invalid writes roll back, and queries remain usable", async () => {
    const id = crypto.randomUUID();
    const source_id = crypto.randomUUID();
    const flow = { ...JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8")), id, source_id, tags: { project: ["wasm"] } };
    const created = await request(`/flows/${id}`, { method: "PUT", body: JSON.stringify(flow) });
    assert.equal(created.status, 201, await created.text());
    const stored = await (await request(`/flows/${id}`)).json() as Record<string, unknown>;
    assert.equal(stored.created_by, username);
    assert.equal((await request(`/sources/${source_id}`)).status, 200);
    const listed = await request("/flows?tag.project=wasm&frame_width=1920");
    assert.equal(listed.status, 200, await listed.clone().text());
    assert.equal((await listed.json() as { id: string }[]).some(value => value.id === id), true);
    const invalid = await request(`/flows/${id}/storage`, { method: "POST", body: '{"object_ids":["duplicate","duplicate"]}' });
    assert.equal(invalid.status, 400, await invalid.text());
    assert.equal((await request(`/flows/${id}`)).status, 200);
    assert.equal((await request("/flows?sort_by=metadata_updated")).status, 200);
    assert.equal((await request(`/flows/${id}`, { method: "PUT", body: "{}" })).status, 400);
    assert.equal((await request(`/flows/${id}`, { method: "PUT", body: JSON.stringify({ id, source_id, status: "closed_complete" }) })).status, 400);
    assert.equal((await request("/flows/not-a-uuid", { method: "DELETE" })).status, 404);
    assert.equal((await request(`/flows/${id}/flow_collection`, { method: "PUT", body: "[]" })).status, 204);
    assert.equal((await request(`/flows/${id}/flow_collection`, { method: "DELETE" })).status, 204);
    assert.equal("flow_collection" in (await (await request(`/flows/${id}`)).json() as object), false);
    for (const query of ["verbose_storage=invalid", "accept_get_urls=,", "accept_storage_ids=invalid", "presigned=invalid", "storage_backend_tag_exists.test=invalid"]) {
      assert.equal((await request(`/flows/${id}/segments?${query}`, { method: "HEAD" })).status, 400);
    }
    // Moving the only flow to another source removes the old, now empty source.
    const moved = crypto.randomUUID();
    assert.equal((await request(`/flows/${id}`, { method: "PUT", body: JSON.stringify({ ...flow, source_id: moved }) })).status, 204);
    assert.equal((await request(`/sources/${moved}`)).status, 200);
    assert.equal((await request(`/sources/${source_id}`)).status, 404);
  });

  await t.test("R2 allocation, precise segments, copy and asynchronous deletion", { timeout: 30_000 }, async () => {
    const id = crypto.randomUUID();
    const flow = { ...JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8")), id, source_id: crypto.randomUUID() };
    assert.equal((await request(`/flows/${id}`, { method: "PUT", body: JSON.stringify(flow) })).status, 201);
    const objectId = `checks/${id}/literal%2F.ts`;
    const path = `/objects/${encodeURIComponent(objectId)}`;
    const allocate = (ids: string[]) => request(`/flows/${id}/storage`, { method: "POST", body: JSON.stringify({ object_ids: ids }) });
    const allocated = await allocate([objectId]);
    assert.equal(allocated.status, 201, await allocated.clone().text());
    const allocation = (await allocated.json() as { media_objects: { presigned: boolean; put_url: { url: string; headers: Record<string, string> } }[] }).media_objects[0];
    assert.equal(allocation.presigned, true);
    const url = new URL(allocation.put_url.url);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "3630");
    assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-type;host;if-none-match");
    assert.equal(allocation.put_url.headers["If-None-Match"], "*");
    assert.equal((await allocate(["rolled-back", objectId])).status, 400);
    assert.equal((await allocate(["rolled-back"])).status, 201);
    const segment = { object_id: objectId, timerange: "[10000000000:1_10000000000:3)" };
    const register = () => request(`/flows/${id}/segments`, { method: "POST", body: JSON.stringify(segment) });
    assert.equal((await register()).status, 400);
    const env = await api.getEnv();
    const key = url.pathname.split("/").slice(2).join("/");
    assert.match(key, /^wasm\/[0-9a-f]+\/[0-9a-f]{32}$/);
    await env.MEDIA.put(key, "media bytes", { httpMetadata: { contentType: "video/mp2t" } });
    const registered = await register();
    assert.equal(registered.status, 201, await registered.text());
    const listed = await request(`/flows/${id}/segments?presigned=true`);
    assert.equal(listed.status, 200, await listed.clone().text());
    assert.equal((await listed.json() as { timerange: string }[])[0].timerange, segment.timerange);
    const outside = await (await request(`/flows/${id}?include_timerange=true&timerange=[20:0_21:0)`)).json() as { timerange: string };
    assert.equal(outside.timerange, "()");
    assert.equal((await request(`/flows/${id}/segments?timerange=[10000000000:2_10000000000:3)`, { method: "DELETE" })).status, 204);
    assert.equal((await (await request(`/flows/${id}/segments`)).json() as unknown[]).length, 1);
    const backends = await (await request("/service/storage-backends")).json() as { id: string; default_storage: boolean }[];
    const secondary = backends.find(b => !b.default_storage)!.id;
    const copied = await request(path + "/instances", { method: "POST", body: JSON.stringify({ storage_id: secondary }) });
    assert.equal(copied.status, 201, await copied.text());
    assert.equal((await request(path + "/instances", { method: "POST", body: JSON.stringify({ storage_id: secondary }) })).status, 201);
    const sql = await api.getDurableObjectStorage("STORE", { name: env.STORE_ID });
    assert.deepEqual(await sql.exec("SELECT COUNT(*) AS n FROM tamoss_object_copies WHERE object_id=?", objectId), [{ n: 1 }]);
    for (let attempt = 0; attempt < 50 && !(await env.MEDIA_SECONDARY.head(key)); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await (await env.MEDIA_SECONDARY.get(key))?.text(), "media bytes");
    const rows = await sql.exec<{ record: string }>("SELECT record FROM tamoss_media_objects WHERE id=?", objectId);
    const record = JSON.parse(rows[0].record);
    record.instances = record.instances.filter((instance: { storage_backend_id: string }) => instance.storage_backend_id !== secondary);
    await sql.exec("UPDATE tamoss_media_objects SET record=? WHERE id=?", JSON.stringify(record), objectId);
    await sql.exec("UPDATE tamoss_object_copies SET status='pending',claimed_by=NULL,claim_expires_at=NULL WHERE object_id=?", objectId);
    await request("/service");
    let recovered = false;
    for (let attempt = 0; attempt < 50 && !recovered; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const current = JSON.parse((await sql.exec<{ record: string }>("SELECT record FROM tamoss_media_objects WHERE id=?", objectId))[0].record);
      recovered = current.instances.some((instance: { storage_backend_id: string }) => instance.storage_backend_id === secondary);
    }
    assert.equal(recovered, true, "Copy retries recover an R2 write made before the metadata update");
    const deleted = await request(`/flows/${id}`, { method: "DELETE" });
    assert.equal(deleted.status, 202, await deleted.text());
    for (let attempt = 0; attempt < 50 && (await request(`/flows/${id}`)).status !== 404; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await request(`/flows/${id}`)).status, 404);
    assert.ok(await env.MEDIA.head(key), "Physical bytes remain until the retention deadline");
    const replacementFlow = { ...flow, id: crypto.randomUUID() };
    assert.equal((await request(`/flows/${replacementFlow.id}`, { method: "PUT", body: JSON.stringify(replacementFlow) })).status, 201);
    const replacement = await request(`/flows/${replacementFlow.id}/storage`, { method: "POST", body: JSON.stringify({ object_ids: [objectId] }) });
    assert.equal(replacement.status, 201, await replacement.clone().text());
    const replacementUrl = new URL((await replacement.json() as { media_objects: { put_url: { url: string } }[] }).media_objects[0].put_url.url);
    assert.notEqual(replacementUrl.pathname, url.pathname);
    const replacementKey = replacementUrl.pathname.split("/").slice(2).join("/");
    await env.MEDIA.put(replacementKey, "replacement bytes");
    await sql.exec("UPDATE wasm_r2_deletions SET not_before=0 WHERE allocation_id=?", key.split("/").at(-1)!);
    await request("/service");
    for (let attempt = 0; attempt < 50 && await env.MEDIA.head(key); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await env.MEDIA.head(key), null);
    assert.equal(await env.MEDIA_SECONDARY.head(key), null);
    assert.equal(await (await env.MEDIA.get(replacementKey))?.text(), "replacement bytes");
  });

  await t.test("Flow timeranges cover own segments and collection members", async () => {
    const env = await api.getEnv();
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const put = async (extra: Record<string, unknown> = {}) => {
      const id = crypto.randomUUID();
      assert.equal((await request(`/flows/${id}`, { method: "PUT", body: JSON.stringify({ ...video, id, source_id: crypto.randomUUID(), ...extra }) })).status, 201);
      return id;
    };
    const segments = async (id: string, timeranges: string[]) => {
      const allocated = await request(`/flows/${id}/storage`, { method: "POST", body: JSON.stringify({ limit: timeranges.length }) });
      const objects = (await allocated.json() as { media_objects: { object_id: string; put_url: { url: string } }[] }).media_objects;
      for (const object of objects) await env.MEDIA.put(new URL(object.put_url.url).pathname.split("/").slice(2).join("/"), "media", { httpMetadata: { contentType: "video/mp2t" } });
      const registered = await request(`/flows/${id}/segments`, { method: "POST", body: JSON.stringify(objects.map((object, i) => ({ object_id: object.object_id, timerange: timeranges[i] }))) });
      assert.equal(registered.status, 201, await registered.text());
    };
    const timerange = async (id: string, query = "") => (await (await request(`/flows/${id}?include_timerange=true${query}`)).json() as { timerange: string }).timerange;
    const a = await put(), b = await put(), none = await put();
    await segments(a, ["[0:0_2:0)", "[2:0_4:0)"]);
    await segments(b, ["[10:0_12:0)"]);
    const both = await put({ flow_collection: [{ id: a, role: "a" }, { id: b, role: "b" }] });
    const shared = await put({ flow_collection: [{ id: b, role: "b" }] });
    await segments(both, ["[20:0_21:0)"]);
    assert.equal(await timerange(a), "[0:0_4:0)");
    assert.equal(await timerange(both), "[0:0_21:0)");
    assert.equal(await timerange(shared), "[10:0_12:0)");
    assert.equal(await timerange(none), "()");
    // Bounds select whole segments: a partial overlap reports the segment's full range.
    assert.equal(await timerange(a, "&timerange=[3:0_5:0)"), "[2:0_4:0)");
    assert.equal(await timerange(a, "&timerange=[4:0_5:0)"), "()");
    assert.equal(await timerange(a, "&timerange=[1:0_3:0)"), "[0:0_4:0)");
    assert.equal(await timerange(a, "&timerange=[2:0]"), "[2:0_4:0)");
    assert.equal(await timerange(a, "&timerange=[2:0_"), "[2:0_4:0)");
    assert.equal(await timerange(a, "&timerange=_2:0)"), "[0:0_2:0)");
    assert.equal(await timerange(a, "&timerange=()"), "()");
    assert.equal(await timerange(both, "&timerange=[3:0_11:0)"), "[2:0_12:0)");
    const listed = await (await request("/flows?include_timerange=true&limit=1000")).json() as { id: string; timerange: string }[];
    const ranges = Object.fromEntries(listed.map(flow => [flow.id, flow.timerange]));
    assert.deepEqual([a, b, both, shared, none].map(id => ranges[id]), ["[0:0_4:0)", "[10:0_12:0)", "[0:0_21:0)", "[10:0_12:0)", "()"]);
  });

  await t.test("A reused object only accepts segments within its own timerange", async () => {
    const env = await api.getEnv();
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const put = async () => {
      const id = crypto.randomUUID();
      assert.equal((await request(`/flows/${id}`, { method: "PUT", body: JSON.stringify({ ...video, id, source_id: crypto.randomUUID() }) })).status, 201);
      return id;
    };
    const original = await put(), reuse = await put();
    const allocated = await request(`/flows/${original}/storage`, { method: "POST", body: JSON.stringify({ limit: 1 }) });
    const object = (await allocated.json() as { media_objects: { object_id: string; put_url: { url: string } }[] }).media_objects[0];
    await env.MEDIA.put(new URL(object.put_url.url).pathname.split("/").slice(2).join("/"), "media", { httpMetadata: { contentType: "video/mp2t" } });
    assert.equal((await request(`/flows/${original}/segments`, { method: "POST", body: JSON.stringify({ object_id: object.object_id, timerange: "[0:0_10:0)" }) })).status, 201);
    const register = (body: unknown) => request(`/flows/${reuse}/segments`, { method: "POST", body: JSON.stringify(body) });
    const segment = (timerange: string, ts_offset: string) => ({ object_id: object.object_id, timerange, ts_offset });
    const listed = async () => (await (await request(`/flows/${reuse}/segments`)).json() as { timerange: string }[]).map(s => s.timerange);
    assert.equal((await register(segment("[100:0_110:0)", "100:0"))).status, 201, "exact fit");
    assert.equal((await register(segment("[204:0_206:0)", "200:0"))).status, 201, "partial clip");
    assert.equal((await register(segment("[500:0]", "500:0"))).status, 201, "point at the start");
    const before = (await listed()).length;
    assert.equal((await register(segment("[312:0_313:0)", "300:0"))).status, 400, "overrun");
    assert.equal((await register(segment("[410:0]", "400:0"))).status, 400, "point at the exclusive end");
    assert.equal((await listed()).length, before);
    const mixed = await register([segment("[604:0_605:0)", "600:0"), segment("[612:0_613:0)", "600:0")]);
    assert.equal(mixed.status, 200);
    assert.deepEqual((await mixed.json() as { failed_segments: { timerange: string }[] }).failed_segments.map(s => s.timerange), ["[612:0_613:0)"]);
    const ranges = await listed();
    assert.ok(ranges.includes("[604:0_605:0)") && !ranges.includes("[612:0_613:0)"), ranges.join());
    assert.equal((await (await request(`/objects/${encodeURIComponent(object.object_id)}`)).json() as { timerange: string }).timerange, "[0:0_10:0)");
  });

  await t.test("Deleting a reference keeps a reused object on its own timeline", { timeout: 30_000 }, async () => {
    const env = await api.getEnv();
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const json = async (path: string) => (await request(path)).json() as Promise<any>;
    const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) });
    const put = async () => {
      const id = crypto.randomUUID();
      assert.equal((await request(`/flows/${id}`, { method: "PUT", body: JSON.stringify({ ...video, id, source_id: crypto.randomUUID() }) })).status, 201);
      return id;
    };
    const shared = async () => {
      const original = await put(), reuse = await put();
      const object = (await (await post(`/flows/${original}/storage`, { limit: 1 })).json() as { media_objects: { object_id: string; put_url: { url: string } }[] }).media_objects[0];
      await env.MEDIA.put(new URL(object.put_url.url).pathname.split("/").slice(2).join("/"), "media", { httpMetadata: { contentType: "video/mp2t" } });
      assert.equal((await post(`/flows/${original}/segments`, { object_id: object.object_id, timerange: "[0:0_10:0)" })).status, 201);
      assert.equal((await post(`/flows/${reuse}/segments`, { object_id: object.object_id, timerange: "[104:0_106:0)", ts_offset: "100:0" })).status, 201);
      return { original, reuse, objectId: object.object_id };
    };
    const unchanged = async (reuse: string, objectId: string) => {
      assert.equal((await json(`/objects/${encodeURIComponent(objectId)}`)).timerange, "[0:0_10:0)");
      assert.deepEqual((await json(`/flows/${reuse}/segments?include_object_timerange=true`)).map((s: { object_timerange: string }) => s.object_timerange), ["[0:0_10:0)"]);
      const third = await put();
      const reused = await post(`/flows/${third}/segments`, { object_id: objectId, timerange: "[200:0_210:0)", ts_offset: "200:0" });
      assert.equal(reused.status, 201, await reused.text());
      assert.equal((await json(`/flows/${third}/segments?include_object_timerange=true`))[0].object_timerange, "[0:0_10:0)");
    };

    // Deleting the flow queues the deletion of its segments.
    const queued = await shared();
    assert.equal((await request(`/flows/${queued.original}`, { method: "DELETE" })).status, 202);
    for (let attempt = 0; attempt < 50 && (await request(`/flows/${queued.original}`)).status !== 404; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await request(`/flows/${queued.original}`)).status, 404);
    await unchanged(queued.reuse, queued.objectId);

    // Deleting by object ID removes the segment immediately.
    const immediate = await shared();
    assert.equal((await request(`/flows/${immediate.original}/segments?object_id=${encodeURIComponent(immediate.objectId)}`, { method: "DELETE" })).status, 204);
    await unchanged(immediate.reuse, immediate.objectId);
  });

  await t.test("Flow timerange searches include the segments of collection members", { timeout: 30_000 }, async () => {
    const name = "collection-timerange-search";
    const env = await api.getEnv();
    const call = async (method: string, path: string, body?: unknown) => {
      const result = JSON.parse(await env.STORE.getByName(name).request(JSON.stringify({ method, url: origin + path, headers: { "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body), actor: { subject: username, scopes: ["tams-api/admin"] } })));
      return { status: result.status as number, headers: Object.fromEntries(Object.entries(result.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), value: result.body ? JSON.parse(result.body) : null };
    };
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const put = async (extra: Record<string, unknown> = {}) => {
      const id = crypto.randomUUID();
      assert.equal((await call("PUT", `/flows/${id}`, { ...video, id, source_id: crypto.randomUUID(), ...extra })).status, 201);
      return id;
    };
    const segments = async (id: string, timeranges: string[]) => {
      const objects = (await call("POST", `/flows/${id}/storage`, { limit: timeranges.length })).value.media_objects as { object_id: string; put_url: { url: string } }[];
      for (const object of objects) await env.MEDIA.put(new URL(object.put_url.url).pathname.split("/").slice(2).join("/"), "media", { httpMetadata: { contentType: "video/mp2t" } });
      const registered = await call("POST", `/flows/${id}/segments`, objects.map((object, i) => ({ object_id: object.object_id, timerange: timeranges[i] })));
      assert.equal(registered.status, 201, JSON.stringify(registered.value));
    };
    const a = await put(), b = await put(), own = await put(), hollow = await put();
    await segments(a, ["[10:0_12:0)"]);
    await segments(b, ["[20:0_22:0)"]);
    await segments(own, ["[10:0_11:0)"]);
    const collection = await put({ flow_collection: [{ id: a, role: "a" }, { id: b, role: "b" }] });
    const empty = await put({ flow_collection: [{ id: hollow, role: "h" }] });
    const ids = async (query: string) => {
      const response = await call("GET", `/flows?${query}`);
      assert.equal(response.status, 200, JSON.stringify(response.value));
      return (response.value as { id: string }[]).map(f => f.id);
    };
    const names = new Map([[a, "a"], [b, "b"], [own, "own"], [hollow, "hollow"], [collection, "collection"], [empty, "empty"]]);
    const named = (list: string[]) => list.map(id => names.get(id)).filter(Boolean).sort();
    assert.deepEqual(named(await ids("timerange=[10:0_11:0)")), ["a", "collection", "own"]);
    assert.deepEqual(named(await ids("timerange=[21:0_23:0)")), ["b", "collection"]);
    assert.deepEqual(named(await ids("timerange=[11:0]")), ["a", "collection"]);
    // The list filters on each flow's reported extent, so the gap between members still matches the collection.
    assert.deepEqual(named(await ids("timerange=[12:0_20:0)")), ["collection"]);
    assert.deepEqual(named(await ids("timerange=()")), ["empty", "hollow"]);

    // Following the cursor one flow at a time yields the unpaged result exactly once each.
    const unpaged = await ids("timerange=[10:0_21:0)");
    const paged: string[] = [];
    let path: string | undefined = "/flows?timerange=[10:0_21:0)&limit=1";
    while (path) {
      const page = await call("GET", path);
      const head = await call("HEAD", path);
      assert.equal(head.status, 200);
      assert.equal(head.headers.link, page.headers.link);
      paged.push(...(page.value as { id: string }[]).map(f => f.id));
      path = /<[^>]*?(\/flows\?[^>]*)>; rel="next"/.exec(page.headers.link ?? "")?.[1];
    }
    assert.deepEqual(paged, unpaged);
    assert.equal(new Set(paged).size, paged.length);
    assert.deepEqual(named(paged), ["a", "b", "collection", "own"]);
  });

  await t.test("Segment deletion selects matching segments in the database", { timeout: 30_000 }, async () => {
    const name = "selective-segment-delete";
    const env = await api.getEnv();
    const call = async (method: string, path: string, body?: unknown) => {
      const result = JSON.parse(await env.STORE.getByName(name).request(JSON.stringify({ method, url: origin + path, headers: { "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body), actor: { subject: username, scopes: ["tams-api/admin"] } })));
      return { status: result.status as number, value: result.body ? JSON.parse(result.body) : null };
    };
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const flow = crypto.randomUUID();
    assert.equal((await call("PUT", `/flows/${flow}`, { ...video, id: flow, source_id: crypto.randomUUID() })).status, 201);
    const timeranges = ["[0:0_1:0)", "[1:0_2:0)", "[2:0_3:0)", "[3:0_4:0)", "[50:0]"];
    const objects = (await call("POST", `/flows/${flow}/storage`, { limit: timeranges.length })).value.media_objects as { object_id: string; put_url: { url: string } }[];
    for (const object of objects) await env.MEDIA.put(new URL(object.put_url.url).pathname.split("/").slice(2).join("/"), "media", { httpMetadata: { contentType: "video/mp2t" } });
    const ids = objects.map(object => object.object_id);
    assert.equal((await call("POST", `/flows/${flow}/segments`, ids.map((object_id, i) => ({ object_id, timerange: timeranges[i] })))).status, 201);
    const remaining = async () => ((await call("GET", `/flows/${flow}/segments`)).value as { object_id: string }[]).map(s => s.object_id);
    const remove = (query: string) => call("DELETE", `/flows/${flow}/segments?${query}`);

    assert.equal((await remove(`object_id=${ids[2]}&timerange=${encodeURIComponent("[2:0_3:0)")}`)).status, 204);
    assert.ok(!(await remaining()).includes(ids[2]));
    // No match, and partial overlap, leave the segment in place.
    for (const timerange of ["[0:0_1:0)", "[3:500000000_5:0)"]) assert.equal((await remove(`object_id=${ids[3]}&timerange=${encodeURIComponent(timerange)}`)).status, 204);
    assert.ok((await remaining()).includes(ids[3]));
    // A point timerange contains a point segment.
    assert.equal((await remove(`object_id=${ids[4]}&timerange=${encodeURIComponent("[50:0]")}`)).status, 204);
    assert.ok(!(await remaining()).includes(ids[4]));

    const queued = await remove(`timerange=${encodeURIComponent("_2:0)")}`);
    assert.equal(queued.status, 202, JSON.stringify(queued.value));
    assert.equal(queued.value.timerange_to_delete, "_2:0)");
    assert.equal((await remove("")).value.timerange_to_delete, "[0:0_4:0)");
    assert.equal((await remove(`timerange=${encodeURIComponent("[3:0_3:500000000)")}`)).status, 204);
    assert.equal((await remove(`timerange=${encodeURIComponent("()")}`)).status, 204);
  });

  await t.test("Object references filter by flow tags and page in one query", { timeout: 30_000 }, async () => {
    const name = "object-reference-tags";
    const env = await api.getEnv();
    const call = async (method: string, path: string, body?: unknown) => {
      const result = JSON.parse(await env.STORE.getByName(name).request(JSON.stringify({ method, url: origin + path, headers: { "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body), actor: { subject: username, scopes: ["tams-api/admin"] } })));
      return { status: result.status as number, headers: Object.fromEntries(Object.entries(result.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), value: result.body ? JSON.parse(result.body) : null };
    };
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const put = async (tags?: Record<string, unknown>) => {
      const id = crypto.randomUUID();
      assert.equal((await call("PUT", `/flows/${id}`, { ...video, id, source_id: crypto.randomUUID(), ...(tags ? { tags } : {}) })).status, 201);
      return id;
    };
    const first = await put({ sample: "yes" });
    const object = (await call("POST", `/flows/${first}/storage`, { limit: 1 })).value.media_objects[0] as { object_id: string; put_url: { url: string } };
    await env.MEDIA.put(new URL(object.put_url.url).pathname.split("/").slice(2).join("/"), "media", { httpMetadata: { contentType: "video/mp2t" } });
    const reference = async (id: string) => assert.equal((await call("POST", `/flows/${id}/segments`, { object_id: object.object_id, timerange: "[0:0_1:0)" })).status, 201);
    await reference(first);
    const tagged = async (tags?: Record<string, unknown>) => { const id = await put(tags); await reference(id); return id; };
    const scalar = [first, await tagged({ sample: "yes" })];
    const array = [await tagged({ sample: ["no", "yes"] }), await tagged({ sample: ["no", "yes"] })];
    const other = [await tagged({ sample: "no" }), await tagged({ sample: ["no"] })];
    const untagged = [await tagged(), await tagged()];
    const sorted = (ids: string[]) => [...ids].sort();
    const all = async (query: string) => {
      const ids: string[] = [];
      let path: string | undefined = `/objects/${object.object_id}?${query}`;
      while (path) {
        const page = await call("GET", path);
        assert.equal(page.status, 200, JSON.stringify(page.value));
        const head = await call("HEAD", path);
        assert.equal(head.headers["x-paging-count"], page.headers["x-paging-count"]);
        assert.equal(head.headers.link, page.headers.link);
        assert.equal(page.headers["x-paging-count"], String(page.value.referenced_by_flows.length));
        ids.push(...page.value.referenced_by_flows);
        path = /<[^>]*?(\/objects\/[^>]*)>; rel="next"/.exec(page.headers.link ?? "")?.[1];
      }
      return ids;
    };
    assert.deepEqual(await all("flow_tag.sample=yes&limit=2"), sorted([...scalar, ...array]));
    assert.deepEqual(await all("flow_tag.sample=yes,no&limit=3"), sorted([...scalar, ...array, ...other]));
    assert.deepEqual(await all("flow_tag_exists.sample=false&limit=1"), sorted(untagged));
    assert.deepEqual(await all("flow_tag_exists.sample=true&flow_tag.sample=no"), sorted([...array, ...other]));
    assert.deepEqual(await all("limit=3"), sorted([...scalar, ...array, ...other, ...untagged]));
  });

  await t.test("Profiles page in id order, filter, reject duplicates and lock for flows", async () => {
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const metadata = { format: video.format, codec: video.codec, container: video.container, essence_parameters: video.essence_parameters };
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const codec = `video/x-profile-${crypto.randomUUID().slice(0, 8)}`;
    for (const [i, id] of ids.entries()) {
      const created = await request(`/service/profiles/${id}`, { method: "POST", body: JSON.stringify({ id, label: `profile ${i}`, flow_metadata: { ...metadata, codec } }) });
      assert.equal(created.status, 201, await created.text());
    }
    assert.notEqual((await request(`/service/profiles/${ids[0]}`, { method: "POST", body: JSON.stringify({ id: ids[0], flow_metadata: metadata }) })).status, 201);
    const pages: string[] = [];
    let path: string | undefined = `/service/profiles?codec=${codec}&limit=2`;
    while (path) {
      const page = await request(path);
      assert.equal(page.status, 200);
      pages.push(...(await page.json() as { id: string }[]).map(p => p.id));
      path = /<[^>]*?(\/service\/profiles[^>]*)>; rel="next"/.exec(page.headers.get("link") ?? "")?.[1];
    }
    assert.deepEqual(pages, [...ids].sort());
    assert.equal((await (await request(`/service/profiles/${ids[1]}`)).json() as { label: string }).label, "profile 1");
    const flowId = crypto.randomUUID();
    const flow = await request(`/flows/${flowId}`, { method: "PUT", body: JSON.stringify({ id: flowId, source_id: crypto.randomUUID(), profile_id: ids[0] }) });
    assert.equal(flow.status, 201, await flow.text());
    assert.equal((await (await request(`/flows/${flowId}`)).json() as { codec: string }).codec, codec);
    // Older stores could persist a string PID in an immutable Profile.
    const env = await api.getEnv();
    const sql = await api.getDurableObjectStorage("STORE", { name: env.STORE_ID });
    await sql.exec("UPDATE tamoss_profiles SET record=json_set(record,'$.flow_metadata.container_mapping',json(?)) WHERE id=?",
      JSON.stringify({ mp2ts_container: { pid: "100" } }), ids[0]);
    const derivedId = crypto.randomUUID();
    const derived = await request(`/flows/${derivedId}`, { method: "PUT", body: JSON.stringify({ id: derivedId, source_id: crypto.randomUUID(), profile_id: ids[0] }) });
    assert.equal(derived.status, 400);
    assert.equal((await request(`/flows/${derivedId}`)).status, 404);
  });

  await t.test("Webhooks filter by tags, page by url and queue matching events", async () => {
    const name = "webhook-filters";
    const call = async (method: string, path: string, body?: unknown) => {
      const env = await api.getEnv();
      const result = JSON.parse(await env.STORE.getByName(name).request(JSON.stringify({ method, url: origin + path, headers: { "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body), actor: { subject: username, scopes: ["tams-api/admin"] } })));
      return { status: result.status as number, value: result.body ? JSON.parse(result.body) : null };
    };
    assert.equal((await call("GET", "/service")).status, 200);
    const sql = await api.getDurableObjectStorage("STORE", { name });
    await sql.exec("CREATE TRIGGER IF NOT EXISTS test_hold_filter_webhooks AFTER INSERT ON tamoss_webhook_deliveries BEGIN UPDATE tamoss_webhook_deliveries SET next_attempt_at='2099-01-01T00:00:00.000000000Z' WHERE id=NEW.id; END");
    const hooks = [
      { url: "https://hooks.example.com/a", events: ["flows/created"], tags: { role: "edit" } },
      { url: "https://hooks.example.com/b", events: ["flows/deleted"], tags: { role: ["edit", "review"] } },
      { url: "https://hooks.example.com/c", events: ["flows/created"] },
    ];
    const ids: Record<string, string> = {};
    for (const hook of hooks) {
      const created = await call("POST", "/service/webhooks", hook);
      assert.equal(created.status, 201, JSON.stringify(created.value));
      ids[created.value.id] = hook.url;
    }
    const urls = async (query: string) => ((await call("GET", `/service/webhooks${query}`)).value as { url: string }[]).map(h => h.url);
    assert.deepEqual(await urls("?tag.role=edit"), ["https://hooks.example.com/a", "https://hooks.example.com/b"]);
    assert.deepEqual(await urls("?tag.role=review"), ["https://hooks.example.com/b"]);
    assert.deepEqual(await urls("?tag_exists.role=false"), ["https://hooks.example.com/c"]);
    assert.deepEqual(await urls("?limit=2&reverse_order=true"), ["https://hooks.example.com/c", "https://hooks.example.com/b"]);
    const video = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const flowId = crypto.randomUUID();
    assert.equal((await call("PUT", `/flows/${flowId}`, { ...video, id: flowId, source_id: crypto.randomUUID() })).status, 201);
    const queued = await sql.exec<{ webhook: string }>("SELECT webhook_id AS webhook FROM tamoss_webhook_deliveries WHERE json_extract(record,'$.event_type')='flows/created'");
    assert.deepEqual(queued.map(row => ids[row.webhook]).sort(), ["https://hooks.example.com/a", "https://hooks.example.com/c"]);
    await sql.exec("DROP TRIGGER test_hold_filter_webhooks");
  });

  await t.test("Webhook segment snapshots use the endpoint's URL filters and Object timeranges", async () => {
    const env = await api.getEnv();
    const sql = await api.getDurableObjectStorage("STORE", { name: env.STORE_ID });
    // Keep deliveries queued so this test can inspect their snapshots without contacting a receiver.
    await sql.exec("CREATE TRIGGER test_hold_webhooks AFTER INSERT ON tamoss_webhook_deliveries BEGIN UPDATE tamoss_webhook_deliveries SET next_attempt_at='2099-01-01T00:00:00.000000000Z' WHERE id=NEW.id; END");
    const id = crypto.randomUUID();
    const fixture = JSON.parse(readFileSync("core/cloudflare/video-flow.test.json", "utf8"));
    const flow = { ...fixture, id, source_id: crypto.randomUUID(), essence_parameters: { ...fixture.essence_parameters, init_segments: true } };
    assert.equal((await request(`/flows/${id}`, { method: "PUT", body: JSON.stringify(flow) })).status, 201);
    const backend = (await (await request("/service/storage-backends")).json() as { id: string; label: string; default_storage: boolean }[]).find(value => value.default_storage)!;
    const options: Record<string, unknown>[] = [{}, { presigned: true }, { presigned: false, include_object_timerange: true },
      { accept_storage_ids: [backend.id], accept_get_urls: [backend.label], presigned: true, verbose_storage: true },
      { accept_storage_ids: [crypto.randomUUID()] }, { accept_get_urls: ["absent"] }, { accept_get_urls: [] }, { accept_storage_ids: [] }];
    let webhookId: string | undefined;
    try {
      for (const [index, transform] of options.entries()) {
        const objectId = `webhook/${id}/${index}`;
        const initId = `${objectId}/init`;
        const allocated = await request(`/flows/${id}/storage`, { method: "POST", body: JSON.stringify({ object_ids: [objectId, initId] }) });
        assert.equal(allocated.status, 201);
        for (const object of (await allocated.json() as { media_objects: { put_url: { url: string } }[] }).media_objects) {
          await env.MEDIA.put(new URL(object.put_url.url).pathname.split("/").slice(2).join("/"), "media");
        }
        const registration = await request("/service/webhooks", { method: "POST", body: JSON.stringify({ url: "https://hooks.example.com/receive", events: ["flows/segments_added"], flow_ids: [id], ...transform }) });
        assert.equal(registration.status, 201);
        webhookId = (await registration.json() as { id: string }).id;
        const timerange = `[${index + 20}:0_${index + 21}:0)`;
        const added = await request(`/flows/${id}/segments`, { method: "POST", body: JSON.stringify({ object_id: objectId, init_object_id: initId, timerange, ts_offset: "10:0" }) });
        assert.equal(added.status, 201, await added.text());
        const [queued] = await sql.exec<{ record: string }>("SELECT record FROM tamoss_webhook_deliveries WHERE webhook_id=?", webhookId);
        const delivered = JSON.parse(queued.record).payload.event.segments[0];
        const query = new URLSearchParams({ object_id: objectId });
        for (const [key, value] of Object.entries(transform)) if (key !== "accept_storage_ids" || !Array.isArray(value) || value.length) query.set(key, Array.isArray(value) ? value.join(",") : String(value));
        const expected = (await (await request(`/flows/${id}/segments?${query}`)).json() as Record<string, unknown>[])[0];
        const normalise = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => key === "url" && typeof item === "string" ? item.split("?")[0] : item));
        assert.deepEqual(normalise(delivered), normalise(expected), `Webhook transformation ${index}`);
        assert.equal(delivered.init_object.object_id, initId);
        if (transform.include_object_timerange) assert.equal(delivered.object_timerange, `[${index + 10}:0_${index + 11}:0)`);
        if (index < 4) {
          assert.ok(delivered.get_urls.length);
          assert.ok(delivered.init_object.get_urls.length);
        }
        for (const url of [...delivered.get_urls, ...delivered.init_object.get_urls]) if (url.presigned) assert.equal(new URL(url.url).searchParams.get("X-Amz-Expires"), "3630");
        assert.equal((await request(`/service/webhooks/${webhookId}`, { method: "DELETE" })).status, 204);
        webhookId = undefined;
      }
    } finally {
      if (webhookId) await request(`/service/webhooks/${webhookId}`, { method: "DELETE" });
      await sql.exec("DROP TRIGGER test_hold_webhooks");
    }
  });

  await t.test("Request bodies have a byte limit and reject invalid UTF-8", async () => {
    let chunks = 0;
    const body = new ReadableStream({ pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(256 * 1024));
      if (chunks === 24) controller.close();
    } });
    const response = await request("/service", { method: "POST", body, duplex: "half" });
    assert.equal(response.status, 413);
    assert.equal((await request("/service", { method: "POST", body: new Uint8Array([0xff]) })).status, 400);
  });

  await t.test("A stalled body times out", { timeout: 40_000 }, async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"name":"')); } });
    const response = await request("/service", { method: "POST", body, duplex: "half" });
    assert.equal(response.status, 408);
  });

  await t.test("Anonymous reads retain scope checks and never accept invalid credentials or mutations", async () => {
    const setAnonymous = (value: string) => server.update(options => ({ ...options,
      workers: options.workers.map(worker => {
        assert.ok("configPath" in worker);
        return { ...worker, vars: { ...worker.vars, ANONYMOUS_READ: value } };
      }),
    }));
    await setAnonymous("true");
    for (const path of ["/", "/service", "/service/storage-backends", "/service/profiles", "/sources", "/flows", "/openapi.json"]) {
      assert.equal((await api.fetch(origin + path)).status, 200, path);
      const head = await api.fetch(origin + path, { method: "HEAD" });
      assert.equal(head.status, 200, path);
      assert.equal(await head.text(), "");
    }
    for (const path of ["/flow-delete-requests", "/flow-delete-requests/example"]) {
      assert.equal((await api.fetch(origin + path)).status, 403);
    }
    for (const authorization of ["Basic invalid", "Bearer invalid", "Basic " + btoa(username + ":wrong")]) {
      assert.equal((await api.fetch(origin + "/service", { headers: { authorization } })).status, 401);
    }
    for (const [method, path] of [["POST", "/service"], ["PUT", "/flows/example"], ["DELETE", "/flows/example"], ["POST", "/flows/example/storage"], ["POST", "/flows/example/segments"], ["POST", "/service/webhooks"], ["PATCH", "/service"]]) {
      const response = await api.fetch(origin + path, { method, headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.match(response.headers.get("WWW-Authenticate")!, /^Basic /);
    }
    const preflight = await api.fetch(origin + "/flows", { method: "OPTIONS", headers: {
      Origin: "https://client.example", "Access-Control-Request-Method": "GET",
    } });
    assert.equal(preflight.status, 200);
    assert.equal((await request("/service", { method: "POST", body: '{"name":"Authenticated writer"}' })).status, 200);
    assert.equal((await (await api.fetch(origin + "/service")).json() as { name: string }).name, "Authenticated writer");
    await setAnonymous("invalid");
    assert.equal((await api.fetch(origin + "/service")).status, 503);
    await setAnonymous("false");
    assert.equal((await api.fetch(origin + "/service")).status, 401);
    assert.equal((await request("/service")).status, 200);
  });

  await t.test("Invalid credentials configuration denies access", async () => {
    await server.update(options => ({ ...options, workers: [{
      configPath: apiConfigPath,
      secrets: { BASIC_AUTH_USERNAME: username, BASIC_AUTH_PASSWORD: "too-short" },
      vars: { ANONYMOUS_READ: "true" },
    }] }));
    assert.equal((await request("/service")).status, 503);
    assert.equal((await api.fetch(origin + "/service")).status, 503);
    assert.equal((await api.fetch(origin + "/healthz")).status, 200);
  });

  await t.test("Configured storage IDs must be usable by UUID filters", async () => {
    for (const id of ["abcdef12-3456-7abc-89ab-0123456789ab", "abcdef12-3456-4abc-c9ab-0123456789ab"]) {
      const backends = JSON.parse(apiConfig.vars.STORAGE_BACKENDS);
      backends.MEDIA.storage_id = id;
      await server.update(() => ({ workers: [{ configPath: apiConfigPath,
        vars: { STORAGE_BACKENDS: JSON.stringify(backends) } }] }));
      const env = await api.getEnv();
      const wire = JSON.stringify({ method: "GET", url: origin + "/service/storage-backends", headers: {}, body: null, actor: { subject: username, scopes: ["tams-api/admin"] } });
      await assert.rejects(async () => await env.STORE.getByName(id).request(wire), /Invalid storage backend configuration/);
    }
  });
});

test("a populated SQLite v4 store rolls back an interrupted upgrade and refuses newer revisions", async t => {
  // This entry point gives the test access to the old database even if the new constructor fails.
  const directory = await mkdtemp(join(tmpdir(), "tasm-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = join(directory, "inspect.mjs");
  await writeFile(main, `import { DurableObject } from 'cloudflare:workers';
    export class WasmStore extends DurableObject {}
    export default { fetch() { return new Response(); } };`);
  const inspect = { config: { ...apiConfig, main, base_dir: directory, no_bundle: false } };
  const current = { configPath: apiConfigPath };
  const harness = createTestHarness({ workers: [inspect] });
  t.after(() => harness.close());
  await harness.listen();
  const worker = harness.getWorker<Bindings>(apiConfig.name);
  const prototype = { name: "prototype-upgrade" };
  const legacy = await worker.getDurableObjectStorage("STORE", prototype);
  await legacy.exec("CREATE TABLE service_metadata (id TEXT PRIMARY KEY,name TEXT,description TEXT)");
  await legacy.exec("INSERT INTO service_metadata VALUES ('default','Preserved prototype','Existing metadata')");
  const previousDist = process.env.TASM_PREVIOUS_DIST;
  if (previousDist) {
    await harness.update(() => ({ workers: [{ configPath: join(previousDist, "cloudflare/api/wrangler.json") }] }));
  }
  const storage = () => worker.getDurableObjectStorage("STORE", { name: "upgrade" });
  let sql = await storage();
  if (!previousDist) {
    for (const file of ["002", "003", "004"]) {
      await sql.exec(readFileSync(new URL(`./migrations/${file}.sql`, import.meta.url), "utf8"));
    }
    await sql.exec("CREATE TABLE wasm_schema_versions(version INTEGER PRIMARY KEY)");
    await sql.exec("INSERT INTO wasm_schema_versions VALUES (2),(3),(4)");
  }
  const versions = () => sql.exec("SELECT version FROM wasm_schema_versions ORDER BY version").then(rows => rows.map(r => r.version));
  assert.deepEqual(await versions(), [2, 3, 4]);
  const flow = crypto.randomUUID(), job = crypto.randomUUID();
  const backend = JSON.parse(apiConfig.vars.STORAGE_BACKENDS).MEDIA.storage_id as string;
  const timestamp = "2026-01-01T00:00:00.000000000Z";
  await sql.exec("INSERT INTO tamoss_flows(id,record,metadata_updated,created) VALUES(?,'{}',?,?)", flow, timestamp, timestamp);
  const key = (ns: bigint) => ((1n << 127n) + ns).toString().padStart(39, "0");
  await sql.exec("INSERT INTO tamoss_segments(flow_id,object_id,timerange,timerange_start,timerange_end,record,created) VALUES(?,'clip','[0:0_1:0)',?,?,'{}',?)", flow, key(0n), key(1000000000n), timestamp);
  await sql.exec("INSERT INTO tamoss_media_objects(id,first_referenced_by_flow,referenced_by_flows,record) VALUES('clip',?,?, '{}')", flow, JSON.stringify([flow]));
  await sql.exec("INSERT INTO tamoss_object_cleanups(id,object_id,storage_backend_id,status,record,updated) VALUES(?,'clip',?,'pending','{}',?)", job, backend, timestamp);
  const snapshot = () => sql.exec(`SELECT s.flow_id,s.object_id,s.timerange,m.allocation_id,q.id,q.status,
    json_extract(q.record,'$.allocation_id') AS queued_allocation
    FROM tamoss_segments s JOIN tamoss_media_objects m ON m.id=s.object_id AND m.first_referenced_by_flow=s.flow_id
    JOIN tamoss_object_cleanups q ON q.object_id=m.id`);
  const before = await snapshot();
  assert.match(String(before[0].allocation_id), /^[0-9a-f]{32}$/);
  assert.equal(before[0].queued_allocation, before[0].allocation_id);
  await sql.exec("CREATE TRIGGER interrupt BEFORE INSERT ON wasm_schema_versions WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT,'interrupted migration'); END");
  await harness.update(() => ({ workers: [current] }));
  sql = await storage();
  await assert.rejects(sql.exec("SELECT 1"), /interrupted migration/);
  await harness.update(() => ({ workers: [inspect] }));
  sql = await storage();
  assert.deepEqual(await versions(), [2, 3, 4]);
  const index = () => sql.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tamoss_unfinished_cleanup'");
  assert.deepEqual(await index(), []);
  await sql.exec("DROP TRIGGER interrupt");
  await harness.update(() => ({ workers: [current] }));
  sql = await storage();
  assert.deepEqual(await versions(), [2, 3, 4, 5]);
  const env = await worker.getEnv();
  const result = JSON.parse(await env.STORE.getByName(prototype.name).request(JSON.stringify({ method: "GET", url: origin + "/service", headers: {}, body: null, actor: { subject: username, scopes: ["tams-api/admin"] } })));
  assert.equal(JSON.parse(result.body).name, "Preserved prototype");
  assert.equal((await index()).length, 1);
  await worker.evictDurableObject("STORE", { name: "upgrade" });
  assert.deepEqual(await snapshot(), before);
  await sql.exec("UPDATE tamoss_storage_backends SET label='Future label' WHERE id=?", backend);
  await sql.exec("INSERT INTO wasm_schema_versions VALUES (99)");
  await worker.evictDurableObject("STORE", { name: "upgrade" });
  await assert.rejects(sql.exec("SELECT 1"), /Unsupported TASM database version/);
  await harness.update(() => ({ workers: [inspect] }));
  sql = await storage();
  assert.deepEqual(await versions(), [2, 3, 4, 5, 99]);
  assert.deepEqual(await sql.exec("SELECT label FROM tamoss_storage_backends WHERE id=?", backend), [{ label: "Future label" }]);
  assert.deepEqual(await snapshot(), before);
});

test("idle Durable Object alarms expire terminal queues and respect earlier retries", async t => {
  // Wrap the shipped class to inspect the alarm and record each real invocation.
  const directory = await mkdtemp(join(tmpdir(), "tasm-alarm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(dirname(apiConfigPath), directory, { recursive: true });
  const main = join(directory, "alarm-test.mjs");
  await writeFile(main, `
    import { WasmStore as Store } from './worker.mjs';
    export { default } from './worker.mjs';
    export class WasmStore extends Store {
      history = [];
      constructor(ctx, env) {
        const settings = { disabled: 0, invalid: '1.5' };
        super(ctx, ctx.id.name in settings ? { ...env, WORKER_QUEUE_RETENTION_SECONDS: settings[ctx.id.name] } : env);
      }
      async alarms() { return { next: await this.ctx.storage.getAlarm(), history: this.history }; }
      async alarm() {
        await super.alarm();
        this.history.push(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM tamoss_webhook_deliveries").one().n);
      }
    }`);
  const retention = 10;
  const harness = createTestHarness({ workers: [{ config: { ...apiConfig, main, base_dir: directory, no_bundle: false,
    vars: { ...apiConfig.vars, WORKER_QUEUE_RETENTION_SECONDS: String(retention) } } }] });
  t.after(() => harness.close());
  await harness.listen();
  type ObservedStore = WasmStore & { alarms(): Promise<{ next: number | null; history: number[] }> };
  const worker = harness.getWorker<Omit<Bindings, "STORE"> & { STORE: DurableObjectNamespace<ObservedStore> }>(apiConfig.name);
  const env = await worker.getEnv();
  const wire = JSON.stringify({ method: "GET", url: origin + "/service", headers: {}, body: null, actor: { subject: username, scopes: ["tams-api/admin"] } });
  await assert.rejects(async () => await env.STORE.getByName("invalid").request(wire), /WORKER_QUEUE_RETENTION_SECONDS/);
  const timestamp = (ms: number) => new Date(ms).toISOString().replace("Z", "000000Z");
  const sql = await worker.getDurableObjectStorage("STORE", { name: "idle" });
  const store = env.STORE.getByName("idle");
  const lastExpiry = Date.now() + 6000;
  await sql.exec("INSERT INTO tamoss_webhook_deliveries(id,webhook_id,status,record,updated_at) VALUES('last','hook','dead','{}',?)", timestamp(lastExpiry - retention * 1000));
  await store.request(wire);
  assert.equal((await store.alarms()).next, lastExpiry + 1, "equality at the cutoff must survive");
  const old = timestamp(Date.now() - 60_000);
  await sql.exec(`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<1001)
    INSERT INTO tamoss_webhook_deliveries(id,webhook_id,status,record,updated_at)
    SELECT n,'hook',CASE WHEN n%2=1 THEN 'done' ELSE 'dead' END,'{}',? FROM ids`, old);
  await sql.exec("INSERT INTO tamoss_delete_requests(id,flow_id,status,record,updated,updated_at) VALUES('d','f','done','{}',?,?)", old, old);
  await sql.exec("INSERT INTO tamoss_object_copies(id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,updated_at) VALUES('c','o','s','d','done','{}',?,?)", old, old);
  await sql.exec("INSERT INTO tamoss_object_cleanups(id,object_id,storage_backend_id,status,record,updated,updated_at) VALUES('c','o','s','done','{}',?,?)", old, old);
  await store.request(wire);
  // From this point only the alarm handler schedules further work.
  const waitForRuns = async (count: number) => {
    const limit = Date.now() + 15_000;
    let alarms = await store.alarms();
    while (alarms.history.length < count && Date.now() < limit) {
      await new Promise(resolve => setTimeout(resolve, 75));
      alarms = await store.alarms();
    }
    assert.equal(alarms.history.length, count);
    return alarms;
  };
  const drained = await waitForRuns(2);
  assert.deepEqual(drained.history, [2, 1]);
  assert.equal(drained.next, lastExpiry + 1);
  for (const table of ["tamoss_delete_requests", "tamoss_object_copies", "tamoss_object_cleanups"]) {
    assert.deepEqual(await sql.exec(`SELECT id FROM ${table}`), []);
  }
  assert.deepEqual(await sql.exec("SELECT id FROM tamoss_webhook_deliveries"), [{ id: "last" }]);
  const idle = await waitForRuns(3);
  assert.equal(idle.next, null);
  assert.deepEqual(idle.history, [2, 1, 0]);
  for (const name of ["retry", "disabled"]) {
    const queues = await worker.getDurableObjectStorage("STORE", { name });
    const instance = env.STORE.getByName(name);
    await queues.exec("INSERT INTO tamoss_webhook_deliveries(id,webhook_id,status,record) VALUES('keep','hook','done','{}')");
    await instance.request(wire);
    if (name === "disabled") {
      assert.equal((await instance.alarms()).next, null);
      continue;
    }
    const retry = Math.ceil(Date.now() / 1000) * 1000 + 2000;
    const id = crypto.randomUUID();
    await queues.exec("INSERT INTO tamoss_webhook_deliveries(id,webhook_id,status,record,next_attempt_at) VALUES(?,?,'pending','{}',?)", id, crypto.randomUUID(), timestamp(retry));
    await instance.request(wire);
    assert.equal((await instance.alarms()).next, retry);
    for (let i = 0; i < 100 && !(await instance.alarms()).history.length; i++) await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepEqual(await queues.exec("SELECT status FROM tamoss_webhook_deliveries WHERE id=?", id), [{ status: "dead" }]);
  }
});
