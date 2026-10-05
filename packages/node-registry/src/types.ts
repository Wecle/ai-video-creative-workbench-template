import type { z } from "zod";

/** Data kinds that flow along an edge. Compatibility rules live in `canConnect`. */
export type PortType = "text" | "image" | "video" | "audio";
export type PortDef = { readonly id: string; readonly type: PortType };

/**
 * One node kind, versioned. Pure data plus a zod schema: no UI, no strings, no IO, so the
 * same definition can be used by the browser, the backend and (via JSON Schema) agents.
 * Display names and port labels are looked up by convention in the web app's message
 * catalogs: `nodes.<type>.title`, `nodes.<type>.ports.<portId>`.
 */
export type NodeDefinition<C extends z.ZodType = z.ZodType> = {
  /** Dotted, globally unique: "text", "image.generate". */
  readonly type: string;
  /** Positive integer. Bump when `config` becomes incompatible; keep the old version registered. */
  readonly version: number;
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[];
  /**
   * Every field needs a default so that `config.parse({})` succeeds. No transforms:
   * they cannot be expressed as JSON Schema.
   */
  readonly config: C;
  /** Method syntax on purpose: keeps `NodeDefinition<Specific>` assignable to `NodeDefinition`. */
  estimateCost?(config: z.output<C>): { credits: number };
};
export type AnyNodeDefinition = NodeDefinition<z.ZodType>;
