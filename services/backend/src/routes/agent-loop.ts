import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  agentLoopApprovalRequestSchema,
  type AgentLoopOutcome,
  type AgentLoopProposal,
  type AgentLoopRun,
  agentLoopRunSchema,
  type AgentLoopRunStatus,
  type AgentLoopStep,
  agentProfileSummarySchema,
  agentLoopStartRequestSchema,
} from "@creative/contracts";
import { schema } from "@creative/database";
import { agentLoopWorkflowId } from "@creative/workflows/constants";
import { listProfileSummaries } from "@creative/agent-core/pure";
import { findAccessibleCanvas } from "../canvas/access";
import { requireUser } from "../plugins/gateway-trust";
import type { AgentLoopService } from "../temporal/agent-loops";
import type { Database } from "./me";

const errorSchema = z.object({ error: z.string() });
const conflictSchema = z.object({
  error: z.string(),
  currentVersion: z.number().int().nonnegative(),
});

export function formatAgentLoopRun(
  row: typeof schema.agent_runs.$inferSelect,
): AgentLoopRun {
  const state = (row.state ?? {}) as {
    steps?: AgentLoopStep[];
    proposals?: AgentLoopProposal[];
  };
  return {
    id: row.id,
    profileId: row.profileId,
    projectId: row.projectId,
    canvasId: row.canvasId,
    canvasVersion: row.canvasVersion,
    status: row.status as AgentLoopRunStatus,
    outcome: (row.outcome as AgentLoopOutcome) ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    steps: (state.steps ?? []) as AgentLoopStep[],
    proposals: (state.proposals ?? []) as AgentLoopProposal[],
  };
}

export async function agentLoopRoutes(
  instance: FastifyInstance,
  options: {
    db: Database;
    agentLoops: AgentLoopService;
  },
) {
  const { db, agentLoops } = options;
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // 1. List agent profiles
  app.get(
    "/api/v1/agent/profiles",
    {
      onRequest: [requireUser],
      schema: {
        response: {
          200: z.object({
            profiles: z.array(agentProfileSummarySchema),
          }),
        },
      },
    },
    async () => {
      const summaries = listProfileSummaries();
      return { profiles: summaries };
    },
  );

  // 2. Start agent loop run
  app.post(
    "/api/v1/agent/runs",
    {
      onRequest: [requireUser],
      schema: {
        body: agentLoopStartRequestSchema,
        response: {
          202: z.object({ run: agentLoopRunSchema }),
          400: errorSchema,
          404: errorSchema,
          409: conflictSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.identity.userId!;
      const body = request.body as z.infer<typeof agentLoopStartRequestSchema>;

      // Check canvas existence & access
      const canvas = await findAccessibleCanvas(
        db,
        userId,
        body.projectId,
        body.canvasId,
        {
          id: schema.canvases.id,
          projectId: schema.canvases.projectId,
          workspaceId: schema.canvases.workspaceId,
          version: schema.canvases.version,
          snapshot: schema.canvases.snapshot,
        },
      );

      if (!canvas) {
        return reply.code(404).send({ error: "Canvas not found" });
      }

      // Optimistic concurrency check
      if (canvas.version !== body.canvasVersion) {
        return reply.code(409).send({
          error: "Canvas version conflict",
          currentVersion: canvas.version,
        });
      }

      const runId = randomUUID();
      const profileId = body.profileId ?? "creative-assistant";
      const workflowId = agentLoopWorkflowId(userId, runId);
      const routeHints = {
        selectedSkills: body.selectedSkills,
        selectedNodeIds: body.selectedNodeIds,
      };

      const [newRun] = await db
        .insert(schema.agent_runs)
        .values({
          id: runId,
          workspaceId: canvas.workspaceId,
          projectId: canvas.projectId,
          canvasId: canvas.id,
          createdBy: userId,
          profileId,
          prompt: body.prompt,
          routeHints,
          canvasVersion: canvas.version,
          canvasSnapshot: canvas.snapshot,
          status: "running",
          state: { steps: [], proposals: [] },
          stateVersion: 0,
          workflowId,
        })
        .returning();

      try {
        await agentLoops.start(userId, runId);
      } catch (error) {
        request.log.error(
          { err: error },
          "Failed to start agent loop workflow",
        );
        await db
          .update(schema.agent_runs)
          .set({
            status: "failed",
            outcome: "failed",
            error: "Execution engine unavailable",
            completedAt: new Date(),
          })
          .where(eq(schema.agent_runs.id, runId));
        return reply.code(503).send({ error: "Execution engine unavailable" });
      }

      return reply.code(202).send({
        run: formatAgentLoopRun(newRun!),
      });
    },
  );

  // 3. Get agent loop run
  app.get(
    "/api/v1/agent/runs/:runId",
    {
      onRequest: [requireUser],
      schema: {
        params: z.object({ runId: z.string().uuid() }),
        response: {
          200: z.object({ run: agentLoopRunSchema }),
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.identity.userId!;
      const { runId } = request.params;

      const [runRow] = await db
        .select()
        .from(schema.agent_runs)
        .where(eq(schema.agent_runs.id, runId))
        .limit(1);

      if (!runRow || runRow.createdBy !== userId) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const canvas = await findAccessibleCanvas(
        db,
        userId,
        runRow.projectId,
        runRow.canvasId,
        { id: schema.canvases.id },
      );
      if (!canvas) {
        return reply.code(404).send({ error: "Run not found" });
      }

      return reply.code(200).send({
        run: formatAgentLoopRun(runRow),
      });
    },
  );

  // 4. Submit approval decision
  app.post(
    "/api/v1/agent/runs/:runId/approval",
    {
      onRequest: [requireUser],
      schema: {
        params: z.object({ runId: z.string().uuid() }),
        body: agentLoopApprovalRequestSchema,
        response: {
          202: z.object({ ok: z.boolean() }),
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.identity.userId!;
      const { runId } = request.params;
      const { toolCallId, decision } = request.body;

      const [runRow] = await db
        .select()
        .from(schema.agent_runs)
        .where(eq(schema.agent_runs.id, runId))
        .limit(1);

      if (!runRow || runRow.createdBy !== userId) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const canvas = await findAccessibleCanvas(
        db,
        userId,
        runRow.projectId,
        runRow.canvasId,
        { id: schema.canvases.id },
      );
      if (!canvas) {
        return reply.code(404).send({ error: "Run not found" });
      }

      if (
        runRow.status === "completed" ||
        runRow.status === "failed" ||
        runRow.status === "cancelled"
      ) {
        return reply.code(409).send({ error: "Run is already terminal" });
      }

      try {
        await agentLoops.signalApproval(userId, runId, {
          toolCallId,
          decision,
        });
        return reply.code(202).send({ ok: true });
      } catch (error) {
        request.log.error(
          { err: error },
          "Failed to send approval signal to workflow",
        );
        return reply.code(503).send({ error: "Execution engine unavailable" });
      }
    },
  );
}
