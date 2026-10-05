import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const baseUrl = process.env.TEST_DATABASE_URL;
// In CI a missing variable must fail loudly instead of silently skipping.
if (!baseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required in CI");

const expectedTables = [
  "accounts",
  "jwks",
  "sessions",
  "users",
  "verifications",
  "workspace_invitations",
  "workspace_members",
  "workspaces",
];

describe.skipIf(!baseUrl)("migrations", () => {
  it("apply to an empty database and create the P0a tables", async () => {
    const admin = postgres(baseUrl!, { max: 1 });
    const name = `migrations_${randomBytes(6).toString("hex")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(baseUrl!);
    url.pathname = `/${name}`;
    const client = postgres(url.toString(), { max: 1 });
    try {
      await migrate(drizzle(client), {
        migrationsFolder: fileURLToPath(
          new URL("../migrations", import.meta.url),
        ),
      });

      const tables = await client<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`;
      expect(tables.map((row) => row.table_name)).toEqual(expectedTables);
      expect(tables.map((row) => row.table_name)).not.toContain(
        "template_records",
      );

      // The Better Auth CLI output must match the table names the application code assumes.
      const columns = await client<
        { table_name: string; column_name: string; data_type: string }[]
      >`select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'public'
          and (table_name, column_name) in (
            ('users', 'id'), ('workspaces', 'id'),
            ('workspace_members', 'workspace_id'),
            ('workspace_invitations', 'workspace_id'),
            ('sessions', 'active_workspace_id'))`;
      const types = Object.fromEntries(
        columns.map((c) => [`${c.table_name}.${c.column_name}`, c.data_type]),
      );
      expect(types).toEqual({
        "users.id": "uuid",
        "workspaces.id": "uuid",
        "workspace_members.workspace_id": "uuid",
        "workspace_invitations.workspace_id": "uuid",
        "sessions.active_workspace_id": "text",
      });
    } finally {
      await client.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });
});
