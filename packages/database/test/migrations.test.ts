import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

if (!process.env.TEST_DATABASE_URL) {
  try {
    process.loadEnvFile(new URL("../../.env", import.meta.url));
  } catch {
    // ignore
  }
}
const baseUrl = process.env.TEST_DATABASE_URL;
// In CI a missing variable must fail loudly instead of silently skipping.
if (!baseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required in CI");

const expectedTables = [
  "accounts",
  "canvases",
  "jwks",
  "node_runs",
  "projects",
  "runs",
  "sessions",
  "users",
  "verifications",
  "workspace_invitations",
  "workspace_members",
  "workspaces",
];

describe.skipIf(!baseUrl)("migrations", () => {
  it("apply to an empty database and create the application tables", async () => {
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
            ('sessions', 'active_workspace_id'),
            ('canvases', 'yjs_state'), ('canvases', 'snapshot'),
            ('runs', 'snapshot'), ('runs', 'created_by'), ('runs', 'created_at'),
            ('runs', 'options'), ('node_runs', 'provider'))`;
      const types = Object.fromEntries(
        columns.map((c) => [`${c.table_name}.${c.column_name}`, c.data_type]),
      );
      expect(types).toEqual({
        "users.id": "uuid",
        "workspaces.id": "uuid",
        "workspace_members.workspace_id": "uuid",
        "workspace_invitations.workspace_id": "uuid",
        "sessions.active_workspace_id": "text",
        "canvases.yjs_state": "bytea",
        "canvases.snapshot": "jsonb",
        "runs.snapshot": "jsonb",
        "runs.options": "jsonb",
        "runs.created_by": "uuid",
        "runs.created_at": "timestamp with time zone",
        "node_runs.provider": "text",
      });

      // A canvas cannot claim a workspace other than its project's (composite foreign key).
      const [first, second] = await client<{ id: string }[]>`
        insert into workspaces (name, slug, created_at)
        values ('A', 'a', now()), ('B', 'b', now()) returning id`;
      const [project] = await client<{ id: string }[]>`
        insert into projects (workspace_id, name) values (${first!.id}, 'P') returning id`;
      const insertCanvas = (workspaceId: string) => client`
        insert into canvases (project_id, workspace_id, name, yjs_state, snapshot, schema_version)
        values (${project!.id}, ${workspaceId}, 'C', ${Buffer.from([1, 2, 3])}, '{}'::jsonb, 1)`;
      await expect(insertCanvas(second!.id)).rejects.toThrow(
        /canvases_project_workspace_fk/,
      );
      await insertCanvas(first!.id);
      const [stored] = await client<{ yjs_state: Buffer; version: number }[]>`
        select yjs_state, version from canvases`;
      expect([...stored!.yjs_state]).toEqual([1, 2, 3]);
      expect(stored!.version).toBe(0);
    } finally {
      await client.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });
});
