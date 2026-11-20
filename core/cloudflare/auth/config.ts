import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

export const scopes = ["tams-api/read", "tams-api/write", "tams-api/delete", "tams-api/admin"];
export const ownerEmail = "operator@cf-tams.invalid";

export function createAuth(env: {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  AUTH_ISSUER: string;
  TAMS_AUDIENCE: string;
  CORS_ORIGINS: string;
}) {
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.AUTH_ISSUER,
    basePath: "/api/auth",
    trustedOrigins: JSON.parse(env.CORS_ORIGINS),
    emailAndPassword: { enabled: true },
    telemetry: { enabled: false },
    rateLimit: { enabled: false }, // The public Worker uses the native rate limit binding.
    disabledPaths: ["/token"],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/oauth2/token" && ctx.body?.resource === undefined) {
          return { context: { body: { ...ctx.body, resource: env.TAMS_AUDIENCE } } };
        }
      }),
    },
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
        jwt: { issuer: env.AUTH_ISSUER, audience: env.TAMS_AUDIENCE },
        jwks: {
          keyPairConfig: { alg: "RS256" },
          rotationInterval: 30 * 86400,
          gracePeriod: 86400,
        },
      }),
      oauthProvider({
        loginPage: "/unavailable",
        consentPage: "/unavailable",
        grantTypes: ["client_credentials"],
        scopes,
        m2mAccessTokenExpiresIn: 900,
        storeClientSecret: "hashed",
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: ({ user }) => user?.email === ownerEmail,
        resourcePrivileges: ({ user }) => user?.email === ownerEmail,
      }),
    ],
  });
}
