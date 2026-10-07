import * as Y from "yjs";
import { canvasIdSchema } from "@creative/contracts";
import {
  registry as defaultRegistry,
  type Registry,
} from "@creative/node-registry";
import {
  assertWriteOrigin,
  edgesOf,
  nodesOf,
  transact,
  type WriteOrigin,
} from "./doc";
import {
  edgeId,
  readGraph,
  validateConnection,
  type Connection,
} from "./graph";
import { fail, ok, type ConnectionErrorCode, type Result } from "./result";

/*
 * Every write to a canvas goes through one of these. They all take the origin first
 * ("user" for people, "agent" for the Agent): only "user" is undoable. They return a
 * `Result` with a code instead of throwing for business errors, and write nothing on error.
 */

export type Position = { x: number; y: number };
export type NewNode = {
  /** Chosen by the caller (this package generates no random ids). */
  id: string;
  type: string;
  /** Default: the latest registered version. */
  version?: number;
  /** Default: the node type. */
  title?: string;
  position: Position;
  /** Validated against the node's zod schema; missing fields get their defaults. */
  config?: Record<string, unknown>;
};

const MAX_TITLE = 120;
const isPosition = (p: Position) =>
  Number.isFinite(p.x) && Number.isFinite(p.y);
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function normalizeTitle(title: string) {
  const trimmed = title.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_TITLE ? trimmed : null;
}

/** Writes a node (also used to build documents from snapshots). Caller validates. */
export function writeNode(
  doc: Y.Doc,
  node: {
    id: string;
    type: string;
    version: number;
    title: string;
    position: Position;
    config: Record<string, unknown>;
  },
) {
  const entry = new Y.Map<unknown>();
  entry.set("type", node.type);
  entry.set("version", node.version);
  entry.set("title", node.title);
  entry.set("position", { x: node.position.x, y: node.position.y });
  const config = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(node.config ?? {}))
    config.set(key, value);
  entry.set("config", config);
  nodesOf(doc).set(node.id, entry);
}

export function addNode(
  doc: Y.Doc,
  origin: WriteOrigin,
  input: NewNode,
  registry: Registry = defaultRegistry,
): Result<{ id: string }> {
  assertWriteOrigin(origin);
  if (!canvasIdSchema.safeParse(input.id).success) return fail("invalid-id");
  if (nodesOf(doc).has(input.id)) return fail("duplicate-node");
  const definition = registry.get(input.type, input.version);
  if (!definition) return fail("unknown-node-type");
  const title = normalizeTitle(input.title ?? input.type);
  if (title === null) return fail("invalid-title");
  if (!isPosition(input.position)) return fail("invalid-position");
  const config = definition.config.safeParse(input.config ?? {});
  if (!config.success) return fail("invalid-config");
  transact(doc, origin, () =>
    writeNode(doc, {
      id: input.id,
      type: definition.type,
      version: definition.version,
      title,
      position: input.position,
      config: config.data as Record<string, unknown>,
    }),
  );
  return ok({ id: input.id });
}

/** Moves any number of nodes in a single transaction (one undo step, one update). */
export function moveNodes(
  doc: Y.Doc,
  origin: WriteOrigin,
  moves: readonly { id: string; position: Position }[],
): Result {
  assertWriteOrigin(origin);
  const nodes = nodesOf(doc);
  for (const move of moves) {
    if (!(nodes.get(move.id) instanceof Y.Map)) return fail("unknown-node");
    if (!isPosition(move.position)) return fail("invalid-position");
  }
  const changed = moves.filter((move) => {
    const current = (nodes.get(move.id) as Y.Map<unknown>).get("position") as
      Position | undefined;
    return current?.x !== move.position.x || current?.y !== move.position.y;
  });
  if (changed.length === 0) return ok(undefined);
  transact(doc, origin, () => {
    for (const move of changed)
      (nodes.get(move.id) as Y.Map<unknown>).set("position", {
        x: move.position.x,
        y: move.position.y,
      });
  });
  return ok(undefined);
}

export function renameNode(
  doc: Y.Doc,
  origin: WriteOrigin,
  id: string,
  title: string,
): Result {
  assertWriteOrigin(origin);
  const node = nodesOf(doc).get(id);
  if (!(node instanceof Y.Map)) return fail("unknown-node");
  const next = normalizeTitle(title);
  if (next === null) return fail("invalid-title");
  if (node.get("title") !== next)
    transact(doc, origin, () => node.set("title", next));
  return ok(undefined);
}

/**
 * Merges `patch` into the node's config and validates the whole result with the node's zod
 * schema. Only fields whose value changed are written, so concurrent edits of different
 * fields merge.
 */
export function updateConfig(
  doc: Y.Doc,
  origin: WriteOrigin,
  id: string,
  patch: Record<string, unknown>,
  registry: Registry = defaultRegistry,
): Result {
  assertWriteOrigin(origin);
  const node = nodesOf(doc).get(id);
  if (!(node instanceof Y.Map)) return fail("unknown-node");
  const definition = registry.get(
    String(node.get("type")),
    Number(node.get("version")),
  );
  if (!definition) return fail("unknown-node-type");
  const config = node.get("config");
  if (!(config instanceof Y.Map)) return fail("invalid-config");
  const parsed = definition.config.safeParse({ ...config.toJSON(), ...patch });
  if (!parsed.success) return fail("invalid-config");
  const next = parsed.data as Record<string, unknown>;
  const changed = Object.entries(next).filter(
    ([key, value]) => !sameJson(config.get(key), value),
  );
  if (changed.length > 0)
    transact(doc, origin, () => {
      for (const [key, value] of changed) config.set(key, value);
    });
  return ok(undefined);
}

/** Removes nodes together with every edge attached to them, in one transaction. */
export function removeNodes(
  doc: Y.Doc,
  origin: WriteOrigin,
  ids: readonly string[],
): Result {
  assertWriteOrigin(origin);
  const nodes = nodesOf(doc);
  for (const id of ids) if (!nodes.has(id)) return fail("unknown-node");
  const removed = new Set(ids);
  transact(doc, origin, () => {
    const edges = edgesOf(doc);
    edges.forEach((edge, key) => {
      if (removed.has(edge.source) || removed.has(edge.target))
        edges.delete(key);
    });
    for (const id of removed) nodes.delete(id);
  });
  return ok(undefined);
}

export function connect(
  doc: Y.Doc,
  origin: WriteOrigin,
  connection: Connection,
  registry: Registry = defaultRegistry,
): Result<{ id: string }, ConnectionErrorCode> {
  assertWriteOrigin(origin);
  const checked = validateConnection(readGraph(doc), registry, connection);
  if (!checked.ok) return checked;
  const id = edgeId(checked.value);
  transact(doc, origin, () => edgesOf(doc).set(id, checked.value));
  return ok({ id });
}

export function removeEdges(
  doc: Y.Doc,
  origin: WriteOrigin,
  ids: readonly string[],
): Result {
  assertWriteOrigin(origin);
  const edges = edgesOf(doc);
  for (const id of ids) if (!edges.has(id)) return fail("unknown-edge");
  transact(doc, origin, () => {
    for (const id of ids) edges.delete(id);
  });
  return ok(undefined);
}
