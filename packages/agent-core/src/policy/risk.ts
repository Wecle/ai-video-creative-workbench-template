export type Risk = "read" | "write" | "expensive" | "destructive";

export const RISK_LEVEL: Record<Risk, number> = {
  read: 1,
  write: 2,
  expensive: 3,
  destructive: 4,
};

export function isRiskAtOrAboveThreshold(risk: Risk, threshold: Risk): boolean {
  if (risk === "destructive") return true;
  return RISK_LEVEL[risk] >= RISK_LEVEL[threshold];
}
