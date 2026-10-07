import { describe, expect, it } from "vitest";
import { skillManifestSchema } from "../src/skills/manifest";

describe("skillManifestSchema", () => {
  const validManifest = {
    name: "shot-list",
    description:
      "Turn a short story beat into a numbered shot list as text nodes.",
    version: "1.0.0",
    allowedTools: ["canvas.applyPatch"],
    recommendedModels: {
      default: { provider: "mock", modelId: "scripted-1" },
    },
  };

  it("validates a conforming skill manifest", () => {
    expect(skillManifestSchema.parse(validManifest)).toEqual(validManifest);
  });

  it("rejects non-kebab-case or uppercase skill names", () => {
    expect(
      skillManifestSchema.safeParse({
        ...validManifest,
        name: "ShotList",
      }).success,
    ).toBe(false);

    expect(
      skillManifestSchema.safeParse({
        ...validManifest,
        name: "shot list",
      }).success,
    ).toBe(false);
  });

  it("rejects missing version or non-semver version", () => {
    expect(
      skillManifestSchema.safeParse({
        ...validManifest,
        version: "v1",
      }).success,
    ).toBe(false);

    const withoutVersion = { ...validManifest };
    // @ts-expect-error test missing version
    delete withoutVersion.version;
    expect(skillManifestSchema.safeParse(withoutVersion).success).toBe(false);
  });
});
