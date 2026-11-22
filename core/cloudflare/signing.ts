// AWS Signature Version 4 for R2 media uploads and downloads.
const encoder = new TextEncoder();
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export async function presign(method: string, url: URL, accessKey: string, secretKey: string, lifetimeSeconds: number, headers: Record<string, string> = {}, now = new Date()): Promise<string> {
  if (url.protocol !== "https:" || url.search || url.hash || !accessKey || !secretKey) throw new Error("Invalid signing configuration");
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = stamp.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const canonicalHeaders: Record<string, string> = { host: url.host };
  for (const [key, value] of Object.entries(headers)) canonicalHeaders[key.toLowerCase().trim()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(canonicalHeaders).sort();
  const signedHeaders = names.join(";");
  const query = Object.entries({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${accessKey}/${scope}`,
    "X-Amz-Date": stamp, "X-Amz-Expires": String(lifetimeSeconds), "X-Amz-SignedHeaders": signedHeaders,
  }).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const canonical = [method, url.pathname, query, names.map(key => `${key}:${canonicalHeaders[key]}\n`).join(""), signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)))}`;
  let key: ArrayBuffer = new Uint8Array(encoder.encode("AWS4" + secretKey)).buffer;
  for (const value of [date, "auto", "s3", "aws4_request", toSign]) {
    const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    key = await crypto.subtle.sign("HMAC", imported, encoder.encode(value));
  }
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${hex(key)}`;
}
