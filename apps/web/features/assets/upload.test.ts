import { describe, expect, it, vi } from "vitest";
import { uploadAsset, AssetValidationError } from "./upload";

describe("uploadAsset", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";

  it("rejects empty file", async () => {
    const file = new File([], "empty.png", { type: "image/png" });
    const api = {
      requestAssetUpload: vi.fn(),
      completeAsset: vi.fn(),
    };

    await expect(uploadAsset({ file, workspaceId, api })).rejects.toThrow(
      AssetValidationError,
    );
    expect(api.requestAssetUpload).not.toHaveBeenCalled();
  });

  it("rejects file exceeding size limit", async () => {
    // 101 MB
    const largeBlob = new Uint8Array(100);
    const file = new File([largeBlob], "huge.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 101 * 1024 * 1024 });

    const api = {
      requestAssetUpload: vi.fn(),
      completeAsset: vi.fn(),
    };

    await expect(uploadAsset({ file, workspaceId, api })).rejects.toThrow(
      AssetValidationError,
    );
    expect(api.requestAssetUpload).not.toHaveBeenCalled();
  });

  it("rejects unsupported file types", async () => {
    const file = new File(["dummy content"], "doc.pdf", {
      type: "application/pdf",
    });
    const api = {
      requestAssetUpload: vi.fn(),
      completeAsset: vi.fn(),
    };

    await expect(uploadAsset({ file, workspaceId, api })).rejects.toThrow(
      AssetValidationError,
    );
    expect(api.requestAssetUpload).not.toHaveBeenCalled();
  });

  it("completes full upload flow successfully", async () => {
    const file = new File(["test image bytes"], "photo.png", {
      type: "image/png",
    });
    const assetId = "22222222-2222-4222-8222-222222222222";
    const uploadUrl = "http://storage.test/put-url";

    const api = {
      requestAssetUpload: vi.fn().mockResolvedValue({
        asset: { id: assetId, status: "pending" },
        upload: {
          url: uploadUrl,
          method: "PUT",
          headers: { "content-type": "image/png" },
          expiresIn: 300,
        },
      }),
      completeAsset: vi.fn().mockResolvedValue({
        asset: {
          id: assetId,
          workspaceId,
          key: `workspaces/${workspaceId}/assets/${assetId}`,
          contentType: "image/png",
          sizeBytes: file.size,
          status: "ready",
          createdAt: "2026-10-07T00:00:00.000Z",
          updatedAt: "2026-10-07T00:00:00.000Z",
        },
      }),
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const asset = await uploadAsset({ file, workspaceId, api });

    expect(api.requestAssetUpload).toHaveBeenCalledWith({
      workspaceId,
      contentType: "image/png",
      sizeBytes: file.size,
    });
    expect(fetchSpy).toHaveBeenCalledWith(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: file,
    });
    expect(api.completeAsset).toHaveBeenCalledWith(assetId);
    expect(asset.status).toBe("ready");

    fetchSpy.mockRestore();
  });

  it("throws error and skips completion if storage upload fails", async () => {
    const file = new File(["test data"], "photo.png", {
      type: "image/png",
    });
    const assetId = "22222222-2222-4222-8222-222222222222";

    const api = {
      requestAssetUpload: vi.fn().mockResolvedValue({
        asset: { id: assetId, status: "pending" },
        upload: {
          url: "http://storage.test/put-url",
          method: "PUT",
          headers: { "content-type": "image/png" },
          expiresIn: 300,
        },
      }),
      completeAsset: vi.fn(),
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(uploadAsset({ file, workspaceId, api })).rejects.toThrow(
      "Failed to upload asset to storage (403)",
    );
    expect(api.completeAsset).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
