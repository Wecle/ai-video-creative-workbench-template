# @creative/storage

S3-compatible object storage abstraction for the AI Video Creative Workbench.

## Design

- Provides a clean `ObjectStorage` interface decoupled from concrete cloud providers.
- Supports AWS S3, Cloudflare R2, MinIO, and SeaweedFS.
- Supports dual endpoints (`endpoint` for internal backend cluster traffic, `publicEndpoint` for generating signed URLs accessible from client browsers).
- Includes `createMemoryStorage()` for fast unit testing without network dependencies.

## Usage

```ts
import { createS3Storage } from "@creative/storage";

const storage = createS3Storage({
  endpoint: "http://s3:8333",
  publicEndpoint: "http://localhost:8333",
  bucket: "creative-assets",
  accessKeyId: "key",
  secretAccessKey: "secret",
});
```
