import { z } from "zod";

export const ASSET_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "audio/mpeg",
  "audio/wav",
] as const;

export type AssetContentType = (typeof ASSET_CONTENT_TYPES)[number];

export const ASSET_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const ASSET_URL_TTL_SECONDS = 300; // 5 minutes

export const assetStatusSchema = z.enum(["pending", "ready"]);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

export const assetContentTypeSchema = z.enum(ASSET_CONTENT_TYPES);

export const requestAssetUploadRequestSchema = z.strictObject({
  workspaceId: z.string().uuid(),
  contentType: assetContentTypeSchema,
  sizeBytes: z.number().int().positive().max(ASSET_MAX_BYTES),
});
export type RequestAssetUploadRequest = z.infer<
  typeof requestAssetUploadRequestSchema
>;

export const requestAssetUploadResponseSchema = z.object({
  asset: z.object({
    id: z.string().uuid(),
    status: assetStatusSchema,
  }),
  upload: z.object({
    url: z.string(),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    expiresIn: z.number().int().positive(),
  }),
});
export type RequestAssetUploadResponse = z.infer<
  typeof requestAssetUploadResponseSchema
>;

export const assetMetadataSchema = z.record(z.string(), z.unknown());
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

export const assetSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  key: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  status: assetStatusSchema,
  metadata: assetMetadataSchema.nullable().optional(),
  createdBy: z.string().uuid().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssetSummary = z.infer<typeof assetSummarySchema>;

export const getAssetResponseSchema = z.object({
  asset: assetSummarySchema,
});
export type GetAssetResponse = z.infer<typeof getAssetResponseSchema>;

export const completeAssetResponseSchema = z.object({
  asset: assetSummarySchema,
});
export type CompleteAssetResponse = z.infer<typeof completeAssetResponseSchema>;

export const getAssetDownloadUrlResponseSchema = z.object({
  url: z.string(),
  expiresIn: z.number().int().positive(),
});
export type GetAssetDownloadUrlResponse = z.infer<
  typeof getAssetDownloadUrlResponseSchema
>;

export const probeAssetResponseSchema = z.object({
  queued: z.boolean(),
  workflowId: z.string(),
});
export type ProbeAssetResponse = z.infer<typeof probeAssetResponseSchema>;
