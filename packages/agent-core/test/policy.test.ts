import { describe, expect, it } from "vitest";
import {
  budgetExceeded,
  decideToolCall,
  estimateStepCost,
  type PolicyConfig,
} from "../src/pure";

describe("policy", () => {
  const baseConfig: PolicyConfig = {
    approvalThreshold: "write",
    budget: {
      maxSteps: 4,
      maxEstimatedCredits: 100,
      creditsPerKiloToken: 1,
    },
    approvalTimeoutMs: 600000,
    maxToolCallsPerStep: 4,
  };

  it("calculates estimateStepCost accurately", () => {
    const cost = estimateStepCost(
      { totalTokens: 2500 },
      { creditsPerKiloToken: 2 },
    );
    expect(cost).toBe(5);
  });

  it("allows read tool below threshold", () => {
    const decision = decideToolCall(
      {
        name: "skill.load",
        risk: "read",
        allowed: true,
        known: true,
      },
      { spent: 0 },
      baseConfig,
    );
    expect(decision).toEqual({ action: "allow" });
  });

  it("requires approval for write tool when threshold is write", () => {
    const decision = decideToolCall(
      {
        name: "canvas.applyPatch",
        risk: "write",
        allowed: true,
        known: true,
      },
      { spent: 0 },
      baseConfig,
    );
    expect(decision.action).toBe("require_approval");
  });

  it("requires approval for destructive tool even if threshold is expensive", () => {
    const highConfig: PolicyConfig = {
      ...baseConfig,
      approvalThreshold: "expensive",
    };
    const decision = decideToolCall(
      {
        name: "canvas.wipe",
        risk: "destructive",
        allowed: true,
        known: true,
      },
      { spent: 0 },
      highConfig,
    );
    expect(decision.action).toBe("require_approval");
  });

  it("denies unknown tool and not allowed tool", () => {
    const unknownDec = decideToolCall(
      {
        name: "unknown.tool",
        risk: "read",
        allowed: true,
        known: false,
      },
      { spent: 0 },
      baseConfig,
    );
    expect(unknownDec).toEqual({
      action: "deny",
      reason: "unknown_tool",
    });

    const notAllowedDec = decideToolCall(
      {
        name: "canvas.applyPatch",
        risk: "write",
        allowed: false,
        known: true,
      },
      { spent: 0 },
      baseConfig,
    );
    expect(notAllowedDec).toEqual({
      action: "deny",
      reason: "tool_not_allowed",
    });
  });

  it("denies when budget would be exceeded and allows when exactly equal", () => {
    // spent + estimated = 100 (exactly max) -> allowed
    const exactDec = decideToolCall(
      {
        name: "skill.load",
        risk: "read",
        estimatedCost: 10,
        allowed: true,
        known: true,
      },
      { spent: 90 },
      baseConfig,
    );
    expect(exactDec.action).toBe("allow");

    // spent + estimated = 101 (> max 100) -> denied
    const overDec = decideToolCall(
      {
        name: "skill.load",
        risk: "read",
        estimatedCost: 11,
        allowed: true,
        known: true,
      },
      { spent: 90 },
      baseConfig,
    );
    expect(overDec).toEqual({
      action: "deny",
      reason: "budget_exceeded",
    });
  });

  it("checks budgetExceeded accurately", () => {
    expect(budgetExceeded(100, { maxEstimatedCredits: 100 })).toBe(false);
    expect(budgetExceeded(101, { maxEstimatedCredits: 100 })).toBe(true);
  });
});

