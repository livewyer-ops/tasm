import { test } from "node:test";
import assert from "node:assert/strict";
import { presign } from "./signing.ts";

// Expected URLs come from botocore 1.34 (S3SigV4QueryAuth, region "auto",
// expires 3600) with these credentials and this timestamp.
const accessKey = "AKIDEXAMPLE";
const secretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const now = new Date("2026-11-20T12:34:56Z");
const credential = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261120%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261120T123456Z&X-Amz-Expires=3600";

test("presigned GET matches an independent SigV4 implementation", async () => {
  const url = new URL("https://account.r2.cloudflarestorage.com/media/flows/a%20b/object.ts");
  assert.equal(await presign("GET", url, accessKey, secretKey, {}, now),
    `${url.href}?${credential}&X-Amz-SignedHeaders=host&X-Amz-Signature=371d1d40b57bcc20fb9d2b1e402883152b37bd46a930702ba7b85a5846d16c61`);
});

test("presigned PUT signs the content type", async () => {
  const url = new URL("https://account.r2.cloudflarestorage.com/media/object-1");
  assert.equal(await presign("PUT", url, accessKey, secretKey, { "Content-Type": "video/mp2t" }, now),
    `${url.href}?${credential}&X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=33c5736b592e9a4b61cef04fd9145d264989a42e0cc66177fa4b52f9beae32f1`);
});

test("presign rejects URLs it cannot sign safely", async () => {
  for (const value of ["http://account.r2.cloudflarestorage.com/media/x", "https://account.r2.cloudflarestorage.com/media/x?a=1", "https://account.r2.cloudflarestorage.com/media/x#f"]) {
    await assert.rejects(presign("GET", new URL(value), accessKey, secretKey, {}, now));
  }
  await assert.rejects(presign("GET", new URL("https://account.r2.cloudflarestorage.com/x"), "", secretKey, {}, now));
});
