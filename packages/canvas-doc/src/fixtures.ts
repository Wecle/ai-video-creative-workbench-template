import type * as Y from "yjs";
import type { CanvasSnapshot } from "@creative/contracts";
import { docFromSnapshot } from "./from-snapshot";

export { docFromSnapshot };

/**
 * Example content for tests and documentation only (nodes sorted by id, like `readSnapshot`); production code never seeds canvases
 * (new canvases start empty).
 */
export const demoSnapshot: CanvasSnapshot = {
  schemaVersion: 1,
  nodes: [
    {
      id: "image-1",
      type: "image.generate",
      version: 1,
      title: "Key visual",
      position: { x: 440, y: 90 },
      config: { prompt: "", aspectRatio: "16:9" },
    },
    {
      id: "text-1",
      type: "text",
      version: 1,
      title: "Creative brief",
      position: { x: 80, y: 140 },
      config: { text: "A calm morning in a seaside town" },
    },
  ],
  edges: [
    {
      id: "text-1:text->image-1:prompt",
      source: "text-1",
      sourceHandle: "text",
      target: "image-1",
      targetHandle: "prompt",
    },
  ],
};
export function buildDemoDoc(): Y.Doc {
  return docFromSnapshot(demoSnapshot);
}
