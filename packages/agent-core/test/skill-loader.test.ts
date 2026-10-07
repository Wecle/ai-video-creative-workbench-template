import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/skills/runtime/loader";
import { createSkillToolProvider } from "../src/runtime/skill-tools";

describe("skill loader and skill.load tool", () => {
  const repoSkillsDir = path.resolve(__dirname, "../../../capabilities/skills");

  it("loads repository skills directory and finds shot-list skill", () => {
    const skills = loadSkills(repoSkillsDir, ["canvas.applyPatch"]);
    expect(skills.has("shot-list")).toBe(true);

    const shotList = skills.get("shot-list")!;
    expect(shotList.manifest.name).toBe("shot-list");
    expect(shotList.manifest.allowedTools).toEqual(["canvas.applyPatch"]);
    expect(shotList.content).toContain("# Shot List Skill");
  });

  it("throws error for non-existent or empty skills directory", () => {
    expect(() => loadSkills("/non/existent/path")).toThrow("does not exist");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-skills-"));
    try {
      expect(() => loadSkills(tmpDir)).toThrow("No skills found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws error if allowedTool is unknown", () => {
    expect(
      () => loadSkills(repoSkillsDir, ["other.tool"]), // canvas.applyPatch not in allowed list
    ).toThrow("specifies unknown allowedTool");
  });

  it("skill.load tool returns full content with header for allowed skill", async () => {
    const skills = loadSkills(repoSkillsDir);
    const provider = createSkillToolProvider(skills, ["shot-list"]);

    const res = await provider.execute(
      {
        toolCallId: "c1",
        name: "skill.load",
        input: { name: "shot-list" },
      },
      { runId: "r1" },
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("Loaded skill 'shot-list'");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (res as any).content;
    expect(content).toContain("Skill: shot-list");
    expect(content).toContain("Allowed tools: canvas.applyPatch");
    expect(content).toContain("# Shot List Skill");
  });

  it("skill.load returns error for skill not allowed in profile", async () => {
    const skills = loadSkills(repoSkillsDir);
    const provider = createSkillToolProvider(skills, ["different-skill"]);

    const res = await provider.execute(
      {
        toolCallId: "c2",
        name: "skill.load",
        input: { name: "shot-list" },
      },
      { runId: "r1" },
    );

    expect(res.ok).toBe(false);
    expect(res.code).toBe("skill_not_allowed");
  });
});
