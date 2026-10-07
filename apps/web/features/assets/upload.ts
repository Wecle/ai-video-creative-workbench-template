import {
  ASSET_CONTENT_TYPES,
  ASSET_MAX_BYTES,
  type AssetContentType,
  type AssetSummary,
} from "@creative/contracts";

export type UploadAssetOptions = {
  file: File;
  workspaceId: string;
  api: {
    requestAssetUpload: (input: {
      workspaceId: string;
      contentType: AssetContentType;
      sizeBytes: number;
    }) => Promise<{
      asset: { id: string; status: string };
      upload: {
        url: string;
        method: "PUT";
        headers: Record<string, string>;
        expiresIn: number;
      };
    }>;
    completeAsset: (assetId: string) => Promise<{ asset: AssetSummary }>;
  };
};

export class AssetValidationError extends Error {
  constructor(readonly code: "INVALID_TYPE" | "FILE_TOO_LARGE" | "EMPTY_FILE") {
    super(`Asset validation failed: ${code}`);
    this.name = "AssetValidationError";
  }
}

export async function uploadAsset(
  options: UploadAssetOptions,
): Promise<AssetSummary> {
  const { file, workspaceId, api } = options;

  // 1. Pre-validation
  if (file.size <= 0) {
    throw new AssetValidationError("EMPTY_FILE");
  }
  if (file.size > ASSET_MAX_BYTES) {
    throw new AssetValidationError("FILE_TOO_LARGE");
  }
  if (!ASSET_CONTENT_TYPES.includes(file.type as AssetContentType)) {
    throw new AssetValidationError("INVALID_TYPE");
  }

  // 2. Request upload
  const uploadRes = await api.requestAssetUpload({
    workspaceId,
    contentType: file.type as AssetContentType,
    sizeBytes: file.size,
  });

  // 3. PUT upload to presigned URL
  const putRes = await fetch(uploadRes.upload.url, {
    method: "PUT",
    headers: {
      "content-type": file.type,
    },
    body: file,
  });

  if (!putRes.ok) {
    throw new Error(`Failed to upload asset to storage (${putRes.status})`);
  }

  // 4. Complete asset
  const completeRes = await api.completeAsset(uploadRes.asset.id);
  return completeRes.asset;
}
