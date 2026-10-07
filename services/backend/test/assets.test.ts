import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ASSET_MAX_BYTES } from "@creative/contracts";
import { schema } from "@creative/database";
import { createMemoryStorage } from "@creative/storage";
import type { AssetProbeService } from "../src/temporal/asset-probes";
import {
  createTestApp,
  createUserWithWorkspace,
  signedHeaders,
  testDatabaseUrl,
} from "./helpers";

const { assets } = schema;
const dbUrl = testDatabaseUrl();

describe.skipIf(!dbUrl)("backend assets routes", () => {
  const storage = createMemoryStorage();
  const { app, db, close } = createTestApp(dbUrl, { storage });
  const noStorageApp = createTestApp(dbUrl).app;

  afterAll(async () => {
    await close();
  });

  const who = (userId: string) => ({ authType: "jwt" as const, userId });

  it("handles upload-url validation and authorization", async () => {
    const owner = await createUserWithWorkspace(db, "asset-owner");
    const other = await createUserWithWorkspace(db, "asset-other");

    // 1. Non-member -> 404
    const nonMemberRes = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(other.userId),
      ),
      payload: {
        workspaceId: owner.workspaceId,
        contentType: "image/png",
        sizeBytes: 1024,
      },
    });
    expect(nonMemberRes.statusCode).toBe(404);

    // 2. Type not in whitelist -> 400
    const invalidTypeRes = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(owner.userId),
      ),
      payload: {
        workspaceId: owner.workspaceId,
        contentType: "application/pdf",
        sizeBytes: 1024,
      },
    });
    expect(invalidTypeRes.statusCode).toBe(400);

    // 3. sizeBytes = 0 -> 400
    const zeroSizeRes = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(owner.userId),
      ),
      payload: {
        workspaceId: owner.workspaceId,
        contentType: "image/png",
        sizeBytes: 0,
      },
    });
    expect(zeroSizeRes.statusCode).toBe(400);

    // 4. sizeBytes negative -> 400
    const negSizeRes = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(owner.userId),
      ),
      payload: {
        workspaceId: owner.workspaceId,
        contentType: "image/png",
        sizeBytes: -10,
      },
    });
    expect(negSizeRes.statusCode).toBe(400);

    // 5. sizeBytes float -> 400
    const floatSizeRes = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(owner.userId),
      ),
      payload: {
        workspaceId: owner.workspaceId,
        contentType: "image/png",
        sizeBytes: 10.5,
      },
    });
    expect(floatSizeRes.statusCode).toBe(400);

    // 6. sizeBytes > ASSET_MAX_BYTES -> 400
    const tooLargeRes = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(owner.userId),
      ),
      payload: {
        workspaceId: owner.workspaceId,
        contentType: "image/png",
        sizeBytes: ASSET_MAX_BYTES + 1,
      },
    });
    expect(tooLargeRes.statusCode).toBe(400);

    // 7. Storage not configured -> 503
    const noStorageRes = await noStorageApp.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(owner.userId),
      ),
      payload: {
        workspaceId: owner.workspaceId,
        contentType: "image/png",
        sizeBytes: 1024,
      },
    });
    expect(noStorageRes.statusCode).toBe(503);

    // 8. Success: returns upload info, creates pending asset with server-controlled key
    const successRes = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(owner.userId),
      ),
      payload: {
        workspaceId: owner.workspaceId,
        contentType: "image/png",
        sizeBytes: 1024,
      },
    });
    expect(successRes.statusCode).toBe(200);
    const successData = successRes.json();
    expect(successData.asset.status).toBe("pending");
    expect(successData.upload.url).toContain("memory://");
    expect(successData.upload.method).toBe("PUT");

    const [dbRow] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, successData.asset.id));
    expect(dbRow).toBeDefined();
    expect(dbRow?.key).toBe(
      `workspaces/${owner.workspaceId}/assets/${successData.asset.id}`,
    );
  });

  it("handles asset completion with head validation, deletion on mismatch, and idempotency", async () => {
    const user = await createUserWithWorkspace(db, "comp-user");
    const other = await createUserWithWorkspace(db, "comp-other");

    // Create a pending asset
    const uploadRes = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(user.userId),
      ),
      payload: {
        workspaceId: user.workspaceId,
        contentType: "image/png",
        sizeBytes: 4,
      },
    });
    const assetId = uploadRes.json().asset.id;
    const [assetRow] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId));
    expect(assetRow).toBeDefined();

    // 1. Non-member -> 404
    const nonMemberRes = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/complete`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${assetId}/complete`,
        who(other.userId),
      ),
    });
    expect(nonMemberRes.statusCode).toBe(404);

    // 2. Object not uploaded yet -> 409
    const notUploadedRes = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/complete`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${assetId}/complete`,
        who(user.userId),
      ),
    });
    expect(notUploadedRes.statusCode).toBe(409);

    // 3. Size mismatch -> 422 and deletes both object in storage and row in database
    storage.put(assetRow!.key, "12345678", "image/png"); // 8 bytes instead of 4
    const sizeMismatchRes = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/complete`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${assetId}/complete`,
        who(user.userId),
      ),
    });
    expect(sizeMismatchRes.statusCode).toBe(422);
    // Verified object deleted from storage
    expect(await storage.head(assetRow!.key)).toBeNull();
    // Verified row deleted from database
    const [deletedRow] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId));
    expect(deletedRow).toBeUndefined();

    // 3b. Size mismatch when storage.delete throws: database row is STILL deleted
    const mismatch2 = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(user.userId),
      ),
      payload: {
        workspaceId: user.workspaceId,
        contentType: "image/png",
        sizeBytes: 10,
      },
    });
    const assetIdErr = mismatch2.json().asset.id;
    const [assetRowErr] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetIdErr));
    await storage.put(assetRowErr!.key, "mismatch", "image/png");
    const origDelete = storage.delete.bind(storage);
    storage.delete = vi
      .fn()
      .mockRejectedValue(new Error("Storage delete failure"));
    const delErrRes = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetIdErr}/complete`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${assetIdErr}/complete`,
        who(user.userId),
      ),
    });
    expect(delErrRes.statusCode).toBe(422);
    const [rowStillDeleted] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetIdErr));
    expect(rowStillDeleted).toBeUndefined();
    storage.delete = origDelete;

    // 4. Create another asset for successful completion
    const up2 = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(user.userId),
      ),
      payload: {
        workspaceId: user.workspaceId,
        contentType: "image/jpeg",
        sizeBytes: 5,
      },
    });
    const assetId2 = up2.json().asset.id;
    const [assetRow2] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId2));

    // Put matching object in storage
    storage.put(assetRow2!.key, "hello", "image/jpeg"); // 5 bytes, image/jpeg

    // Complete succeeds -> 200, status becomes ready
    const comp2 = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId2}/complete`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${assetId2}/complete`,
        who(user.userId),
      ),
    });
    expect(comp2.statusCode).toBe(200);
    expect(comp2.json().asset.status).toBe("ready");

    // 5. Repeat call on ready asset is idempotent -> 200
    const repeatRes = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId2}/complete`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${assetId2}/complete`,
        who(user.userId),
      ),
    });
    expect(repeatRes.statusCode).toBe(200);
    expect(repeatRes.json().asset.status).toBe("ready");
  });

  it("handles GET /assets/:assetId and download-url authorization", async () => {
    const user = await createUserWithWorkspace(db, "get-user");
    const other = await createUserWithWorkspace(db, "get-other");

    const up = await app.inject({
      method: "POST",
      url: "/api/v1/assets/upload-url",
      headers: signedHeaders(
        "POST",
        "/api/v1/assets/upload-url",
        who(user.userId),
      ),
      payload: {
        workspaceId: user.workspaceId,
        contentType: "image/webp",
        sizeBytes: 6,
      },
    });
    const assetId = up.json().asset.id;

    // 1. GET metadata
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}`,
      headers: signedHeaders(
        "GET",
        `/api/v1/assets/${assetId}`,
        who(user.userId),
      ),
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().asset.id).toBe(assetId);

    // Non-member GET -> 404
    const otherGet = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}`,
      headers: signedHeaders(
        "GET",
        `/api/v1/assets/${assetId}`,
        who(other.userId),
      ),
    });
    expect(otherGet.statusCode).toBe(404);

    // 2. Download url when not ready -> 409
    const notReadyDl = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}/download-url`,
      headers: signedHeaders(
        "GET",
        `/api/v1/assets/${assetId}/download-url`,
        who(user.userId),
      ),
    });
    expect(notReadyDl.statusCode).toBe(409);

    // Complete the asset
    const [row] = await db.select().from(assets).where(eq(assets.id, assetId));
    storage.put(row!.key, "123456", "image/webp");
    await app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/complete`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${assetId}/complete`,
        who(user.userId),
      ),
    });

    // 3. Download url when ready -> 200
    const readyDl = await app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}/download-url`,
      headers: signedHeaders(
        "GET",
        `/api/v1/assets/${assetId}/download-url`,
        who(user.userId),
      ),
    });
    expect(readyDl.statusCode).toBe(200);
    expect(readyDl.json().url).toContain("memory://");
  });

  it("handles asset probe authorization, state checks, and workflow triggering", async () => {
    let probedAssetId: string | null = null;
    let shouldFail = false;

    const mockProbes: AssetProbeService = {
      async start(assetId: string) {
        if (shouldFail) {
          throw new Error("Temporal connection failure");
        }
        probedAssetId = assetId;
        return { queued: true, workflowId: `asset-probe:${assetId}` };
      },
    };

    const probeApp = createTestApp(dbUrl, {
      storage,
      assetProbes: mockProbes,
    }).app;

    const user = await createUserWithWorkspace(db, "probe-user");
    const other = await createUserWithWorkspace(db, "probe-other");

    // Insert pending asset
    const [pendingRow] = await db
      .insert(assets)
      .values({
        workspaceId: user.workspaceId,
        key: `workspaces/${user.workspaceId}/assets/pending-p`,
        contentType: "image/png",
        sizeBytes: 100,
        status: "pending",
        createdBy: user.userId,
      })
      .returning();

    // Insert ready asset
    const [readyRow] = await db
      .insert(assets)
      .values({
        workspaceId: user.workspaceId,
        key: `workspaces/${user.workspaceId}/assets/ready-p`,
        contentType: "image/png",
        sizeBytes: 200,
        status: "ready",
        createdBy: user.userId,
      })
      .returning();

    // 1. Non-existent asset -> 404
    const notFoundId = randomUUID();
    const notFoundRes = await probeApp.inject({
      method: "POST",
      url: `/api/v1/assets/${notFoundId}/probe`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${notFoundId}/probe`,
        who(user.userId),
      ),
    });
    expect(notFoundRes.statusCode).toBe(404);

    // 2. Non-member asset -> 404
    const nonMemberRes = await probeApp.inject({
      method: "POST",
      url: `/api/v1/assets/${readyRow!.id}/probe`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${readyRow!.id}/probe`,
        who(other.userId),
      ),
    });
    expect(nonMemberRes.statusCode).toBe(404);

    // 3. Pending asset -> 409
    const pendingRes = await probeApp.inject({
      method: "POST",
      url: `/api/v1/assets/${pendingRow!.id}/probe`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${pendingRow!.id}/probe`,
        who(user.userId),
      ),
    });
    expect(pendingRes.statusCode).toBe(409);

    // 4. Ready asset -> 202
    const readyRes = await probeApp.inject({
      method: "POST",
      url: `/api/v1/assets/${readyRow!.id}/probe`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${readyRow!.id}/probe`,
        who(user.userId),
      ),
    });
    expect(readyRes.statusCode).toBe(202);
    expect(readyRes.json()).toEqual({
      queued: true,
      workflowId: `asset-probe:${readyRow!.id}`,
    });
    expect(probedAssetId).toBe(readyRow!.id);

    // 5. Temporal failure -> 503
    shouldFail = true;
    const failRes = await probeApp.inject({
      method: "POST",
      url: `/api/v1/assets/${readyRow!.id}/probe`,
      headers: signedHeaders(
        "POST",
        `/api/v1/assets/${readyRow!.id}/probe`,
        who(user.userId),
      ),
    });
    expect(failRes.statusCode).toBe(503);
  });
});
