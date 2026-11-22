import { test } from "node:test";
import assert from "node:assert/strict";
import { presign } from "./signing.ts";

// Expected URLs come from botocore 1.34 (S3SigV4QueryAuth, region "auto",
// expires 3630) with these credentials and this timestamp.
const accessKey = "AKIDEXAMPLE";
const secretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const now = new Date("2026-11-20T12:34:56Z");
const credential = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261120%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261120T123456Z&X-Amz-Expires=3630";

test("presigned GET matches an independent SigV4 implementation", async () => {
  const url = new URL("https://account.r2.cloudflarestorage.com/media/flows/a%20b/object.ts");
  assert.equal(await presign("GET", url, accessKey, secretKey, 3630, {}, now),
    `${url.href}?${credential}&X-Amz-SignedHeaders=host&X-Amz-Signature=2edc0be69ad3e02732e949444e8c7d01f37ff522df0fe36a1aa53e7d6ba21b7e`);
});

test("presigned PUT signs the content type", async () => {
  const url = new URL("https://account.r2.cloudflarestorage.com/media/object-1");
  assert.equal(await presign("PUT", url, accessKey, secretKey, 3630, { "Content-Type": "video/mp2t" }, now),
    `${url.href}?${credential}&X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=726ce4abf9a126455b8dc6597ceb5ae16f3791907d2235ca71f647ff4cc3690f`);
});

test("presign rejects URLs it cannot sign safely", async () => {
  for (const value of ["http://account.r2.cloudflarestorage.com/media/x", "https://account.r2.cloudflarestorage.com/media/x?a=1", "https://account.r2.cloudflarestorage.com/media/x#f"]) {
    await assert.rejects(presign("GET", new URL(value), accessKey, secretKey, 3630, {}, now));
  }
  await assert.rejects(presign("GET", new URL("https://account.r2.cloudflarestorage.com/x"), "", secretKey, 3630, {}, now));
});
