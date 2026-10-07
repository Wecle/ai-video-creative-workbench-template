import { defineSignal } from "@temporalio/workflow";

export type ProviderCallbackPayload = {
  provider: string;
  externalJobId: string;
  status: "succeeded" | "failed";
  output?: Record<string, unknown>;
  error?: string;
};

export const providerCallbackSignal =
  defineSignal<[ProviderCallbackPayload]>("providerCallback");

export type AgentApprovalPayload = {
  toolCallId: string;
  decision: "approve" | "reject";
};

export const agentApprovalSignal =
  defineSignal<[AgentApprovalPayload]>("agentApproval");
