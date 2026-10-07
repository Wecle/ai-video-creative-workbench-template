import { describe, expect, it } from "vitest";
import { buildContext, type BuildContextInput } from "../src/pure";
import { creativeAssistantProfile } from "../src/profiles/general";

describe("buildContext", () => {
  const baseInput: BuildContextInput = {
    profile: creativeAssistantProfile,
    prompt: "Add a note to canvas",
    snapshot: {
      nodes: [
        { id: "n1", type: "text", title: "Note 1\nwith newline" },
        { id: "n2", type: "image.generate", title: "Visual\r\ttitle" },
      ],
    },
    skills: [
      {
        name: "shot-list",
        description: "Turn story beat into numbered shot list.",
      },
    ],
    routeDecision: {
      candidateSkills: ["shot-list"],
      targetNodeIds: ["n1"],
      confidence: 1,
    },
  };

  it("includes skills names and descriptions without skill full text", () => {
    const ctx = buildContext(baseInput);
    expect(ctx.system).toContain(
      "shot-list: Turn story beat into numbered shot list.",
    );
    // Does not include Markdown text like # Shot List
    expect(ctx.system).not.toContain("# Shot List");
  });

  it("includes persona and routing hints section", () => {
    const ctx = buildContext(baseInput);
    expect(ctx.system).toContain(
      `Persona: ${creativeAssistantProfile.persona}`,
    );
    expect(ctx.system).toContain(
      "Routing hints (advisory; verify against user intent):",
    );
    expect(ctx.system).toContain("Suggested Skills: shot-list");
    expect(ctx.system).toContain("Target Nodes: n1");
  });

  it("cleans up newlines and control characters in titles", () => {
    const ctx = buildContext(baseInput);
    expect(ctx.system).toContain(
      'id: "n1", type: "text", title: "Note 1 with newline"',
    );
    expect(ctx.system).toContain(
      'id: "n2", type: "image.generate", title: "Visual  title"',
    );
    expect(ctx.system).not.toContain("\nwith newline");
  });

  it("truncates canvas snapshot when exceeding 100 nodes", () => {
    const largeNodes = Array.from({ length: 110 }, (_, i) => ({
      id: `node-${i}`,
      type: "text",
      title: `Node ${i}`,
    }));
    const ctx = buildContext({
      ...baseInput,
      snapshot: { nodes: largeNodes },
    });
    expect(ctx.system).toContain("Current Canvas Nodes (110 total):");
    expect(ctx.system).toContain("Truncated: showing first 100 of 110 nodes");
    expect(ctx.system).toContain('id: "node-99"');
    expect(ctx.system).not.toContain('id: "node-105"');
  });

  it("truncates long titles to 80 characters", () => {
    const longTitle = "A".repeat(120);
    const ctx = buildContext({
      ...baseInput,
      snapshot: {
        nodes: [{ id: "n-long", type: "text", title: longTitle }],
      },
    });
    expect(ctx.system).toContain(`title: "${"A".repeat(80)}"`);
    expect(ctx.system).not.toContain("A".repeat(81));
  });

  it("escapes quotes and special characters in node id, type, and title with JSON.stringify", () => {
    const ctx = buildContext({
      ...baseInput,
      snapshot: {
        nodes: [
          {
            id: 'n"special',
            type: "text",
            title: 'Quote "hello" and backslash \\',
          },
        ],
      },
    });
    expect(ctx.system).toContain('id: "n\\"special"');
    expect(ctx.system).toContain('title: "Quote \\"hello\\" and backslash \\\\"');
  });

  it("filters skills by profile allowed skills", () => {
    const ctxNoSkills = buildContext({
      ...baseInput,
      profile: {
        ...creativeAssistantProfile,
        skills: [],
      },
    });
    expect(ctxNoSkills.system).not.toContain("Available Skills:");
    expect(ctxNoSkills.system).not.toContain("Suggested Skills:");
  });

  it("does not leak SKILL.md body lines into system prompt (M6 progressive disclosure)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const skillPath = path.resolve(
      __dirname,
      "../../../capabilities/skills/shot-list/SKILL.md",
    );
    const content = await fs.readFile(skillPath, "utf-8");
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);

    const ctx = buildContext(baseInput);

    // Title and description lines may match, but detailed body/workflow lines must not
    const bodyLines = lines.filter(
      (l) =>
        !l.startsWith("#") &&
        !l.includes("Turn story beat into numbered shot list"),
    );

    expect(bodyLines.length).toBeGreaterThan(0);
    for (const line of bodyLines) {
      expect(ctx.system).not.toContain(line);
    }
  });

  it("reflects profile swaps across system prompt and tools", () => {
    const customProfile = {
      ...creativeAssistantProfile,
      id: "custom-reviewer",
      persona: "A strict video reviewer.",
      systemPrompt: "Review and critique video drafts.",
      tools: ["skill.load"], // no canvas.applyPatch
    };
    const ctx = buildContext({
      ...baseInput,
      profile: customProfile,
    });
    expect(ctx.system).toContain("Persona: A strict video reviewer.");
    expect(ctx.system).toContain("Review and critique video drafts.");
    expect(ctx.tools).toHaveLength(1);
    expect(ctx.tools[0]?.name).toBe("skill.load");
  });
});
