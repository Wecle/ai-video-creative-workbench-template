export function toModelToolName(name: string): string {
  return name.replace(/\./g, "_");
}

export function fromModelToolName(name: string): string {
  return name.replace(/_/g, ".");
}
