import { GetBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createMemoryStorage, createS3Storage } from "../src";

const endpoint = process.env.S3_ENDPOINT || "http://127.0.0.1:8333";
const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || endpoint;
const accessKeyId = process.env.S3_ACCESS_KEY || "creative-dev";
const secretAccessKey =
  process.env.S3_SECRET_KEY || "creative-dev-secret-0123456789abcdef";
const bucket = process.env.S3_BUCKET || "creative-assets";

if (!endpoint && process.env.CI) {
  throw new Error("S3_ENDPOINT is required in CI");
}

describe("MemoryStorage", () => {
  it("implements ObjectStorage contract", async () => {
    const storage = createMemoryStorage();
    expect(await storage.head("missing")).toBeNull();

    storage.put("file.txt", "hello", "text/plain");
    const head = await storage.head("file.txt");
    expect(head).toEqual({ sizeBytes: 5, contentType: "text/plain" });

    const download = await storage.presignDownload({
      key: "file.txt",
      expiresIn: 60,
    });
    expect(download.url).toContain("memory://");

    const upload = await storage.presignUpload({
      key: "new.txt",
      contentType: "text/plain",
      sizeBytes: 10,
      expiresIn: 60,
    });
    expect(upload.method).toBe("PUT");
    expect(upload.headers["content-type"]).toBe("text/plain");

    await storage.delete("file.txt");
    expect(await storage.head("file.txt")).toBeNull();
  });
});

describe.skipIf(!endpoint)("S3Storage Integration", () => {
  const storage = createS3Storage({
    endpoint,
    publicEndpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  });

  const rawClient = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  it("returns null for non-existent key", async () => {
    const res = await storage.head(`non-existent-${Date.now()}`);
    expect(res).toBeNull();
  });

  it("supports presigned PUT, exact upload, head, presigned GET, and delete", async () => {
    const key = `test-${Date.now()}/sample.txt`;
    const content = "Hello SeaweedFS S3!";
    const buffer = Buffer.from(content, "utf-8");
    const contentType = "text/plain";

    // 1. Presign Upload
    const upload = await storage.presignUpload({
      key,
      contentType,
      sizeBytes: buffer.byteLength,
      expiresIn: 300,
    });
    expect(upload.method).toBe("PUT");
    expect(upload.headers["content-type"]).toBe(contentType);
    expect(upload.url).toContain(key);

    // 2. Perform accurate PUT upload
    const putRes = await fetch(upload.url, {
      method: "PUT",
      headers: {
        "content-type": contentType,
      },
      body: buffer,
    });
    expect(putRes.ok).toBe(true);

    // 3. Head returns size and content type
    const headRes = await storage.head(key);
    expect(headRes).toEqual({
      sizeBytes: buffer.byteLength,
      contentType,
    });

    // 4. Presign Download and verify content
    const download = await storage.presignDownload({
      key,
      expiresIn: 300,
    });
    const getRes = await fetch(download.url);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe(content);

    // 5. Delete removes object
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
  });

  it("rejects PUT when content-type does not match signature", async () => {
    const key = `test-${Date.now()}/wrong-type.txt`;
    const buffer = Buffer.from("data", "utf-8");

    const upload = await storage.presignUpload({
      key,
      contentType: "text/plain",
      sizeBytes: buffer.byteLength,
      expiresIn: 300,
    });

    // Attempt upload with wrong Content-Type
    const putRes = await fetch(upload.url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: buffer,
    });
    expect(putRes.status).toBe(403);
  });

  it("rejects PUT when body size does not match signature", async () => {
    const key = `test-${Date.now()}/wrong-size.txt`;
    const declaredSize = 100;
    const actualBuffer = Buffer.from("short payload", "utf-8"); // 13 bytes

    const upload = await storage.presignUpload({
      key,
      contentType: "text/plain",
      sizeBytes: declaredSize,
      expiresIn: 300,
    });

    // Attempt upload with mismatched size
    const putRes = await fetch(upload.url, {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
      },
      body: actualBuffer,
    });
    expect(putRes.status).toBe(403);
  });

  it("configures CORS and handles preflight correctly", async () => {
    const allowedOrigin = "http://allowed.example.com";
    await storage.configureCors([allowedOrigin]);

    // Verify GetBucketCorsCommand reflects rules
    const corsRes = await rawClient.send(
      new GetBucketCorsCommand({ Bucket: bucket }),
    );
    expect(corsRes.CORSRules?.[0]?.AllowedOrigins).toContain(allowedOrigin);

    // Test preflight on allowed origin -> 200
    const allowedPreflight = await fetch(
      `${endpoint}/${bucket}/cors-test-${Date.now()}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: allowedOrigin,
          "Access-Control-Request-Method": "PUT",
        },
      },
    );
    expect(allowedPreflight.status).toBe(200);
    expect(allowedPreflight.headers.get("access-control-allow-origin")).toBe(
      allowedOrigin,
    );

    // Test preflight on disallowed origin -> 403
    const disallowedPreflight = await fetch(
      `${endpoint}/${bucket}/cors-test-${Date.now()}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://disallowed.example.com",
          "Access-Control-Request-Method": "PUT",
        },
      },
    );
    expect(disallowedPreflight.status).toBe(403);
  });
});
