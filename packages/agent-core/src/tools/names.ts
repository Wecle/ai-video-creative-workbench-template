export function toModelToolName(name: string): string {
  return name.replace(/\./g, "_");
}

const defaultModelToCanonical = new Map<string, string>([
  ["canvas_applyPatch", "canvas.applyPatch"],
  ["skill_load", "skill.load"],
]);

export type ToolNameLookup =
  | Iterable<string>
  | { getCanonicalName(modelName: string): string | undefined };

export function fromModelToolName(
  modelName: string,
  lookup?: ToolNameLookup,
): string {
  if (lookup) {
    if (
      "getCanonicalName" in lookup &&
      typeof lookup.getCanonicalName === "function"
    ) {
      const found = lookup.getCanonicalName(modelName);
      if (found) return found;
    } else if (Symbol.iterator in lookup) {
      for (const t of lookup as Iterable<string>) {
        if (toModelToolName(t) === modelName) {
          return t;
        }
      }
    }
  }
  return defaultModelToCanonical.get(modelName) ?? modelName.replace(/_/g, ".");
}
