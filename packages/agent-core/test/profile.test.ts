import { describe, expect, it } from "vitest";
import {
  agentProfileSchema,
  creativeAssistantProfile,
  getProfile,
  listProfiles,
  listProfileSummaries,
} from "../src/profiles";

describe("agentProfile", () => {
  it("validates default creative-assistant profile", () => {
    expect(agentProfileSchema.parse(creativeAssistantProfile)).toEqual(
      creativeAssistantProfile,
    );
  });

  it("lists profiles and summaries correctly", () => {
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);

    const summaries = listProfileSummaries();
    expect(summaries[0]?.id).toBe("creative-assistant");
    expect(summaries[0]?.starters.length).toBeGreaterThanOrEqual(1);

    expect(getProfile("creative-assistant")).toBeDefined();
    expect(getProfile("non-existent")).toBeUndefined();
  });

  it("rejects invalid profile configuration", () => {
    // maxSteps > 8
    expect(
      agentProfileSchema.safeParse({
        ...creativeAssistantProfile,
        budget: {
          ...creativeAssistantProfile.budget,
          maxSteps: 9,
        },
      }).success,
    ).toBe(false);

    // Missing description
    const withoutDesc = { ...creativeAssistantProfile };
    // @ts-expect-error test missing description
    delete withoutDesc.description;
    expect(agentProfileSchema.safeParse(withoutDesc).success).toBe(false);
  });
});
