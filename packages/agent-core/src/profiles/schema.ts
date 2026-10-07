import { z } from "zod";

export const agentProfileSchema = z.strictObject({
  id: z.string().min(1).max(64),
  version: z.number().int().positive(),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  persona: z.string().min(1).max(2000),
  systemPrompt: z.string().min(1).max(10000),
  tools: z.array(z.string().min(1).max(128)),
  skills: z.array(z.string().min(1).max(64)),
  defaultModel: z.strictObject({
    provider: z.string().min(1).max(64),
    modelId: z.string().min(1).max(64),
  }),
  approval: z.strictObject({
    threshold: z.enum(["read", "write", "expensive", "destructive"]),
    timeoutSeconds: z.number().int().min(1).max(3600),
  }),
  budget: z.strictObject({
    maxSteps: z.number().int().min(1).max(8),
    maxEstimatedCredits: z.number().min(0),
    creditsPerKiloToken: z.number().min(0),
  }),
  starters: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(100),
        prompt: z.string().min(1).max(1000),
      }),
    )
    .max(6),
});
