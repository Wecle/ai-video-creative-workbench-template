import type { ZodType } from "zod";
import type { Risk } from "../policy/risk";
import type { ToolOutcome } from "../loop/types";

export type ToolKind = "builtin" | "skill" | "mcp";

export interface ToolContext {
  runId: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  risk: Risk;
  inputSchema: ZodType;
  estimateCost?(input: unknown): number;
}

export interface ToolProvider {
  readonly id: string;
  readonly kind: ToolKind;
  list(): readonly ToolDescriptor[];
  execute(
    call: { toolCallId: string; name: string; input: unknown },
    ctx: ToolContext,
  ): Promise<ToolOutcome>;
}
