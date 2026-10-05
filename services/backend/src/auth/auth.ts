import { betterAuth } from "better-auth";
import { jwt, organization } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { AUTH_JWT_AUDIENCE } from "@creative/contracts/internal-auth";
import type { createDatabase } from "@creative/database";

export type AuthConfig = {
  webOrigin: string;
  betterAuthSecret: string;
  google?: { clientId: string; clientSecret: string };
};

type CreateAuthOptions = {
  db: ReturnType<typeof createDatabase>["db"];
  /** Drizzle schema exported by @creative/database; the CLI passes `{}`. */
  schema: Record<string, unknown>;
  config: AuthConfig;
};

export function createAuth({ db, schema, config }: CreateAuthOptions) {
  const auth = betterAuth({
    // Browsers reach Better Auth through the web origin (Next rewrite -> gateway),
    // so cookies and the Google callback live on that origin.
    baseURL: config.webOrigin,
    secret: config.betterAuthSecret,
    trustedOrigins: [config.webOrigin],
    database: drizzleAdapter(db, { provider: "pg", schema }),
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: false,
    },
    socialProviders: config.google ? { google: config.google } : {},
    // Rate limiting happens once, in the gateway.
    rateLimit: { enabled: false },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: config.webOrigin.startsWith("https://"),
      // Better Auth skips the Origin/CSRF check when NODE_ENV=test; keep it on so
      // tests exercise the same behaviour as production.
      disableOriginCheck: false,
    },
    plugins: [
      jwt({
        jwt: {
          issuer: config.webOrigin,
          audience: AUTH_JWT_AUDIENCE,
          expirationTime: "10m",
          // The default payload is the whole user object; the gateway only needs `sub`.
          definePayload: () => ({}),
        },
      }),
      organization({
        schema: {
          organization: { modelName: "workspaces" },
          member: {
            modelName: "workspace_members",
            fields: { organizationId: "workspace_id" },
          },
          invitation: {
            modelName: "workspace_invitations",
            fields: { organizationId: "workspace_id" },
          },
          session: { fields: { activeOrganizationId: "active_workspace_id" } },
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Every user gets a personal workspace so later tables can require workspace_id.
          after: async (user) => {
            await auth.api.createOrganization({
              body: {
                name: `${user.name}'s workspace`,
                slug: `ws-${user.id}`,
                userId: user.id,
              },
            });
          },
        },
      },
    },
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
