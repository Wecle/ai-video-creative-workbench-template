import { canvasPatchSchema } from "@creative/contracts";
import type { ToolDescriptor } from "./types";

export const canvasApplyPatchTool: ToolDescriptor = {
  name: "canvas.applyPatch",
  description: "Apply atomic patch of operations to canvas nodes and edges",
  risk: "write",
  inputSchema: canvasPatchSchema,
};
