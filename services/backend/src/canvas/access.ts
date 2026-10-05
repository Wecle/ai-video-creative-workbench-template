import { and, eq } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import { schema } from "@creative/database";
import type { Database } from "../routes/me";

/**
 * The only place that decides whether a user may touch a canvas: they must be a member of
 * the canvas's workspace, and the canvas must belong to the project in the URL. Everything
 * that reads or writes canvas data (saving, snapshots, and later runs, assets and the
 * Agent's canvas tools) goes through here. "No such canvas" and "not yours" are the same
 * answer (callers reply 404, never 403), so ids cannot be probed.
 *
 * Roles are not distinguished yet: any member may read and write. Add that check here.
 */
const { canvases, workspace_members } = schema;

export const canvasMetaColumns = {
  id: canvases.id,
  projectId: canvases.projectId,
  workspaceId: canvases.workspaceId,
  name: canvases.name,
  version: canvases.version,
  updatedAt: canvases.updatedAt,
} as const;

export async function findAccessibleCanvas<
  T extends SelectedFields = typeof canvasMetaColumns,
>(
  db: Database,
  userId: string,
  projectId: string,
  canvasId: string,
  columns: T = canvasMetaColumns as unknown as T,
) {
  const [row] = (await db
    .select(columns as SelectedFields)
    .from(canvases)
    .innerJoin(
      workspace_members,
      and(
        eq(workspace_members.workspace_id, canvases.workspaceId),
        eq(workspace_members.userId, userId),
      ),
    )
    .where(and(eq(canvases.id, canvasId), eq(canvases.projectId, projectId)))
    .limit(1)) as unknown as SelectResultFields<T>[];
  return row ?? null;
}

/** Subquery: the workspaces a user belongs to (for conditions inside UPDATE/DELETE). */
export function workspacesOf(db: Database, userId: string) {
  return db
    .select({ id: workspace_members.workspace_id })
    .from(workspace_members)
    .where(eq(workspace_members.userId, userId));
}
