import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
config({ path: "../../.env", quiet: true });
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://template:template@localhost:5432/template",
  },
});
