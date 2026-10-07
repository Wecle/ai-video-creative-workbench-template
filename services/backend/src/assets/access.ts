import { and, eq } from "drizzle-orm";
import { schema } from "@creative/database";
import type { Database } from "../routes/me";

const { assets, workspace_members } = schema;

export async function isWorkspaceMember(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: workspace_members.id })
    .from(workspace_members)
    .where(
      and(
        eq(workspace_members.workspace_id, workspaceId),
        eq(workspace_members.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function findAccessibleAsset(
  db: Database,
  userId: string,
  assetId: string,
) {
  const [row] = await db
    .select({
      id: assets.id,
      workspaceId: assets.workspaceId,
      key: assets.key,
      contentType: assets.contentType,
      sizeBytes: assets.sizeBytes,
      status: assets.status,
      metadata: assets.metadata,
      createdBy: assets.createdBy,
      createdAt: assets.createdAt,
      updatedAt: assets.updatedAt,
    })
    .from(assets)
    .innerJoin(
      workspace_members,
      and(
        eq(workspace_members.workspace_id, assets.workspaceId),
        eq(workspace_members.userId, userId),
      ),
    )
    .where(eq(assets.id, assetId))
    .limit(1);
  return row ?? null;
}
