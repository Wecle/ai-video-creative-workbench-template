import fs from "node:fs";
import path from "node:path";
import { skillManifestSchema, type SkillManifest } from "../manifest";

export type LoadedSkill = {
  manifest: SkillManifest;
  content: string;
};

export function loadSkills(
  skillsDir: string,
  knownTools?: readonly string[],
): Map<string, LoadedSkill> {
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    throw new Error(
      `Skills directory does not exist or is not a directory: ${skillsDir}`,
    );
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skillsMap = new Map<string, LoadedSkill>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDirName = entry.name;
    const skillPath = path.join(skillsDir, subDirName);

    const manifestPath = path.join(skillPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Missing manifest.json for skill in ${skillPath}`);
    }

    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(manifestRaw);
    } catch (err) {
      throw new Error(
        `Invalid JSON in manifest.json for skill '${subDirName}': ${String(err)}`,
      );
    }

    const manifest = skillManifestSchema.parse(parsedJson);
    if (manifest.name !== subDirName) {
      throw new Error(
        `Skill directory name '${subDirName}' does not match manifest name '${manifest.name}'`,
      );
    }

    if (knownTools) {
      for (const tool of manifest.allowedTools) {
        if (!knownTools.includes(tool)) {
          throw new Error(
            `Skill '${manifest.name}' specifies unknown allowedTool: '${tool}'`,
          );
        }
      }
    }

    const docPath = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(docPath)) {
      throw new Error(`Missing SKILL.md for skill in ${skillPath}`);
    }
    const content = fs.readFileSync(docPath, "utf-8");

    skillsMap.set(manifest.name, { manifest, content });
  }

  if (skillsMap.size === 0) {
    throw new Error(`No skills found in skills directory: ${skillsDir}`);
  }

  return skillsMap;
}
