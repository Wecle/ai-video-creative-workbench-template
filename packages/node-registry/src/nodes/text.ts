import { z } from "zod";
import { defineNode } from "../registry";

export const textNode = defineNode({
  type: "text",
  version: 1,
  inputs: [],
  outputs: [{ id: "text", type: "text" }],
  config: z.strictObject({ text: z.string().max(20000).default("") }),
});
