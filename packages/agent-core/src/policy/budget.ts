export type StepUsage = {
  totalTokens: number;
};

export type BudgetConfig = {
  maxSteps: number;
  maxEstimatedCredits: number;
  creditsPerKiloToken: number;
};

export function estimateStepCost(
  usage: StepUsage,
  budget: { creditsPerKiloToken: number },
): number {
  return (usage.totalTokens / 1000) * budget.creditsPerKiloToken;
}

export function budgetExceeded(
  spent: number,
  budget: { maxEstimatedCredits: number },
): boolean {
  return spent >= budget.maxEstimatedCredits;
}
