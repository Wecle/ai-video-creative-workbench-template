import type { z } from "zod";
import type { AnyNodeDefinition, NodeDefinition, PortType } from "./types";

/** Keeps the config type (and the literal `type`) of a definition. */
export function defineNode<const T extends string, C extends z.ZodType>(
  definition: NodeDefinition<C> & { readonly type: T },
): NodeDefinition<C> & { readonly type: T } {
  return definition;
}

/**
 * Port compatibility, in one place. P1 rule: identical types only. To allow, say,
 * image -> video later, extend this table and nothing else.
 */
const COMPATIBLE: Readonly<Record<PortType, readonly PortType[]>> = {
  text: ["text"],
  image: ["image"],
  video: ["video"],
  audio: ["audio"],
};
export function canConnect(from: PortType, to: PortType) {
  return COMPATIBLE[from].includes(to);
}

/** The config a freshly added node starts with. */
export function defaultConfig<C extends z.ZodType>(
  definition: NodeDefinition<C>,
): z.output<C> {
  return definition.config.parse({});
}

export type Registry = {
  /** `version` omitted: the latest registered version. */
  get(type: string, version?: number): AnyNodeDefinition | undefined;
  /** Every registered (type, version), sorted by type then version. */
  list(): readonly AnyNodeDefinition[];
  /** The latest version of each type, sorted by type (what a palette shows). */
  latest(): readonly AnyNodeDefinition[];
};

export function createRegistry(
  definitions: readonly AnyNodeDefinition[],
): Registry {
  const byKey = new Map<string, AnyNodeDefinition>();
  for (const definition of definitions) {
    if (!Number.isInteger(definition.version) || definition.version < 1)
      throw new Error(
        `Node ${definition.type}: version must be a positive integer`,
      );
    const key = `${definition.type}@${definition.version}`;
    if (byKey.has(key)) throw new Error(`Duplicate node definition ${key}`);
    byKey.set(key, definition);
  }
  const all = [...byKey.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.version - b.version,
  );
  const latest = new Map<string, AnyNodeDefinition>();
  for (const definition of all) latest.set(definition.type, definition);
  return {
    get: (type, version) =>
      version === undefined
        ? latest.get(type)
        : byKey.get(`${type}@${version}`),
    list: () => all,
    latest: () => [...latest.values()],
  };
}
