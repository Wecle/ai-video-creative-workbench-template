import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { z } from "zod";
import { mediaProbeInputSchema, mediaProbeResultSchema } from "../src/media";

const file = fileURLToPath(
  new URL("../schemas/media-probe.json", import.meta.url),
);
mkdirSync(dirname(file), { recursive: true });

const content = {
  input: z.toJSONSchema(mediaProbeInputSchema, { io: "input" }),
  output: z.toJSONSchema(mediaProbeResultSchema, { io: "output" }),
};

const options = (await resolveConfig(file)) ?? {};
writeFileSync(
  file,
  await format(JSON.stringify(content), {
    ...options,
    filepath: file,
  }),
);
console.log("wrote", file);
