export interface PresignUploadInput {
  key: string;
  contentType: string;
  sizeBytes: number;
  expiresIn: number;
}

export interface PresignUploadResult {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface PresignDownloadInput {
  key: string;
  expiresIn: number;
}

export interface PresignDownloadResult {
  url: string;
}

export interface HeadResult {
  sizeBytes: number;
  contentType: string;
}

export interface ObjectStorage {
  presignUpload(i: PresignUploadInput): Promise<PresignUploadResult>;
  presignDownload(i: PresignDownloadInput): Promise<PresignDownloadResult>;
  head(key: string): Promise<HeadResult | null>;
  delete(key: string): Promise<void>;
  configureCors(origins: string[]): Promise<void>;
}
