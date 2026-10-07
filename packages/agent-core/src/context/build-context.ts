import type { AgentProfile } from "../profiles/types";
import type { PolicyConfig } from "../policy/decide";
import type { AgentMessage, ToolMeta } from "../loop/types";
import { createUserMessage } from "../loop/messages";
import type { RouteDecision } from "../router/types";
import { toModelToolName } from "../tools/names";
import type { Risk } from "../policy/risk";

export type BuildContextInput = {
  profile: AgentProfile;
  prompt: string;
  snapshot: {
    nodes: Array<{
      id: string;
      type: string;
      title?: string;
    }>;
  };
  skills: Array<{ name: string; description: string }>;
  routeDecision?: RouteDecision;
  toolRisks?: Record<string, Risk>;
};

export type AgentContext = {
  system: string;
  messages: AgentMessage[];
  tools: ToolMeta[];
  policy: PolicyConfig;
};

const MAX_SNAPSHOT_NODES = 100;
const MAX_TITLE_LENGTH = 80;

export function sanitizeTitle(title?: string): string {
  if (!title) return "";
  let result = "";
  for (let i = 0; i < title.length; i++) {
    const code = title.charCodeAt(i);
    if (code < 32 || code === 127) {
      result += " ";
    } else {
      result += title[i];
    }
  }
  const trimmed = result.trim();
  if (trimmed.length > MAX_TITLE_LENGTH) {
    return trimmed.slice(0, MAX_TITLE_LENGTH);
  }
  return trimmed;
}

export function buildContext(input: BuildContextInput): AgentContext {
  const { profile, prompt, snapshot, skills, routeDecision, toolRisks } = input;

  const sections: string[] = [];

  // 1. Persona & base system prompt
  sections.push(`Persona: ${profile.persona}`);
  sections.push(profile.systemPrompt);

  // 2. Skills directory (progressive disclosure: names & descriptions only, NO skill content)
  const allowedSkillsSet = new Set(profile.skills);
  const profileSkills = skills.filter((s) => allowedSkillsSet.has(s.name));
  if (profileSkills.length > 0) {
    const skillLines = profileSkills.map((s) => `- ${s.name}: ${s.description}`);
    sections.push(`Available Skills:\n${skillLines.join("\n")}`);
  }

  // 3. Canvas snapshot summary
  const totalNodes = snapshot.nodes.length;
  const nodesToSummarize = snapshot.nodes.slice(0, MAX_SNAPSHOT_NODES);
  const nodeSummaries = nodesToSummarize.map((n) => {
    const cleanTitle = sanitizeTitle(n.title);
    const idStr = JSON.stringify(n.id);
    const typeStr = JSON.stringify(n.type);
    const titlePart = cleanTitle ? `, title: ${JSON.stringify(cleanTitle)}` : "";
    return `- id: ${idStr}, type: ${typeStr}${titlePart}`;
  });

  let canvasSummary = `Current Canvas Nodes (${totalNodes} total):\n${nodeSummaries.join("\n")}`;
  if (totalNodes > MAX_SNAPSHOT_NODES) {
    canvasSummary += `\n... [Truncated: showing first ${MAX_SNAPSHOT_NODES} of ${totalNodes} nodes]`;
  }
  sections.push(canvasSummary);

  // 4. Routing hints (advisory)
  if (routeDecision) {
    const hints: string[] = [];
    const validCandidateSkills = routeDecision.candidateSkills.filter((s) =>
      allowedSkillsSet.has(s),
    );
    if (validCandidateSkills.length > 0) {
      hints.push(
        `Suggested Skills: ${validCandidateSkills.join(", ")}`,
      );
    }
    if (routeDecision.targetNodeIds.length > 0) {
      hints.push(`Target Nodes: ${routeDecision.targetNodeIds.join(", ")}`);
    }
    if (routeDecision.needsClarification) {
      hints.push(
        `Clarification note: ${routeDecision.needsClarification.question} (${routeDecision.needsClarification.options.join(", ")})`,
      );
    }
    if (hints.length > 0) {
      sections.push(
        `Routing hints (advisory; verify against user intent):\n${hints.join("\n")}`,
      );
    }
  }

  const system = sections.join("\n\n");
  const messages: AgentMessage[] = [createUserMessage(prompt)];

  // Map tools
  const tools: ToolMeta[] = profile.tools.map((toolName) => {
    const risk: Risk =
      toolRisks?.[toolName] ??
      (toolName === "canvas.applyPatch" ? "write" : "read");
    return {
      name: toolName,
      modelName: toModelToolName(toolName),
      risk,
    };
  });

  const policy: PolicyConfig = {
    approvalThreshold: profile.approval.threshold,
    budget: profile.budget,
    approvalTimeoutMs: profile.approval.timeoutSeconds * 1000,
    maxToolCallsPerStep: 4,
  };

  return {
    system,
    messages,
    tools,
    policy,
  };
}
