import {
  signInternalIdentity,
  type InternalIdentity,
} from "@creative/contracts/internal-auth";
import { createDatabase, schema } from "@creative/database";
import { buildApp } from "../src/app";
import { createAuth } from "../src/auth/auth";

export const INTERNAL_SECRET = "test-internal-secret-0123456789abcdef";
export const BETTER_AUTH_SECRET = "test-better-auth-secret-0123456789abcd";
export const WEB_ORIGIN = "http://localhost:3000";

/** Integration tests need Postgres; in CI a missing variable is a failure, not a skip. */
export function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url && process.env.CI)
    throw new Error("TEST_DATABASE_URL is required in CI");
  return url;
}

/** What the gateway would add for a request: a signed identity. */
export function signedHeaders(
  method: string,
  path: string,
  identity: InternalIdentity = { authType: "anonymous" },
  extra: { nowSeconds?: number; secret?: string } = {},
) {
  return signInternalIdentity({
    secret: extra.secret ?? INTERNAL_SECRET,
    method,
    pathname: path.split("?")[0]!,
    identity,
    nowSeconds: extra.nowSeconds,
  });
}

/**
 * Backend wired to a real Better Auth instance. postgres-js connects lazily, so
 * without TEST_DATABASE_URL this still works for tests that never touch the database.
 */
export function createTestApp(
  databaseUrl = testDatabaseUrl() ??
    "postgresql://nobody:nobody@127.0.0.1:1/none",
) {
  const database = createDatabase(databaseUrl);
  const auth = createAuth({
    db: database.db,
    schema,
    config: { webOrigin: WEB_ORIGIN, betterAuthSecret: BETTER_AUTH_SECRET },
  });
  const app = buildApp({
    logger: false,
    auth,
    db: database.db,
    internalSecret: INTERNAL_SECRET,
    webOrigin: WEB_ORIGIN,
  });
  return {
    app,
    auth,
    db: database.db,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}
