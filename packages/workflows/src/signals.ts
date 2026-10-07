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
