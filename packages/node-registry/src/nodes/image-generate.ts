import { z } from "zod";
import { defineNode } from "../registry";

export const imageGenerateNode = defineNode({
  type: "image.generate",
  version: 1,
  inputs: [{ id: "prompt", type: "text" }],
  outputs: [{ id: "image", type: "image" }],
  config: z.strictObject({
    prompt: z.string().max(4000).default(""),
    aspectRatio: z.enum(["1:1", "16:9", "9:16"]).default("1:1"),
  }),
  // Placeholder number: replace with the real provider pricing.
  estimateCost: () => ({ credits: 4 }),
});
