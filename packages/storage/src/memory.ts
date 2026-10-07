import type {
  HeadResult,
  ObjectStorage,
  PresignDownloadInput,
  PresignDownloadResult,
  PresignUploadInput,
  PresignUploadResult,
} from "./types";

export interface MemoryStorage extends ObjectStorage {
  put(
    key: string,
    data: Buffer | Uint8Array | string,
    contentType: string,
  ): void;
  get(key: string): { data: Buffer; contentType: string } | null;
  getConfiguredOrigins(): string[];
  clear(): void;
}

export function createMemoryStorage(): MemoryStorage {
  const store = new Map<string, { data: Buffer; contentType: string }>();
  let configuredOrigins: string[] = [];

  return {
    getConfiguredOrigins(): string[] {
      return [...configuredOrigins];
    },
    async presignUpload(i: PresignUploadInput): Promise<PresignUploadResult> {
      return {
        url: `memory://${encodeURIComponent(i.key)}`,
        method: "PUT",
        headers: {
          "content-type": i.contentType,
        },
      };
    },

    async presignDownload(
      i: PresignDownloadInput,
    ): Promise<PresignDownloadResult> {
      return {
        url: `memory://${encodeURIComponent(i.key)}`,
      };
    },

    async head(key: string): Promise<HeadResult | null> {
      const item = store.get(key);
      if (!item) return null;
      return {
        sizeBytes: item.data.byteLength,
        contentType: item.contentType,
      };
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    async configureCors(origins: string[]): Promise<void> {
      configuredOrigins = [...origins];
    },

    put(
      key: string,
      data: Buffer | Uint8Array | string,
      contentType: string,
    ): void {
      const buffer = Buffer.isBuffer(data)
        ? data
        : typeof data === "string"
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      store.set(key, { data: buffer, contentType });
    },

    get(key: string): { data: Buffer; contentType: string } | null {
      const item = store.get(key);
      if (!item) return null;
      return { data: Buffer.from(item.data), contentType: item.contentType };
    },

    clear(): void {
      store.clear();
      configuredOrigins = [];
    },
  };
}
