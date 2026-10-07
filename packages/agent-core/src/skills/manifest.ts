import { z } from "zod";

export const skillManifestSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, "Skill name must be kebab-case/lowercase"),
  description: z.string().min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "Skill version must be semver"),
  allowedTools: z.array(z.string().min(1).max(128)),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  recommendedModels: z
    .record(
      z.string(),
      z.strictObject({
        provider: z.string().min(1).max(64),
        modelId: z.string().min(1).max(64),
      }),
    )
    .optional(),
});

export type SkillManifest = z.infer<typeof skillManifestSchema>;
