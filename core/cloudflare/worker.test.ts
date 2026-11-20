import { apiConfigPath } from "./test-installation.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const api = server.getWorker<Bindings>("cf-tams-wasm-experiment");
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
    assert.equal("name" in (await (await request("/service")).json() as object), false);
    assert.equal((await request("/flows")).status, 200);
    const unsupported = await request("/service", { method: "PUT", body: "{}" });
    assert.equal(unsupported.status, 405);
    assert.equal((await unsupported.json() as { type: string }).type, "method_not_allowed");
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

  await t.test("The service prototype upgrades without losing its metadata", async () => {
    const name = "prototype-upgrade";
    const sql = await api.getDurableObjectStorage("STORE", { name });
    await sql.exec("CREATE TABLE service_metadata (id TEXT PRIMARY KEY,name TEXT,description TEXT)");
    await sql.exec("INSERT INTO service_metadata VALUES ('default','Preserved prototype','Existing metadata')");
    await sql.exec("DELETE FROM wasm_schema_versions WHERE version=2");
    await api.evictDurableObject("STORE", { name });
    const env = await api.getEnv();
    const result = JSON.parse(await env.STORE.getByName(name).request(JSON.stringify({ method: "GET", url: origin + "/service", headers: {}, body: null, actor: { subject: username, scopes: ["tams-api/admin"] } })));
    assert.equal(JSON.parse(result.body).name, "Preserved prototype");
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
    await sql.exec("DELETE FROM wasm_schema_versions WHERE version=3");
    const dangling = crypto.randomUUID();
    await sql.exec("UPDATE tamoss_flows SET flow_collection_ids=? WHERE id=?", JSON.stringify([a.id, b.id, a.id, dangling]), parent.id);
    await server.update(options => options);
    assert.equal((await call("GET", "/service")).status, 200);
    sql = await api.getDurableObjectStorage("STORE", { name });
    const members = async () => (await sql.exec<{ child_id: string }>("SELECT child_id FROM tamoss_flow_collection_members WHERE parent_id=? ORDER BY position", parent.id)).map(row => row.child_id);
    assert.deepEqual(await members(), [a.id, b.id, a.id, dangling]);
    assert.deepEqual(await list(), listed);
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
    const call = async (method: string, path: string, scope: string, body?: unknown) => JSON.parse(await store.request(JSON.stringify({ method, url: origin + path, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : null, actor: { subject: "scoped-client", scopes: [scope] } })));
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
    assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
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
    for (let attempt = 0; attempt < 50 && !(await env.MEDIA_SECONDARY.head(key)); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await (await env.MEDIA_SECONDARY.get(key))?.text(), "media bytes");
    const sql = await api.getDurableObjectStorage("STORE", { name: env.STORE_ID });
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
        for (const url of [...delivered.get_urls, ...delivered.init_object.get_urls]) if (url.presigned) assert.equal(new URL(url.url).searchParams.get("X-Amz-Expires"), "3600");
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
});
