import { condition, proxyActivities, setHandler } from "@temporalio/workflow";
import type {
  AgentLoopOutcome,
  AgentLoopProposal,
  AgentLoopRunStatus,
  AgentLoopStep,
  AgentEvent,
  CanvasPatch,
} from "@creative/contracts";
import {
  budgetExceeded,
  createAssistantToolCallsMessage,
  createToolResultMessage,
  decideToolCall,
  estimateStepCost,
  type AgentMessage,
  type ToolCallMeta,
} from "@creative/agent-core/pure";
import type { AgentLoopActivities } from "./activities";
import { agentApprovalSignal } from "./signals";

export type AgentLoopWorkflowInput = {
  runId: string;
  userId: string;
};

export type AgentLoopWorkflowResult = {
  status: AgentLoopRunStatus;
  outcome?: AgentLoopOutcome | null;
  error?: string | null;
};

const { buildContext } = proxyActivities<
  Pick<AgentLoopActivities, "buildContext">
>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

const { llmStep } = proxyActivities<Pick<AgentLoopActivities, "llmStep">>({
  startToCloseTimeout: "2 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["ModelRequestError"],
  },
});

const { prepareTool } = proxyActivities<
  Pick<AgentLoopActivities, "prepareTool">
>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

const { executeTool } = proxyActivities<
  Pick<AgentLoopActivities, "executeTool">
>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

const { recordProgress } = proxyActivities<
  Pick<AgentLoopActivities, "recordProgress">
>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export async function agentLoopWorkflow(
  input: AgentLoopWorkflowInput,
): Promise<AgentLoopWorkflowResult> {
  const { runId } = input;
  let version = 1;

  const decisions = new Map<string, "approve" | "reject">();
  setHandler(agentApprovalSignal, (payload) => {
    if (!decisions.has(payload.toolCallId)) {
      decisions.set(payload.toolCallId, payload.decision);
    }
  });

  const steps: AgentLoopStep[] = [];
  const proposals: AgentLoopProposal[] = [];

  try {
    const ctx = await buildContext({ runId });

    const messages: AgentMessage[] = [...ctx.messages];
    let spentCredits = 0;

    await recordProgress({
      runId,
      version: version++,
      status: "running",
      state: { steps, proposals },
      events: [
        {
          type: "agent.run.status",
          runId,
          seq: 1,
          status: "running",
        },
      ],
    });

    const maxSteps = ctx.policy.budget.maxSteps;

    for (let index = 0; index < maxSteps; index++) {
      if (budgetExceeded(spentCredits, ctx.policy.budget)) {
        await recordProgress({
          runId,
          version: version++,
          status: "completed",
          outcome: "budget_exceeded",
          state: { steps, proposals },
          events: [
            {
              type: "agent.run.status",
              runId,
              seq: 1,
              status: "completed",
              outcome: "budget_exceeded",
            },
          ],
        });
        return { status: "completed", outcome: "budget_exceeded" };
      }

      const stepId = `s${index}`;
      let stepResult;
      try {
        stepResult = await llmStep({
          runId,
          stepId,
          index,
          system: ctx.system,
          messages,
          tools: ctx.tools,
        });
      } catch {
        await recordProgress({
          runId,
          version: version++,
          status: "failed",
          error: "MODEL_ERROR",
          state: { steps, proposals },
          events: [
            {
              type: "agent.run.status",
              runId,
              seq: 1,
              status: "failed",
              error: "MODEL_ERROR",
            },
          ],
        });
        return { status: "failed", error: "MODEL_ERROR" };
      }

      spentCredits += estimateStepCost(stepResult.usage, ctx.policy.budget);
      const loopStep: AgentLoopStep = {
        stepId,
        index,
        text: stepResult.text,
        finishReason: stepResult.finishReason,
      };
      steps.push(loopStep);

      await recordProgress({
        runId,
        version: version++,
        status: "running",
        state: { steps, proposals },
        events: [
          {
            type: "agent.step.completed",
            runId,
            seq: 1,
            stepId,
            text: stepResult.text,
            finishReason: stepResult.finishReason,
          },
        ],
      });

      if (stepResult.toolCalls.length === 0) {
        await recordProgress({
          runId,
          version: version++,
          status: "completed",
          outcome: "finished",
          state: { steps, proposals },
          events: [
            {
              type: "agent.run.status",
              runId,
              seq: 1,
              status: "completed",
              outcome: "finished",
            },
          ],
        });
        return { status: "completed", outcome: "finished" };
      }

      messages.push(
        createAssistantToolCallsMessage(
          stepResult.text,
          stepResult.toolCalls.map((tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          })),
        ),
      );

      const maxCalls = ctx.policy.maxToolCallsPerStep ?? 4;
      for (let cIdx = 0; cIdx < stepResult.toolCalls.length; cIdx++) {
        const call = stepResult.toolCalls[cIdx]!;

        if (cIdx >= maxCalls) {
          const summary = "Too many tool calls in single step";
          messages.push(
            createToolResultMessage(call.toolCallId, call.toolName, {
              type: "error-text",
              value: summary,
            }),
          );
          await recordProgress({
            runId,
            version: version++,
            status: "running",
            state: { steps, proposals },
            events: [
              {
                type: "agent.tool.result",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                ok: false,
                summary,
              },
            ],
          });
          continue;
        }

        if (call.invalid) {
          const summary = call.invalid.message || "Invalid tool call arguments";
          messages.push(
            createToolResultMessage(call.toolCallId, call.toolName, {
              type: "error-text",
              value: summary,
            }),
          );
          await recordProgress({
            runId,
            version: version++,
            status: "running",
            state: { steps, proposals },
            events: [
              {
                type: "agent.tool.result",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                ok: false,
                summary,
              },
            ],
          });
          continue;
        }

        const toolMeta = ctx.tools.find((t) => t.name === call.toolName);
        const callMeta: ToolCallMeta = {
          name: call.toolName,
          risk: toolMeta?.risk ?? "read",
          known: toolMeta !== undefined,
          allowed: toolMeta !== undefined,
        };

        const decision = decideToolCall(
          callMeta,
          { spent: spentCredits },
          ctx.policy,
        );

        if (decision.action === "deny") {
          if (decision.reason === "budget_exceeded") {
            await recordProgress({
              runId,
              version: version++,
              status: "completed",
              outcome: "budget_exceeded",
              state: { steps, proposals },
              events: [
                {
                  type: "agent.run.status",
                  runId,
                  seq: 1,
                  status: "completed",
                  outcome: "budget_exceeded",
                },
              ],
            });
            return { status: "completed", outcome: "budget_exceeded" };
          }
          const summary = `Tool call rejected: ${decision.reason}`;
          messages.push(
            createToolResultMessage(call.toolCallId, call.toolName, {
              type: "error-text",
              value: summary,
            }),
          );
          await recordProgress({
            runId,
            version: version++,
            status: "running",
            state: { steps, proposals },
            events: [
              {
                type: "agent.tool.result",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                ok: false,
                summary,
              },
            ],
          });
          continue;
        }

        if (decision.action === "allow") {
          const toolResult = await executeTool({
            runId,
            toolCall: {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            },
          });
          messages.push(
            createToolResultMessage(
              call.toolCallId,
              call.toolName,
              toolResult.ok
                ? { type: "json", value: toolResult }
                : { type: "error-text", value: toolResult.summary },
            ),
          );
          const resultEvents: AgentEvent[] = [
            {
              type: "agent.tool.result",
              runId,
              seq: 1,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              ok: toolResult.ok,
              summary: toolResult.summary,
              patch: toolResult.patch as CanvasPatch | undefined,
            },
          ];
          await recordProgress({
            runId,
            version: version++,
            status: "running",
            state: { steps, proposals },
            events: resultEvents,
          });
          continue;
        }

        // decision.action === "require_approval"
        const prep = await prepareTool({
          runId,
          toolCall: {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          },
        });

        if (!prep.ok) {
          const summary =
            prep.summary || prep.code || "Tool preparation failed";
          messages.push(
            createToolResultMessage(call.toolCallId, call.toolName, {
              type: "error-text",
              value: summary,
            }),
          );
          await recordProgress({
            runId,
            version: version++,
            status: "running",
            state: { steps, proposals },
            events: [
              {
                type: "agent.tool.result",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                ok: false,
                summary,
              },
            ],
          });
          continue;
        }

        const proposal: AgentLoopProposal = {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          summary: prep.summary || `Execute ${call.toolName}`,
          risk:
            callMeta.risk === "read"
              ? "read"
              : callMeta.risk === "destructive"
                ? "destructive"
                : "write",
          status: "pending",
        };
        proposals.push(proposal);

        await recordProgress({
          runId,
          version: version++,
          status: "waiting_approval",
          state: { steps, proposals },
          events: [
            {
              type: "agent.run.status",
              runId,
              seq: 1,
              status: "waiting_approval",
            },
            {
              type: "agent.tool.proposed",
              runId,
              seq: 1,
              proposal,
            },
          ],
        });

        const hasDecision = await condition(
          () => decisions.has(call.toolCallId),
          ctx.policy.approvalTimeoutMs,
        );

        if (!hasDecision) {
          proposal.status = "timeout";
          await recordProgress({
            runId,
            version: version++,
            status: "completed",
            outcome: "approval_timeout",
            state: { steps, proposals },
            events: [
              {
                type: "agent.tool.decided",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                decision: "timeout",
              },
              {
                type: "agent.run.status",
                runId,
                seq: 1,
                status: "completed",
                outcome: "approval_timeout",
              },
            ],
          });
          return { status: "completed", outcome: "approval_timeout" };
        }

        const userDecision = decisions.get(call.toolCallId)!;
        if (userDecision === "reject") {
          proposal.status = "rejected";
          proposal.result = {
            ok: false,
            summary: "Tool execution rejected by user",
          };
          messages.push(
            createToolResultMessage(call.toolCallId, call.toolName, {
              type: "error-text",
              value: "Tool execution rejected by user",
            }),
          );
          await recordProgress({
            runId,
            version: version++,
            status: "running",
            state: { steps, proposals },
            events: [
              {
                type: "agent.tool.decided",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                decision: "rejected",
              },
              {
                type: "agent.run.status",
                runId,
                seq: 1,
                status: "running",
              },
              {
                type: "agent.tool.result",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                ok: false,
                summary: "Tool execution rejected by user",
              },
            ],
          });
        } else {
          proposal.status = "approved";
          const toolResult = await executeTool({
            runId,
            toolCall: {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            },
          });
          proposal.result = {
            ok: toolResult.ok,
            summary: toolResult.summary,
            patch: toolResult.patch as CanvasPatch | undefined,
          };
          messages.push(
            createToolResultMessage(
              call.toolCallId,
              call.toolName,
              toolResult.ok
                ? { type: "json", value: toolResult }
                : { type: "error-text", value: toolResult.summary },
            ),
          );
          await recordProgress({
            runId,
            version: version++,
            status: "running",
            state: { steps, proposals },
            events: [
              {
                type: "agent.tool.decided",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                decision: "approved",
              },
              {
                type: "agent.run.status",
                runId,
                seq: 1,
                status: "running",
              },
              {
                type: "agent.tool.result",
                runId,
                seq: 1,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                ok: toolResult.ok,
                summary: toolResult.summary,
                patch: toolResult.patch as CanvasPatch | undefined,
              },
            ],
          });
        }
      }
    }

    await recordProgress({
      runId,
      version: version++,
      status: "completed",
      outcome: "max_steps",
      state: { steps, proposals },
      events: [
        {
          type: "agent.run.status",
          runId,
          seq: 1,
          status: "completed",
          outcome: "max_steps",
        },
      ],
    });
    return { status: "completed", outcome: "max_steps" };
  } catch (err) {
    try {
      await recordProgress({
        runId,
        version: version++,
        status: "failed",
        error: "WORKFLOW_FAILED",
        state: { steps, proposals },
        events: [
          {
            type: "agent.run.status",
            runId,
            seq: 1,
            status: "failed",
            error: "WORKFLOW_FAILED",
          },
        ],
      });
    } catch {
      // Ignore secondary error while recording progress
    }
    throw err;
  }
}
