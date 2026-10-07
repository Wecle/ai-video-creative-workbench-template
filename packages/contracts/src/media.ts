import { z } from "zod";

export const mediaProbeInputSchema = z.strictObject({
  assetKey: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  downloadUrl: z.string().url().optional(),
});
export type MediaProbeInput = z.infer<typeof mediaProbeInputSchema>;

export const mediaProbeResultSchema = z.strictObject({
  assetKey: z.string().min(1),
  kind: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  probedBy: z.literal("media-worker-python"),
  pythonVersion: z.string().min(1),
});
export type MediaProbeResult = z.infer<typeof mediaProbeResultSchema>;
