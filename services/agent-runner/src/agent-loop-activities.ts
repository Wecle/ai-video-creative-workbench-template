import { ApplicationFailure, Context } from "@temporalio/activity";
import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "@creative/database";
import { applyPatch, docFromSnapshot } from "@creative/canvas-doc";
import { canvasPatchSchema, type CanvasSnapshot } from "@creative/contracts";
import { buildContext, createIntentRouter } from "@creative/agent-core/pure";
import { createToolRegistry, resolveProfile } from "@creative/agent-core";
import {
  createBuiltinToolProvider,
  createSkillToolProvider,
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
  agentModel?: string;
}

function parseModelRef(
  str?: string,
): { provider: string; modelId: string } | undefined {
  if (!str) return undefined;
  const idx = str.indexOf(":");
  if (idx > 0) {
    return { provider: str.slice(0, idx), modelId: str.slice(idx + 1) };
  }
  return { provider: str, modelId: str };
}

export function createAgentLoopActivities({
  db,
  publisher,
  skillsDir,
  modelResolver,
  agentModel,
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

      const skillsMap = loadSkills(skillsDir, [
        "canvas.applyPatch",
        "skill.load",
      ]);

      const profileSkillsSet = new Set(profile.skills);
      const availableSkills = Array.from(skillsMap.values())
        .filter((s) => profileSkillsSet.has(s.manifest.name))
        .map((s) => ({
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

      const [row] = await db
        .select({ profileId: schema.agent_runs.profileId })
        .from(schema.agent_runs)
        .where(eq(schema.agent_runs.id, input.runId));

      const profile = row ? resolveProfile(row.profileId) : undefined;
      const allowedSkills = profile?.skills ?? [];

      const skillsMap = loadSkills(skillsDir, [
        "canvas.applyPatch",
        "skill.load",
      ]);

      const toolRegistry = createToolRegistry([
        createBuiltinToolProvider(),
        createSkillToolProvider(skillsMap, allowedSkills),
      ]);

      const envModel = parseModelRef(agentModel);
      const modelRef = envModel ??
        profile?.defaultModel ?? {
          provider: "mock",
          modelId: "mock",
        };

      let model;
      try {
        model = modelResolver.resolve(modelRef);
      } catch (err: unknown) {
        console.error("Failed to resolve model provider:", err);
        throw ApplicationFailure.nonRetryable(
          "Failed to resolve model provider",
          "ModelRequestError",
        );
      }

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
          toolRegistry,
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
        console.error("LLM step execution error:", err);
        const e = err as Record<string, unknown> | undefined;
        if (e?.isNonRetryable || e?.type === "ModelRequestError") {
          throw ApplicationFailure.nonRetryable(
            "Model request error",
            "ModelRequestError",
          );
        }
        throw ApplicationFailure.retryable(
          "Model request failed, retrying",
          "ModelRetryableError",
        );
      }

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
        const parsed = canvasPatchSchema.safeParse(toolCall.input);
        if (!parsed.success) {
          return {
            ok: false,
            code: "invalid_input",
            summary: "Invalid canvas patch input: schema validation failed",
          };
        }
        const patch = parsed.data;

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
        const result = applyPatch(doc, "agent", patch);
        if (!result.ok) {
          return {
            ok: false,
            code: result.code,
            summary: `Invalid canvas patch: op ${result.index} failed (${result.code})`,
          };
        }
        return {
          ok: true,
          summary: patch.summary || "Apply canvas patch",
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
      runId,
      toolCall,
    }: ExecuteToolActivityInput): Promise<ExecuteToolActivityResult> {
      const [row] = await db
        .select({ profileId: schema.agent_runs.profileId })
        .from(schema.agent_runs)
        .where(eq(schema.agent_runs.id, runId));

      const profile = row ? resolveProfile(row.profileId) : undefined;
      if (!profile) {
        return {
          ok: false,
          summary: "Profile resolution failed for agent run",
        };
      }

      const skillsMap = loadSkills(skillsDir, [
        "canvas.applyPatch",
        "skill.load",
      ]);

      const toolRegistry = createToolRegistry([
        createBuiltinToolProvider(),
        createSkillToolProvider(skillsMap, profile.skills),
      ]);

      const provider = toolRegistry.getProvider(toolCall.toolName);
      if (!provider) {
        return {
          ok: false,
          summary: `No provider registered for tool '${toolCall.toolName}'`,
        };
      }

      try {
        const res = await provider.execute(
          {
            toolCallId: toolCall.toolCallId,
            name: toolCall.toolName,
            input: toolCall.input,
          },
          { runId },
        );

        const maxLen = 8192;
        let summary =
          (res as { content?: string }).content ?? res.summary ?? "";
        if (summary.length > maxLen) {
          summary = summary.slice(0, maxLen) + "\n...[truncated]";
        }

        return {
          ok: res.ok,
          summary,
          patch: res.ok ? res.patch : undefined,
        };
      } catch (err) {
        return {
          ok: false,
          summary: err instanceof Error ? err.message : String(err),
        };
      }
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
      // AND status NOT IN ('completed', 'failed') ensures terminal status cannot be overwritten
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
            sql`${schema.agent_runs.status} NOT IN ('completed', 'failed')`,
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
