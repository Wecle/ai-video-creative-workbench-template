import * as Y from "yjs";
import type { Registry } from "@creative/node-registry";
import { canConnect } from "@creative/node-registry";
import { edgesOf, nodesOf, type EdgeValue } from "./doc";
import { fail, ok, type ConnectionErrorCode, type Result } from "./result";

export type GraphNode = {
  id: string;
  type: string;
  version: number;
};
export type Graph = {
  nodes: readonly GraphNode[];
  edges: readonly EdgeValue[];
};
/** A connection as a UI reports it: handles may be missing. */
export type Connection = {
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
  targetHandle: string | null | undefined;
};

/**
 * Edge ids are derived from their endpoints: a duplicate edge, or the same edge created
 * on two machines at once, lands on the same key and stays a single edge after merging.
 */
export function edgeId(edge: EdgeValue) {
  return `${edge.source}:${edge.sourceHandle}->${edge.target}:${edge.targetHandle}`;
}

/** Plain-data view of the graph (the document, or a UI store converted by the caller). */
export function readGraph(doc: Y.Doc): Graph {
  const nodes: GraphNode[] = [];
  nodesOf(doc).forEach((node, id) => {
    if (!(node instanceof Y.Map)) return;
    nodes.push({
      id,
      type: String(node.get("type")),
      version: Number(node.get("version")),
    });
  });
  const edges: EdgeValue[] = [];
  edgesOf(doc).forEach((edge) => edges.push({ ...edge }));
  return { nodes, edges };
}

/** Can `to` be reached from `from` following edges forwards? O(V+E). */
export function reaches(edges: readonly EdgeValue[], from: string, to: string) {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source);
    if (list) list.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }
  return reachesVia(outgoing, from, to);
}

/** Checks one edge against the node definitions: endpoints, ports and port types. */
export function checkEdgePorts(
  nodes: ReadonlyMap<string, GraphNode>,
  registry: Registry,
  edge: EdgeValue,
): ConnectionErrorCode | null {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return "unknown-node";
  const output = registry
    .get(source.type, source.version)
    ?.outputs.find((port) => port.id === edge.sourceHandle);
  const input = registry
    .get(target.type, target.version)
    ?.inputs.find((port) => port.id === edge.targetHandle);
  if (!output || !input) return "unknown-port";
  if (!canConnect(output.type, input.type)) return "port-type-mismatch";
  return null;
}

/**
 * The single rule set for "may this connection exist": used by the UI before it offers a
 * connection and by `connect` before it writes one. Order: nodes, self-loop, ports,
 * port types, duplicates, cycles.
 */
export function validateConnection(
  graph: Graph,
  registry: Registry,
  connection: Connection,
): Result<EdgeValue, ConnectionErrorCode> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!nodes.has(connection.source) || !nodes.has(connection.target))
    return fail("unknown-node");
  if (connection.source === connection.target) return fail("self-loop");
  if (!connection.sourceHandle || !connection.targetHandle)
    return fail("unknown-port");
  const edge: EdgeValue = {
    source: connection.source,
    sourceHandle: connection.sourceHandle,
    target: connection.target,
    targetHandle: connection.targetHandle,
  };
  const portError = checkEdgePorts(nodes, registry, edge);
  if (portError) return fail(portError);
  const id = edgeId(edge);
  if (graph.edges.some((existing) => edgeId(existing) === id))
    return fail("duplicate-edge");
  if (reaches(graph.edges, edge.target, edge.source)) return fail("cycle");
  return ok(edge);
}

/**
 * Which edges would have to go for the rest to be acyclic: edges are taken in `edgeId`
 * order and one that closes a cycle with the ones already kept is reported. Deterministic,
 * so every replica that repairs the same state removes the same edges. Self-loops are not
 * handled here (callers reject them first).
 */
export function cycleClosers(
  items: readonly { key: string; edge: EdgeValue }[],
): Set<string> {
  const sorted = [...items].sort((a, b) => {
    const x = edgeId(a.edge);
    const y = edgeId(b.edge);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const outgoing = new Map<string, string[]>();
  const closers = new Set<string>();
  for (const { key, edge } of sorted) {
    if (reachesVia(outgoing, edge.target, edge.source)) {
      closers.add(key);
      continue;
    }
    const list = outgoing.get(edge.source);
    if (list) list.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }
  return closers;
}

function reachesVia(
  outgoing: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
) {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    for (const next of outgoing.get(current) ?? [])
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
  }
  return false;
}
