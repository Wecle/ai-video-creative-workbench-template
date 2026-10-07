import type * as Y from "yjs";
import type { CanvasSnapshot } from "@creative/contracts";
import { ORIGIN, createCanvasDoc, edgesOf, transact } from "./doc";
import { edgeId } from "./graph";
import { writeNode } from "./ops";

/**
 * Builds a document holding `snapshot`.
 * Input must already be validated (e.g. from server snapshot).
 */
export function docFromSnapshot(snapshot: CanvasSnapshot): Y.Doc {
  const doc = createCanvasDoc();
  transact(doc, ORIGIN.load, () => {
    for (const node of snapshot.nodes) writeNode(doc, node);
    for (const edge of snapshot.edges) {
      const value = {
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
      };
      edgesOf(doc).set(edgeId(value), value);
    }
  });
  return doc;
}
