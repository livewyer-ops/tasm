import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import { getMigrations } from "better-auth/db/migration";
import { createAuth, ownerEmail, scopes } from "./config.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "auth/wrangler.jsonc" },
    remote: { type: "boolean", default: false },
    name: { type: "string" },
    scopes: { type: "string", default: "tams-api/read" },
    method: { type: "string", default: "client_secret_basic" },
    output: { type: "string" },
    client: { type: "string" },
  },
});
const command = positionals[0];
if (!["schema", "bootstrap", "create", "list", "scopes", "rotate", "disable"].includes(command)) {
  throw new Error("Use schema, bootstrap, create, list, scopes, rotate or disable; see docs/oauth.md.");
}
if (["schema", "create", "rotate"].includes(command) && !values.output) throw new Error("--output is required; credentials are never printed.");
if (["scopes", "rotate", "disable"].includes(command) && !values.client) throw new Error("--client is required.");
const requested = values.scopes.split(/[ ,]+/).filter(Boolean);
if (!requested.length || requested.some(scope => !scopes.includes(scope))) throw new Error("Unknown or empty scopes.");
if (!["client_secret_basic", "client_secret_post"].includes(values.method)) throw new Error("Unsupported client authentication method.");
if (command === "create" && !values.name) throw new Error("--name is required.");
if (values.remote) {
  const config = JSON.parse(await readFile(values.config, "utf8"));
  if (!config.d1_databases?.some((db: { remote?: boolean }) => db.remote)) throw new Error("Remote administration requires the generated deployment configuration.");
}
const platform = await getPlatformProxy<Env>({
  configPath: values.config,
  remoteBindings: values.remote,
  persist: { path: resolve(dirname(values.config), ".wrangler/state/v3") },
});
let output: Awaited<ReturnType<typeof open>> | undefined;
try {
  if (values.output) output = await open(values.output, "wx", 0o600);
  const auth = createAuth(platform.env);
  if (command === "schema") {
    if (values.remote) throw new Error("Generate migrations against a local database.");
    const migration = await getMigrations(auth.options);
    await output!.writeFile(await migration.compileMigrations());
    console.log("Migration written to", values.output);
  } else {
    const password = process.env.AUTH_OWNER_PASSWORD;
    if (!password || password.length < 32) throw new Error("AUTH_OWNER_PASSWORD must contain at least 32 characters.");
    const result = command === "bootstrap"
      ? await auth.api.signUpEmail({ body: { email: ownerEmail, password, name: "TAMS operator" }, returnHeaders: true })
      : await auth.api.signInEmail({ body: { email: ownerEmail, password }, returnHeaders: true });
    const headers = new Headers({ cookie: result.headers.getSetCookie().map(cookie => cookie.split(";", 1)[0]).join("; ") });
    try {
      if (command === "bootstrap") {
        await auth.api.adminCreateOAuthResource({ headers, body: { identifier: platform.env.TAMS_AUDIENCE, allowedScopes: scopes } });
        console.log("Operator and TAMS resource created.");
      } else if (command === "create") {
        const client = await auth.api.adminCreateOAuthClient({
          headers,
          body: {
            client_name: values.name,
            grant_types: ["client_credentials"],
            token_endpoint_auth_method: values.method,
            scope: requested.join(" "),
            client_credentials_scopes: requested,
          },
        });
        await output!.writeFile(JSON.stringify({ ...client, token_url: `${platform.env.AUTH_ISSUER}/api/auth/oauth2/token`, api_url: platform.env.TAMS_AUDIENCE }, null, 2) + "\n");
        await output!.sync();
        await auth.api.adminLinkClientResource({ headers, params: { identifier: platform.env.TAMS_AUDIENCE, client_id: client.client_id } });
        console.log("Client created; credentials written to", values.output);
      } else if (command === "list") {
        const clients = await auth.api.getOAuthClients({ headers });
        console.log(JSON.stringify((clients ?? []).map(client => ({ client_id: client.client_id, client_name: client.client_name, scope: client.scope })), null, 2));
      } else if (command === "rotate") {
        const client = await auth.api.rotateClientSecret({ headers, body: { client_id: values.client! } });
        await output!.writeFile(JSON.stringify({ ...client, token_url: `${platform.env.AUTH_ISSUER}/api/auth/oauth2/token`, api_url: platform.env.TAMS_AUDIENCE }, null, 2) + "\n");
        await output!.sync();
        console.log("Secret rotated; credentials written to", values.output);
      } else {
        await auth.api.adminUpdateOAuthClient({ headers, body: { client_id: values.client!, update: {
          client_credentials_scopes: command === "disable" ? [] : requested,
          ...(command === "scopes" ? { scope: requested.join(" ") } : {}),
        } } });
        console.log(command === "disable" ? "New token issuance disabled. Existing tokens expire within 15 minutes." : "Client scopes updated.");
      }
    } finally { await auth.api.signOut({ headers }); }
  }
} finally {
  await output?.close();
  await platform.dispose();
}
