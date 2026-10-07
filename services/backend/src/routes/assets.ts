import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ASSET_URL_TTL_SECONDS,
  requestAssetUploadRequestSchema,
  type AssetSummary,
} from "@creative/contracts";
import { schema } from "@creative/database";
import type { ObjectStorage } from "@creative/storage";
import { findAccessibleAsset, isWorkspaceMember } from "../assets/access";
import { requireUser } from "../plugins/gateway-trust";
import type { Database } from "./me";

const { assets } = schema;

export type AssetRoutesOptions = {
  db: Database;
  storage?: ObjectStorage;
  assetProbes?: {
    startProbe: (assetId: string) => Promise<{ workflowId: string }>;
  };
};

const paramsSchema = z.object({
  assetId: z.string().uuid(),
});

function formatAsset(row: typeof assets.$inferSelect): AssetSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    key: row.key,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status as "pending" | "ready",
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    createdBy: row.createdBy ?? null,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  };
}

export async function assetRoutes(
  app: FastifyInstance,
  options: AssetRoutesOptions,
) {
  const { db, storage } = options;

  // 1. POST /api/v1/assets/upload-url
  app.post(
    "/api/v1/assets/upload-url",
    { onRequest: [requireUser] },
    async (request, reply) => {
      const parsedBody = requestAssetUploadRequestSchema.safeParse(
        request.body,
      );
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid asset upload request",
          details: parsedBody.error.issues,
        });
      }
      const { workspaceId, contentType, sizeBytes } = parsedBody.data;
      const userId = request.identity.userId!;

      const isMember = await isWorkspaceMember(db, userId, workspaceId);
      if (!isMember) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      if (!storage) {
        return reply
          .code(503)
          .send({ error: "Storage service is unavailable" });
      }

      const assetId = randomUUID();
      const key = `workspaces/${workspaceId}/assets/${assetId}`;

      const upload = await storage.presignUpload({
        key,
        contentType,
        sizeBytes,
        expiresIn: ASSET_URL_TTL_SECONDS,
      });

      await db.insert(assets).values({
        id: assetId,
        workspaceId,
        key,
        contentType,
        sizeBytes,
        status: "pending",
        createdBy: userId,
      });

      return reply.code(200).send({
        asset: {
          id: assetId,
          status: "pending",
        },
        upload: {
          url: upload.url,
          method: upload.method,
          headers: upload.headers,
          expiresIn: ASSET_URL_TTL_SECONDS,
        },
      });
    },
  );

  // 2. POST /api/v1/assets/:assetId/complete
  app.post(
    "/api/v1/assets/:assetId/complete",
    { onRequest: [requireUser] },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: "Invalid asset ID" });
      }
      const { assetId } = parsedParams.data;
      const userId = request.identity.userId!;

      const asset = await findAccessibleAsset(db, userId, assetId);
      if (!asset) {
        return reply.code(404).send({ error: "Asset not found" });
      }

      if (asset.status === "ready") {
        return reply.code(200).send({
          asset: formatAsset(asset as unknown as typeof assets.$inferSelect),
        });
      }

      if (!storage) {
        return reply
          .code(503)
          .send({ error: "Storage service is unavailable" });
      }

      const headResult = await storage.head(asset.key);
      if (!headResult) {
        return reply.code(409).send({ error: "Asset has not been uploaded" });
      }

      if (
        headResult.sizeBytes !== asset.sizeBytes ||
        headResult.contentType !== asset.contentType
      ) {
        // Delete uploaded object and database row
        await storage.delete(asset.key);
        await db.delete(assets).where(eq(assets.id, assetId));
        return reply.code(422).send({
          error: "Uploaded asset does not match expected size or content type",
        });
      }

      const [updated] = await db
        .update(assets)
        .set({ status: "ready" })
        .where(eq(assets.id, assetId))
        .returning();

      return reply.code(200).send({
        asset: formatAsset(updated ?? asset),
      });
    },
  );

  // 3. GET /api/v1/assets/:assetId
  app.get(
    "/api/v1/assets/:assetId",
    { onRequest: [requireUser] },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: "Invalid asset ID" });
      }
      const { assetId } = parsedParams.data;
      const userId = request.identity.userId!;

      const asset = await findAccessibleAsset(db, userId, assetId);
      if (!asset) {
        return reply.code(404).send({ error: "Asset not found" });
      }

      return reply.code(200).send({
        asset: formatAsset(asset as unknown as typeof assets.$inferSelect),
      });
    },
  );

  // 4. GET /api/v1/assets/:assetId/download-url
  app.get(
    "/api/v1/assets/:assetId/download-url",
    { onRequest: [requireUser] },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: "Invalid asset ID" });
      }
      const { assetId } = parsedParams.data;
      const userId = request.identity.userId!;

      const asset = await findAccessibleAsset(db, userId, assetId);
      if (!asset) {
        return reply.code(404).send({ error: "Asset not found" });
      }

      if (asset.status !== "ready") {
        return reply.code(409).send({ error: "Asset is not ready" });
      }

      if (!storage) {
        return reply
          .code(503)
          .send({ error: "Storage service is unavailable" });
      }

      const download = await storage.presignDownload({
        key: asset.key,
        expiresIn: ASSET_URL_TTL_SECONDS,
      });

      return reply.code(200).send({
        url: download.url,
        expiresIn: ASSET_URL_TTL_SECONDS,
      });
    },
  );
}
