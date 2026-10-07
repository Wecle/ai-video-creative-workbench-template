import type { AgentProfileSummary } from "@creative/contracts";
import type { AgentProfile } from "./types";
import { creativeAssistantProfile, readonlyAssistantProfile } from "./general";

export * from "./types";
export * from "./schema";
export * from "./general";

const PROFILES: Record<string, AgentProfile> = {
  [creativeAssistantProfile.id]: creativeAssistantProfile,
  [readonlyAssistantProfile.id]: readonlyAssistantProfile,
};

export function registerProfile(profile: AgentProfile): void {
  PROFILES[profile.id] = profile;
}

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
