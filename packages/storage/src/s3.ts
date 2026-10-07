import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  HeadResult,
  ObjectStorage,
  PresignDownloadInput,
  PresignDownloadResult,
  PresignUploadInput,
  PresignUploadResult,
} from "./types";

export type S3StorageConfig = {
  endpoint: string;
  publicEndpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
};

export function createS3Storage(config: S3StorageConfig): ObjectStorage {
  const internalClient = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? "us-east-1",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle ?? true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  const publicClient = new S3Client({
    endpoint: config.publicEndpoint ?? config.endpoint,
    region: config.region ?? "us-east-1",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle ?? true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return {
    async presignUpload(i: PresignUploadInput): Promise<PresignUploadResult> {
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: i.key,
        ContentType: i.contentType,
        ContentLength: i.sizeBytes,
      });

      const url = await getSignedUrl(publicClient, command, {
        expiresIn: i.expiresIn,
        signableHeaders: new Set(["content-type", "content-length"]),
      });

      return {
        url,
        method: "PUT",
        headers: {
          "content-type": i.contentType,
        },
      };
    },

    async presignDownload(
      i: PresignDownloadInput,
    ): Promise<PresignDownloadResult> {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: i.key,
      });

      const url = await getSignedUrl(publicClient, command, {
        expiresIn: i.expiresIn,
      });

      return { url };
    },

    async head(key: string): Promise<HeadResult | null> {
      try {
        const command = new HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        });
        const res = await internalClient.send(command);
        return {
          sizeBytes: res.ContentLength ?? 0,
          contentType: res.ContentType ?? "application/octet-stream",
        };
      } catch (err: unknown) {
        const errorName = (err as { name?: string })?.name;
        const statusCode = (err as { $metadata?: { httpStatusCode?: number } })
          ?.$metadata?.httpStatusCode;
        if (
          errorName === "NotFound" ||
          errorName === "NoSuchKey" ||
          statusCode === 404
        ) {
          return null;
        }
        throw err;
      }
    },

    async delete(key: string): Promise<void> {
      const command = new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      });
      await internalClient.send(command);
    },

    async configureCors(origins: string[]): Promise<void> {
      const command = new PutBucketCorsCommand({
        Bucket: config.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,
              AllowedMethods: ["PUT", "GET", "HEAD"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: 600,
            },
          ],
        },
      });
      await internalClient.send(command);
    },
  };
}
