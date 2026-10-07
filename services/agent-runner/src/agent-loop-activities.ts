import { ApplicationFailure, Context } from "@temporalio/activity";
import { and, eq, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "@creative/database";
import { applyPatch, docFromSnapshot } from "@creative/canvas-doc";
import type { CanvasSnapshot } from "@creative/contracts";
import {
  buildContext,
  createIntentRouter,
  resolveProfile,
} from "@creative/agent-core/pure";
import {
  llmStep,
  loadSkills,
  type ModelResolver,
} from "@creative/agent-core/runtime";
import type {
  AgentLoopActivities,
  BuildContextActivityInput,
  ExecuteToolActivityInput,
  ExecuteToolActivityResult,
  LlmStepActivityInput,
  LlmStepActivityResult,
  PrepareToolActivityInput,
  PrepareToolActivityResult,
  RecordProgressActivityInput,
} from "@creative/workflows/activities";
import type { AgentEventPublisher } from "./events";

export interface AgentLoopActivitiesOptions {
  db: PostgresJsDatabase<typeof schema>;
  publisher: AgentEventPublisher;
  skillsDir: string;
  modelResolver: ModelResolver;
}

export function createAgentLoopActivities({
  db,
  publisher,
  skillsDir,
  modelResolver,
}: AgentLoopActivitiesOptions): AgentLoopActivities {
  return {
    async buildContext({ runId }: BuildContextActivityInput) {
      const [row] = await db
        .select()
        .from(schema.agent_runs)
        .where(eq(schema.agent_runs.id, runId));

      if (!row) {
        throw ApplicationFailure.nonRetryable(
          "Agent run not found",
          "AgentRunNotFound",
        );
      }

      const profile = resolveProfile(row.profileId);
      if (!profile) {
        throw ApplicationFailure.nonRetryable(
          `Unknown profile '${row.profileId}'`,
          "UnknownProfile",
        );
      }

      const rawHints = (row.routeHints ?? {}) as {
        selectedSkills?: string[];
        selectedNodeIds?: string[];
      };

      const snapshot = (row.canvasSnapshot ?? {
        nodes: [],
        edges: [],
      }) as CanvasSnapshot;
      const canvasNodeIds = (snapshot.nodes ?? []).map((n) => n.id);

      let skillsMap: ReturnType<typeof loadSkills>;
      try {
        skillsMap = loadSkills(skillsDir);
      } catch {
        skillsMap = new Map();
      }

      const availableSkills = Array.from(skillsMap.values()).map((s) => ({
        name: s.manifest.name,
        description: s.manifest.description,
      }));

      const router = createIntentRouter();
      const routeDecision = await router.route({
        prompt: row.prompt,
        profileId: row.profileId,
        profileSelectedExplicitly: true,
        selectedSkills: rawHints.selectedSkills ?? [],
        selectedNodeIds: rawHints.selectedNodeIds ?? [],
        knownSkills: availableSkills,
        canvasNodeIds,
      });

      return buildContext({
        profile,
        prompt: row.prompt,
        snapshot,
        skills: availableSkills,
        routeDecision,
        toolRisks: {
          "canvas.applyPatch": "write",
          "skill.load": "read",
        },
      });
    },

    async llmStep(input: LlmStepActivityInput): Promise<LlmStepActivityResult> {
      let attempt = 1;
      let abortSignal: AbortSignal | undefined;
      let heartbeat = () => {};

      try {
        const current = Context.current();
        attempt = current.info.attempt;
        abortSignal = current.cancellationSignal;
        heartbeat = () => current.heartbeat();
      } catch {
        // Outside Temporal activity context
      }

      await publisher.publish({
        type: "agent.step.started",
        runId: input.runId,
        stepId: input.stepId,
        index: input.index,
        attempt,
      });
      heartbeat();

      const model = modelResolver.resolve({
        provider: "mock",
        modelId: "mock",
      });

      let stepRes;
      try {
        stepRes = await llmStep({
          runId: input.runId,
          stepId: input.stepId,
          index: input.index,
          attempt,
          system: input.system,
          messages: input.messages,
          tools: input.tools,
          model,
          abortSignal,
          events: {
            onTextDelta: async (evt) => {
              await publisher.publish({
                type: "agent.text.delta",
                runId: input.runId,
                stepId: evt.stepId,
                attempt: evt.attempt,
                text: evt.text,
              });
              heartbeat();
            },
            heartbeat,
          },
        });
      } catch (err: unknown) {
        const e = err as Record<string, unknown> | undefined;
        if (e?.isNonRetryable || e?.type === "ModelRequestError") {
          throw ApplicationFailure.nonRetryable(
            "Model request error",
            "ModelRequestError",
          );
        }
        throw err;
      }

      await publisher.publish({
        type: "agent.step.completed",
        runId: input.runId,
        stepId: input.stepId,
        text: stepRes.text,
        finishReason: stepRes.finishReason,
      });

      return {
        text: stepRes.text,
        toolCalls: stepRes.toolCalls,
        finishReason: stepRes.finishReason,
        usage: stepRes.usage,
      };
    },

    async prepareTool({
      runId,
      toolCall,
    }: PrepareToolActivityInput): Promise<PrepareToolActivityResult> {
      if (toolCall.toolName === "canvas.applyPatch") {
        const [row] = await db
          .select({ canvasSnapshot: schema.agent_runs.canvasSnapshot })
          .from(schema.agent_runs)
          .where(eq(schema.agent_runs.id, runId));

        if (!row) {
          return {
            ok: false,
            code: "RUN_NOT_FOUND",
            summary: "Agent run not found",
          };
        }

        const snapshot = row.canvasSnapshot as CanvasSnapshot;
        const doc = docFromSnapshot(snapshot);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = applyPatch(doc, "agent", toolCall.input as any);
        if (!result.ok) {
          return {
            ok: false,
            code: result.code,
            summary: `Invalid canvas patch: op ${result.index} failed (${result.code})`,
          };
        }
        return {
          ok: true,
          summary: (toolCall.input.summary as string) ?? "Apply canvas patch",
        };
      }

      if (toolCall.toolName === "skill.load") {
        return {
          ok: true,
          summary: `Load skill ${(toolCall.input.name as string) ?? ""}`,
        };
      }

      return { ok: true, summary: `Execute ${toolCall.toolName}` };
    },

    async executeTool({
      toolCall,
    }: ExecuteToolActivityInput): Promise<ExecuteToolActivityResult> {
      if (toolCall.toolName === "canvas.applyPatch") {
        return {
          ok: true,
          summary: (toolCall.input.summary as string) ?? "Apply canvas patch",
          patch: toolCall.input,
        };
      }

      if (toolCall.toolName === "skill.load") {
        const skillName = String(toolCall.input.name ?? "");
        try {
          const skillsMap = loadSkills(skillsDir);
          const skill = skillsMap.get(skillName);
          if (!skill) {
            return {
              ok: false,
              summary: `Skill '${skillName}' not found`,
            };
          }
          const maxLen = 8192;
          const content =
            skill.content.length > maxLen
              ? skill.content.slice(0, maxLen) + "\n...[truncated]"
              : skill.content;
          return {
            ok: true,
            summary: content,
          };
        } catch (err) {
          return {
            ok: false,
            summary: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return {
        ok: true,
        summary: `Executed ${toolCall.toolName}`,
      };
    },

    async recordProgress({
      runId,
      version,
      status,
      outcome,
      error,
      state,
      events,
    }: RecordProgressActivityInput): Promise<void> {
      // 1. UPDATE database first: state_version < version ensures idempotency & ordering
      await db
        .update(schema.agent_runs)
        .set({
          status,
          outcome: outcome ?? null,
          error: error ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          state: state as any,
          stateVersion: version,
          updatedAt: new Date(),
          completedAt:
            status === "completed" || status === "failed" ? new Date() : null,
        })
        .where(
          and(
            eq(schema.agent_runs.id, runId),
            lt(schema.agent_runs.stateVersion, version),
          ),
        );

      // 2. Publish events to Redis (best-effort, does not fail the activity)
      for (const event of events) {
        try {
          await publisher.publish(event);
        } catch (err) {
          console.warn("Failed to publish agent event in recordProgress:", err);
        }
      }
    },
  };
}
