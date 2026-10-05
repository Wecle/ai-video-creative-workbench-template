// Entry point for `auth generate` (see the auth:generate script). It only needs
// the shape of the configuration: postgres-js connects lazily, so no database is
// contacted, and the schema argument is empty because the CLI emits the schema.
import { createDatabase } from "@creative/database";
import { createAuth } from "./auth";

const { db } = createDatabase("postgresql://cli:cli@localhost:5432/cli");

export const auth = createAuth({
  db,
  schema: {},
  config: {
    webOrigin: "http://localhost:3000",
    betterAuthSecret: "cli-only-secret-that-is-never-used-0000000",
    google: { clientId: "cli", clientSecret: "cli" },
  },
});
