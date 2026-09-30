import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Replace this generic migration example with your application's domain schema.
export const templateRecords = pgTable("template_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
