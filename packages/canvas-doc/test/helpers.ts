import { z } from "zod";
import {
  createRegistry,
  defineNode,
  nodeDefinitions,
} from "@creative/node-registry";

/** text in, text out: the shipped examples cannot form a cycle, this one can. */
export const transformNode = defineNode({
  type: "text.transform",
  version: 1,
  inputs: [{ id: "in", type: "text" }],
  outputs: [{ id: "out", type: "text" }],
  config: z.strictObject({}),
});
export const testRegistry = createRegistry([...nodeDefinitions, transformNode]);

export const at = (x = 0, y = 0) => ({ x, y });
