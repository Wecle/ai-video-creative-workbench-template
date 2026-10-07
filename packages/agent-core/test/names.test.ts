import { describe, expect, it } from "vitest";
import { fromModelToolName, toModelToolName } from "../src/pure";
import {
  createToolRegistry,
  type ToolDescriptor,
  type ToolProvider,
} from "../src/tools";
import { canvasApplyPatchTool } from "../src/tools/canvas-apply-patch";

describe("tool names and registry", () => {
  it("converts tool names to and from model tool names", () => {
    expect(toModelToolName("canvas.applyPatch")).toBe("canvas_applyPatch");
    expect(fromModelToolName("canvas_applyPatch")).toBe("canvas.applyPatch");

    expect(toModelToolName("skill.load")).toBe("skill_load");
    expect(fromModelToolName("skill_load")).toBe("skill.load");
  });

  it("detects name collisions in tool registry", () => {
    const provider1: ToolProvider = {
      id: "p1",
      kind: "builtin",
      list: () => [canvasApplyPatchTool],
      execute: async () => ({ ok: true, summary: "ok" }),
    };

    // Duplicate exact name
    const providerDup: ToolProvider = {
      id: "p2",
      kind: "builtin",
      list: () => [canvasApplyPatchTool],
      execute: async () => ({ ok: true, summary: "ok" }),
    };
    expect(() => createToolRegistry([provider1, providerDup])).toThrow(
      "Duplicate tool registration: 'canvas.applyPatch'",
    );

    // Collision on converted model tool name (e.g. canvas.applyPatch vs canvas_applyPatch)
    const collidingTool: ToolDescriptor = {
      ...canvasApplyPatchTool,
      name: "canvas_applyPatch",
    };
    const providerColliding: ToolProvider = {
      id: "p3",
      kind: "builtin",
      list: () => [collidingTool],
      execute: async () => ({ ok: true, summary: "ok" }),
    };
    expect(() => createToolRegistry([provider1, providerColliding])).toThrow(
      "Model tool name collision",
    );
  });
});
