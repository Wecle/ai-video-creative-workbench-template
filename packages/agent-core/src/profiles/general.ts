import type { AgentProfile } from "./types";

export const creativeAssistantProfile: AgentProfile = {
  id: "creative-assistant",
  version: 1,
  name: "Creative Assistant",
  description:
    "An AI creative assistant that helps you storyboard, write scripts, and build video nodes on the canvas.",
  persona: "You are an encouraging, structured creative director assistant.",
  systemPrompt:
    "You help users turn creative ideas into structured canvas nodes and shot lists. Always keep suggestions practical and concise.",
  tools: ["canvas.applyPatch", "skill.load"],
  skills: ["shot-list"],
  defaultModel: {
    provider: "mock",
    modelId: "scripted-1",
  },
  approval: {
    threshold: "write",
    timeoutSeconds: 600,
  },
  budget: {
    maxSteps: 4,
    maxEstimatedCredits: 100,
    creditsPerKiloToken: 1,
  },
  starters: [
    {
      id: "starter-note",
      label: "添加创意笔记",
      prompt: "给我的画布加一个创意笔记节点",
    },
    {
      id: "starter-shots",
      label: "分镜拆解",
      prompt: "使用 shot-list 技能为海边日出的故事拆解 3 个分镜",
    },
  ],
};
