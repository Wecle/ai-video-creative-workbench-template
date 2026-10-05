import { z } from "zod";
import type { Registry } from "./registry";

export type NodeJsonSchema = {
  type: string;
  version: number;
  inputs: readonly { id: string; type: string }[];
  outputs: readonly { id: string; type: string }[];
  config: unknown;
};

/**
 * Machine-readable node catalogue keyed by "<type>@<version>". `config` uses the *input*
 * form: fields with defaults are optional, which is what an agent submitting a node needs.
 * The committed copy is schemas/nodes.json (`pnpm --filter @creative/node-registry generate`).
 */
export function toJsonSchemas(
  registry: Registry,
): Record<string, NodeJsonSchema> {
  const result: Record<string, NodeJsonSchema> = {};
  for (const def of registry.list())
    result[`${def.type}@${def.version}`] = {
      type: def.type,
      version: def.version,
      inputs: def.inputs,
      outputs: def.outputs,
      config: z.toJSONSchema(def.config, { io: "input" }),
    };
  return result;
}
