import * as Y from "yjs";
import {
  registry as defaultRegistry,
  type Registry,
} from "@creative/node-registry";
import { ORIGIN, edgesOf, transact, type EdgeValue } from "./doc";
import { checkEdgePorts, cycleClosers, edgeId, readGraph } from "./graph";

/**
 * Restores the graph invariants after something other than a validated operation changed
 * the document: an undo that removed a node an agent had already connected to, two
 * replicas adding edges that together form a cycle, ...
 *
 * Removes edges that are malformed, dangling, port-incompatible, or that close a cycle
 * (edges are considered in edgeId order, the later one goes). Written with origin `repair`,
 * which the undo history does not track: a repaired-away edge is not brought back by redo.
 * Returns the number of removed edges.
 */
export function repairDocument(
  doc: Y.Doc,
  registry: Registry = defaultRegistry,
): number {
  const nodes = new Map(readGraph(doc).nodes.map((node) => [node.id, node]));
  const edges = edgesOf(doc);
  const remove = new Set<string>();
  const kept: { key: string; edge: EdgeValue }[] = [];
  edges.forEach((value, key) => {
    const edge = value as unknown;
    const valid =
      typeof edge === "object" &&
      edge !== null &&
      [
        (edge as EdgeValue).source,
        (edge as EdgeValue).sourceHandle,
        (edge as EdgeValue).target,
        (edge as EdgeValue).targetHandle,
      ].every((part) => typeof part === "string") &&
      edgeId(edge as EdgeValue) === key &&
      (edge as EdgeValue).source !== (edge as EdgeValue).target &&
      checkEdgePorts(nodes, registry, edge as EdgeValue) === null;
    if (valid) kept.push({ key, edge: edge as EdgeValue });
    else remove.add(key);
  });
  for (const key of cycleClosers(kept)) remove.add(key);
  if (remove.size > 0)
    transact(doc, ORIGIN.repair, () => {
      for (const key of remove) edges.delete(key);
    });
  return remove.size;
}
