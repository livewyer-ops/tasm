type Policy = { origins: string[]; methods: string[]; headers: string[]; expose_headers: string[]; max_age_seconds: number; allow_credentials: boolean };
const defaults: Policy = {
  origins: [], methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"], headers: ["Authorization", "Content-Type"],
  expose_headers: ["Location", "Link", "WWW-Authenticate", "X-Paging-Limit", "X-Paging-Count", "X-Paging-Reverse-Order", "X-Paging-NextKey", "X-Paging-Timerange"], max_age_seconds: 3600, allow_credentials: false,
};
export function cors(raw: string, request: Request): { preflight?: Response; apply(response: Response): Response } {
  const input = JSON.parse(raw);
  if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).some(key => !(key in defaults))) throw new Error("Invalid CORS configuration");
  const policy = { ...defaults, ...input } as Policy;
  for (const key of ["origins", "methods", "headers", "expose_headers"] as const) if (!Array.isArray(policy[key]) || policy[key].some(value => typeof value !== "string")) throw new Error("Invalid CORS list");
  for (const origin of policy.origins) {
    if (origin === "*") continue;
    const url = new URL(origin);
    if (!/^https?:$/.test(url.protocol) || url.origin !== origin || url.port === "0") throw new Error("Invalid CORS origin");
  }
  if (policy.methods.some(method => ![...defaults.methods, "PATCH"].includes(method)) ||
      [...policy.headers, ...policy.expose_headers].some(header => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) ||
      !Number.isSafeInteger(policy.max_age_seconds) || policy.max_age_seconds < 0 || typeof policy.allow_credentials !== "boolean" ||
      (policy.allow_credentials && policy.origins.includes("*"))) throw new Error("Invalid CORS configuration");
  const origin = request.headers.get("Origin");
  const allowed = !!origin && (policy.origins.includes(origin) || policy.origins.includes("*"));
  const apply = (response: Response) => {
    const result = new Response(response.body, response);
    if (policy.origins.length && !policy.origins.includes("*") && !/(^|,)\s*(origin|\*)\s*(,|$)/i.test(result.headers.get("Vary") ?? "")) result.headers.append("Vary", "Origin");
    if (allowed) {
      result.headers.set("Access-Control-Allow-Origin", policy.origins.includes("*") ? "*" : origin!);
      if (policy.allow_credentials) result.headers.set("Access-Control-Allow-Credentials", "true");
      if (policy.expose_headers.length) result.headers.set("Access-Control-Expose-Headers", policy.expose_headers.join(", "));
    }
    return result;
  };
  if (request.method !== "OPTIONS" || !origin || !request.headers.has("Access-Control-Request-Method")) return { apply };
  const headers = new Set([...policy.headers.map(value => value.toLowerCase()), "accept", "accept-language", "content-language", "content-type"]);
  const requested = (request.headers.get("Access-Control-Request-Headers") ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const accepted = allowed && policy.methods.includes(request.headers.get("Access-Control-Request-Method")!) && (headers.has("*") || requested.every(value => headers.has(value)));
  const response = apply(new Response(null, { status: accepted ? 200 : 400 }));
  response.headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  if (accepted) {
    response.headers.set("Access-Control-Allow-Methods", policy.methods.join(", "));
    response.headers.set("Access-Control-Allow-Headers", (headers.has("*") ? requested : [...headers].sort()).join(", "));
    response.headers.set("Access-Control-Max-Age", String(policy.max_age_seconds));
  }
  return { apply, preflight: response };
}
