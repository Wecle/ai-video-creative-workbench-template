import type * as Y from "yjs";

/**
 * Extension point for document schema upgrades. `MIGRATIONS[n]` upgrades a document from
 * schema version n to n + 1 in place (the loader runs it with origin `load` and bumps
 * `meta.schemaVersion`). Empty while only version 1 exists.
 */
export const MIGRATIONS: Record<number, (doc: Y.Doc) => void> = {};
