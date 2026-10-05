import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { registry, toJsonSchemas } from "../src";

const file = fileURLToPath(new URL("../schemas/nodes.json", import.meta.url));
const options = (await resolveConfig(file)) ?? {};
writeFileSync(
  file,
  await format(JSON.stringify(toJsonSchemas(registry)), {
    ...options,
    filepath: file,
  }),
);
console.log("wrote", file);
