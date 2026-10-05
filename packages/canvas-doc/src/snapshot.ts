import * as Y from "yjs";
import { canvasSnapshotSchema, type CanvasSnapshot } from "@creative/contracts";
import type { Registry } from "@creative/node-registry";
import {
  SCHEMA_VERSION,
  edgesOf,
  metaOf,
  nodesOf,
  type EdgeValue,
} from "./doc";
import { checkEdgePorts, cycleClosers, edgeId, type GraphNode } from "./graph";
import type { ConnectionErrorCode } from "./result";

/**
 * Plain-JSON view of the document, sorted by id so equal documents give equal output.
 * Typed as a snapshot but not guaranteed valid (a document from outside may be malformed):
 * run `validateSnapshot` on anything you did not build yourself.
 */
export function readSnapshot(doc: Y.Doc): CanvasSnapshot {
  const nodes: unknown[] = [];
  nodesOf(doc).forEach((value, id) => {
    const body = value instanceof Y.Map ? value.toJSON() : { value };
    nodes.push({ ...body, id });
  });
  const edges: unknown[] = [];
  edgesOf(doc).forEach((value, id) =>
    edges.push({ ...(typeof value === "object" ? value : {}), id }),
  );
  const byId = (a: unknown, b: unknown) => {
    const x = (a as { id: string }).id;
    const y = (b as { id: string }).id;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return {
    schemaVersion: (metaOf(doc).get("schemaVersion") ??
      SCHEMA_VERSION) as typeof SCHEMA_VERSION,
    nodes: nodes.sort(byId),
    edges: edges.sort(byId),
  } as CanvasSnapshot;
}

export type IssueCode =
  | "invalid-shape"
  | "invalid-state"
  | "unsupported-schema"
  | "duplicate-node"
  | "unknown-node-type"
  | "invalid-config"
  | "edge-id"
  | "duplicate-edge"
  | ConnectionErrorCode;

/** Where and what, never the offending value (configs may hold user prompts). */
export type Issue = { code: IssueCode; path: (string | number)[] };

/**
 * Everything the server must enforce before accepting a canvas: strict structure, known
 * node types and versions, configs valid for their node, edges with real endpoints and
 * compatible ports, no duplicate edges, no cycles. Empty array = valid.
 */
export function validateSnapshot(input: unknown, registry: Registry): Issue[] {
  const issues: Issue[] = [];
  const parsed = canvasSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      issues.push({
        code: "invalid-shape",
        path: issue.path.map((part) =>
          typeof part === "symbol" ? String(part) : part,
        ),
      });
    return issues;
  }
  const snapshot = parsed.data;

  const nodes = new Map<string, GraphNode>();
  snapshot.nodes.forEach((node, index) => {
    if (nodes.has(node.id)) {
      issues.push({ code: "duplicate-node", path: ["nodes", index] });
      return;
    }
    const definition = registry.get(node.type, node.version);
    if (!definition) {
      issues.push({ code: "unknown-node-type", path: ["nodes", index] });
      return;
    }
    nodes.set(node.id, { id: node.id, type: node.type, version: node.version });
    if (!definition.config.safeParse(node.config).success)
      issues.push({ code: "invalid-config", path: ["nodes", index, "config"] });
  });

  const seen = new Set<string>();
  const acyclicCandidates: { key: string; edge: EdgeValue }[] = [];
  snapshot.edges.forEach((edge, index) => {
    const path = ["edges", index];
    const value: EdgeValue = {
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
    };
    if (edge.id !== edgeId(value)) {
      issues.push({ code: "edge-id", path });
      return;
    }
    if (seen.has(edge.id)) {
      issues.push({ code: "duplicate-edge", path });
      return;
    }
    seen.add(edge.id);
    const portError =
      edge.source === edge.target && nodes.has(edge.source)
        ? "self-loop"
        : checkEdgePorts(nodes, registry, value);
    if (portError) {
      issues.push({ code: portError, path });
      return;
    }
    acyclicCandidates.push({ key: String(index), edge: value });
  });
  for (const key of cycleClosers(acyclicCandidates))
    issues.push({ code: "cycle", path: ["edges", Number(key)] });
  return issues;
}
