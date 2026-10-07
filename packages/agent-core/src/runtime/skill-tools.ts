import { z } from "zod";
import type { ToolDescriptor, ToolProvider } from "../tools/types";
import type { LoadedSkill } from "../skills/runtime/loader";
import { canvasPatchSchema } from "@creative/contracts";

export function createBuiltinToolProvider(): ToolProvider {
  const canvasApplyPatchDescriptor: ToolDescriptor = {
    name: "canvas.applyPatch",
    description: "Apply atomic patch of operations to canvas nodes and edges",
    risk: "write",
    inputSchema: canvasPatchSchema,
  };

  return {
    id: "builtin",
    kind: "builtin",
    list(): readonly ToolDescriptor[] {
      return [canvasApplyPatchDescriptor];
    },
    async execute(call) {
      // Execute does not modify any documents on server side (browser applies it upon 202 approval)
      const input = call.input as
        { patch?: unknown; summary?: string } | undefined;
      const patch = (input?.patch ?? input) as
        Record<string, unknown> | undefined;
      return {
        ok: true,
        summary: (patch?.summary as string) || "Applied canvas patch",
        patch,
      };
    },
  };
}

const skillLoadInputSchema = z.strictObject({
  name: z.string().min(1).max(64),
});

export function createSkillToolProvider(
  skillsMap: Map<string, LoadedSkill>,
  allowedSkillNames?: readonly string[],
): ToolProvider {
  const skillLoadDescriptor: ToolDescriptor = {
    name: "skill.load",
    description: "Load full skill instructions and allowed tools by name",
    risk: "read",
    inputSchema: skillLoadInputSchema,
  };

  return {
    id: "skill",
    kind: "skill",
    list(): readonly ToolDescriptor[] {
      return [skillLoadDescriptor];
    },
    async execute(call) {
      const parsed = skillLoadInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          summary: "Invalid skill name argument",
          code: "invalid_input",
        };
      }
      const skillName = parsed.data.name;

      if (allowedSkillNames && !allowedSkillNames.includes(skillName)) {
        return {
          ok: false,
          summary: `Skill '${skillName}' is not allowed for profile`,
          code: "skill_not_allowed",
        };
      }

      const loaded = skillsMap.get(skillName);
      if (!loaded) {
        return {
          ok: false,
          summary: `Skill '${skillName}' not found`,
          code: "skill_not_found",
        };
      }

      const defaultModel = loaded.manifest.recommendedModels?.["default"] ?? {
        provider: "mock",
        modelId: "scripted-1",
      };

      const header = [
        `Skill: ${loaded.manifest.name} (v${loaded.manifest.version})`,
        `Allowed tools: ${loaded.manifest.allowedTools.join(", ")}`,
        `Recommended model: ${defaultModel.provider}:${defaultModel.modelId}`,
        "---",
      ].join("\n");

      const fullOutput = `${header}\n\n${loaded.content}`;

      return {
        ok: true,
        summary: `Loaded skill '${skillName}' (${loaded.manifest.description})`,
        patch: undefined,
        // The text content is returned via summary or metadata
        content: fullOutput,
      } as { ok: true; summary: string; patch?: unknown; content: string };
    },
  };
}
