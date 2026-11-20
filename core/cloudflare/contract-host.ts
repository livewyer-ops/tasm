// Connects the shared OpenAPI contract walk (tests/contract/client.ts) to the
// Cloudflare Worker running in the wrangler test harness.
import RefParser from "@apidevtools/json-schema-ref-parser";
import type { WorkerHandle } from "wrangler";
import { runContract, type ContractHost } from "../../tests/contract/client.ts";
import type { Bindings } from "./worker.ts";

type Api = WorkerHandle<Bindings>;
type Bucket = "MEDIA" | "MEDIA_SECONDARY";

/** The webhook host must pass the Worker's egress policy (HTTPS, allowed host). */
export const contractWebhookURL = "https://hooks.example.com/contract";

export async function runCloudflareContract(api: Api, origin: string, authorization: string) {
  const spec = await RefParser.dereference("contracts/tams/api/TimeAddressableMediaStore.yaml");
  const env = await api.getEnv() as Bindings & Record<Bucket, R2Bucket> & { STORAGE_BACKENDS: string };
  const buckets = new Map<string, Bucket>(Object.entries(JSON.parse(env.STORAGE_BACKENDS) as Record<Bucket, { bucket_name: string }>)
    .map(([binding, backend]) => [backend.bucket_name, binding as Bucket]));
  const sql = await api.getDurableObjectStorage("STORE", { name: env.STORE_ID });
  // Presigned R2 URLs name the bucket in the first path segment; the harness serves R2 through its bindings.
  const object = (url: string) => {
    const [, bucket, ...key] = new URL(url).pathname.split("/");
    const binding = buckets.get(bucket);
    if (!binding) throw new Error(`Unknown bucket in ${url}`);
    return { bucket: env[binding], key: key.map(decodeURIComponent).join("/") };
  };
  const request = (path: string, init: { method?: string; body?: string } = {}) => api.fetch(origin + path, {
    method: init.method, body: init.body, headers: { authorization, "content-type": "application/json" },
  });
  const host: ContractHost = {
    apiRoot: origin + "/",
    webhookURL: contractWebhookURL,
    async request({ path, method, body }) {
      const response = await request(path, { method, body });
      return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() };
    },
    async media({ url, method, headers, bytes }) {
      const { bucket, key } = object(url);
      if (method === "PUT") {
        const header = new Headers(headers);
        // Presigned PUTs are create-only (If-None-Match: *); R2 returns null when the object exists.
        const stored = await bucket.put(key, new Uint8Array(bytes ?? []), {
          httpMetadata: { contentType: header.get("content-type") ?? undefined },
          ...(header.get("if-none-match") === "*" ? { onlyIf: { etagDoesNotMatch: "*" } } : {}),
        });
        return { status: stored ? 200 : 412, bytes: [] };
      }
      const stored = await bucket.get(key);
      return stored ? { status: 200, bytes: Array.from(new Uint8Array(await stored.arrayBuffer())) } : { status: 404, bytes: [] };
    },
    // Deliveries are held (see below), so this checks that one was queued for
    // the registered webhook rather than received by a receiver.
    async observedFlowCreated(flow) {
      const rows = await sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tamoss_webhook_deliveries WHERE json_extract(record,'$.event_type')='flows/created' AND json_extract(record,'$.payload.event.flow.id')=?", flow);
      return rows[0].n > 0;
    },
    // Physical R2 deletes wait for a retention deadline; move it to now and let the alarm run.
    async progressQueues() {
      await sql.exec("UPDATE wasm_r2_deletions SET not_before=0");
      await request("/service");
    },
  };
  // Hold every delivery so the alarm never calls the webhook host and the test stays offline.
  await sql.exec("CREATE TRIGGER contract_hold_webhooks AFTER INSERT ON tamoss_webhook_deliveries BEGIN UPDATE tamoss_webhook_deliveries SET next_attempt_at='2099-01-01T00:00:00.000000000Z' WHERE id=NEW.id; END");
  try { return await runContract(spec as Parameters<typeof runContract>[0], host); }
  finally { await sql.exec("DROP TRIGGER contract_hold_webhooks"); }
}
