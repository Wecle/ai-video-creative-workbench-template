import type { BudgetConfig } from "./budget";
import { isRiskAtOrAboveThreshold, type Risk } from "./risk";

export type ToolCallMeta = {
  name: string;
  risk: Risk;
  estimatedCost?: number;
  allowed: boolean;
  known: boolean;
};

export type PolicyState = {
  spent: number;
};

export type PolicyConfig = {
  approvalThreshold: Risk;
  budget: BudgetConfig;
  approvalTimeoutMs: number;
  maxToolCallsPerStep: number;
};

export type PolicyDecision =
  | { action: "allow" }
  | { action: "require_approval"; reason: string }
  | {
      action: "deny";
      reason: "unknown_tool" | "tool_not_allowed" | "budget_exceeded";
    };

export function decideToolCall(
  call: ToolCallMeta,
  state: PolicyState,
  cfg: PolicyConfig,
): PolicyDecision {
  if (!call.known) {
    return { action: "deny", reason: "unknown_tool" };
  }
  if (!call.allowed) {
    return { action: "deny", reason: "tool_not_allowed" };
  }
  const estimated = call.estimatedCost ?? 0;
  if (state.spent + estimated > cfg.budget.maxEstimatedCredits) {
    return { action: "deny", reason: "budget_exceeded" };
  }
  if (isRiskAtOrAboveThreshold(call.risk, cfg.approvalThreshold)) {
    return {
      action: "require_approval",
      reason: `Tool '${call.name}' with risk '${call.risk}' requires approval (threshold: '${cfg.approvalThreshold}')`,
    };
  }
  return { action: "allow" };
}
