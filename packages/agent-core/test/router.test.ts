import { describe, expect, it } from "vitest";
import {
  createMockRouter,
  createRuleRouter,
  type RouteInput,
} from "../src/pure";

describe("router", () => {
  const baseInput: RouteInput = {
    prompt: "Hello agent",
    profileId: "creative-assistant",
    profileSelectedExplicitly: false,
    selectedSkills: [],
    selectedNodeIds: [],
    knownSkills: [
      { name: "shot-list", description: "Create shot list" },
      { name: "script-writer", description: "Write video script" },
      { name: "script-polisher", description: "Polish video script" },
    ],
    canvasNodeIds: ["node-1", "node-2"],
  };

  it("handles explicit profile selection", async () => {
    const router = createRuleRouter();
    const res = await router.route({
      ...baseInput,
      profileSelectedExplicitly: true,
    });
    expect(res.profile).toBe("creative-assistant");
    expect(res.confidence).toBe(1);
  });

  it("matches exact slash command", async () => {
    const router = createRuleRouter();
    const res = await router.route({
      ...baseInput,
      prompt: "/shot-list please generate 3 shots",
    });
    expect(res.candidateSkills).toEqual(["shot-list"]);
    expect(res.confidence).toBe(1);
  });

  it("matches unique prefix slash command", async () => {
    const router = createRuleRouter();
    const res = await router.route({
      ...baseInput,
      prompt: "/shot make shots",
    });
    expect(res.candidateSkills).toEqual(["shot-list"]);
    expect(res.confidence).toBe(1);
  });

  it("returns clarification for ambiguous slash command matching 2-3 skills", async () => {
    const router = createRuleRouter();
    const res = await router.route({
      ...baseInput,
      prompt: "/script help me with lines",
    });
    expect(res.candidateSkills).toHaveLength(0);
    expect(res.needsClarification).toBeDefined();
    expect(res.needsClarification?.options).toEqual([
      "script-writer",
      "script-polisher",
    ]);
    expect(res.confidence).toBe(0.5);
  });

  it("filters selected skills and target node ids by known sets", async () => {
    const router = createRuleRouter();
    const res = await router.route({
      ...baseInput,
      selectedSkills: ["shot-list", "unknown-skill"],
      selectedNodeIds: ["node-1", "unknown-node"],
    });
    expect(res.candidateSkills).toEqual(["shot-list"]);
    expect(res.targetNodeIds).toEqual(["node-1"]);
    expect(res.confidence).toBe(1);
  });

  it("returns confidence 0 on empty explicit signals", async () => {
    const router = createRuleRouter();
    const res = await router.route(baseInput);
    expect(res.confidence).toBe(0);
    expect(res.candidateSkills).toHaveLength(0);
    expect(res.targetNodeIds).toHaveLength(0);
  });

  it("mock router returns empty decision with confidence 0", async () => {
    const router = createMockRouter();
    const res = await router.route({
      ...baseInput,
      prompt: "/shot-list",
      selectedSkills: ["shot-list"],
    });
    expect(res).toEqual({
      candidateSkills: [],
      targetNodeIds: [],
      confidence: 0,
    });
  });
});
