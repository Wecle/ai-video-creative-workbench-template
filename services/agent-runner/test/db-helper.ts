import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { schema } from "@creative/database";

if (!process.env.TEST_DATABASE_URL) {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // ignore
  }
}
export const baseUrl = process.env.TEST_DATABASE_URL;

export type TestDb = {
  client: postgres.Sql;
  db: PostgresJsDatabase<typeof schema>;
  cleanup: () => Promise<void>;
};

export async function createTestDatabase(): Promise<TestDb> {
  if (!baseUrl) throw new Error("TEST_DATABASE_URL is required");
  const admin = postgres(baseUrl, { max: 1 });
  const dbName = `agent_test_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);

  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const client = postgres(url.toString(), { max: 3 });
  const db = drizzle(client, { schema });

  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../../packages/database/migrations", import.meta.url),
    ),
  });

  return {
    client,
    db,
    async cleanup() {
      await client.end({ timeout: 5 }).catch(() => undefined);
      await admin
        .unsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`)
        .catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}
