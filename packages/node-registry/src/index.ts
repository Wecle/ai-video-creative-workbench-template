import { createRegistry } from "./registry";
import { imageGenerateNode } from "./nodes/image-generate";
import { textNode } from "./nodes/text";

export * from "./types";
export * from "./registry";
export * from "./json-schema";
export { textNode, imageGenerateNode };

/** Add new node definitions here (and a renderer in apps/web/features/canvas/node-ui.tsx). */
export const nodeDefinitions = [textNode, imageGenerateNode] as const;
export type NodeType = (typeof nodeDefinitions)[number]["type"];
export const registry = createRegistry(nodeDefinitions);
