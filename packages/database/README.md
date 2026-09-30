# Database

Server-side Drizzle ORM + PostgreSQL connection factory and migration configuration. No database connections or migrations run at application startup.

The generic template_records table and included initial migration demonstrate migration tooling, not business storage. Review the SQL and DATABASE_URL before running pnpm db:migrate against your chosen database. After changing the schema, run pnpm db:generate to produce the next migration. Browser imports are blocked by the package export condition and the frontend lint boundary.
