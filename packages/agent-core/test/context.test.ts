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
