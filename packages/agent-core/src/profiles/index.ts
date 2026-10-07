import type { AgentProfileSummary } from "@creative/contracts";
import type { AgentProfile } from "./types";
import { creativeAssistantProfile } from "./general";

export * from "./types";
export * from "./schema";
export * from "./general";

const PROFILES: Record<string, AgentProfile> = {
  [creativeAssistantProfile.id]: creativeAssistantProfile,
  "creative-partner": { ...creativeAssistantProfile, id: "creative-partner" },
};

export function getProfile(id: string): AgentProfile | undefined {
  return PROFILES[id];
}

export function listProfiles(): AgentProfile[] {
  return Object.values(PROFILES);
}

export function listProfileSummaries(): AgentProfileSummary[] {
  return listProfiles().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    starters: p.starters,
  }));
}

export const resolveProfile = getProfile;
