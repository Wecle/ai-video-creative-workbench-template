import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@creative/database";
import { agentStreamEventSchema, type AgentEvent } from "@creative/contracts";
import { createAgentLoopActivities } from "../src/agent-loop-activities";
import { type AgentEventPublisher } from "../src/events";
import { createModelResolver } from "@creative/agent-core/runtime";
import { createTestDatabase, type TestDb } from "./db-helper";

describe("recordProgress activity", () => {
  let testDb: TestDb;
  let workspaceId: string;
  let projectId: string;
  let canvasId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const [ws] = await testDb.client<{ id: string }[]>`
      INSERT INTO workspaces (name, slug, created_at) VALUES ('WS', 'ws', now()) RETURNING id`;
    workspaceId = ws!.id;

    const [proj] = await testDb.client<{ id: string }[]>`
      INSERT INTO projects (workspace_id, name) VALUES (${workspaceId}, 'P1') RETURNING id`;
    projectId = proj!.id;

    const [cv] = await testDb.client<{ id: string }[]>`
      INSERT INTO canvases (project_id, workspace_id, name, yjs_state, snapshot, schema_version)
      VALUES (${projectId}, ${workspaceId}, 'C1', ${Buffer.from([1])}, '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb, 1) RETURNING id`;
    canvasId = cv!.id;
  });

  afterAll(async () => {
    await testDb?.cleanup();
  });

  async function createRun(id = randomUUID()) {
    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, canvas_version, canvas_snapshot, status, state, state_version, workflow_id)
      VALUES (${id}, ${workspaceId}, ${projectId}, ${canvasId}, 'creative-partner', 'Add note', 1, '{"nodes":[],"edges":[]}'::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, 0, 'wf-1')`;
    return id;
  }

  it("executes idempotently upon retries and does not overwrite with older version", async () => {
    const runId = await createRun();
    const published: AgentEvent[] = [];
    let seqCounter = 1;

    const publisher: AgentEventPublisher = {
      async publish(event) {
        const fullEvent = { ...event, seq: seqCounter++ } as AgentEvent;
        // Validate event against agentStreamEventSchema
        agentStreamEventSchema.parse(fullEvent);
        published.push(fullEvent);
        return fullEvent.seq;
      },
    };

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher,
      skillsDir: "/tmp",
      modelResolver: createModelResolver(),
    });

    const stepPayload = {
      runId,
      version: 2,
      status: "running" as const,
      state: {
        steps: [{ stepId: "s0", index: 0, text: "Step 0" }],
        proposals: [],
      },
      events: [
        {
          type: "agent.step.started" as const,
          runId,
          stepId: "s0",
          index: 0,
          attempt: 1,
        },
      ],
    };

    // First execution
    await activities.recordProgress(stepPayload);
    const [rowV2] = await testDb.db
      .select()
      .from(schema.agent_runs)
      .where(eq(schema.agent_runs.id, runId));
    expect(rowV2?.stateVersion).toBe(2);
    expect((rowV2?.state as any).steps).toHaveLength(1);

    // Retry with same version -> identical row state
    await activities.recordProgress(stepPayload);
    const [rowRetry] = await testDb.db
      .select()
      .from(schema.agent_runs)
      .where(eq(schema.agent_runs.id, runId));
    expect(rowRetry?.stateVersion).toBe(2);

    // Call with older version (version: 1) -> does NOT overwrite
    await activities.recordProgress({
      runId,
      version: 1,
      status: "running",
      state: { steps: [], proposals: [] },
      events: [],
    });
    const [rowOlder] = await testDb.db
      .select()
      .from(schema.agent_runs)
      .where(eq(schema.agent_runs.id, runId));
    expect(rowOlder?.stateVersion).toBe(2);
    expect((rowOlder?.state as any).steps).toHaveLength(1);

    // Verify published seq is strictly monotonic
    for (let i = 1; i < published.length; i++) {
      expect(published[i]!.seq).toBeGreaterThan(published[i - 1]!.seq);
    }
  });

  it("updates database row even if publisher throws, activity succeeds", async () => {
    const runId = await createRun();

    const failingPublisher: AgentEventPublisher = {
      async publish() {
        throw new Error("Redis connection dropped");
      },
    };

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: failingPublisher,
      skillsDir: "/tmp",
      modelResolver: createModelResolver(),
    });

    // Does not throw despite publisher error
    await expect(
      activities.recordProgress({
        runId,
        version: 5,
        status: "completed",
        outcome: "finished",
        state: { steps: [], proposals: [] },
        events: [
          {
            type: "agent.run.status",
            runId,
            status: "completed",
            outcome: "finished",
          },
        ],
      }),
    ).resolves.not.toThrow();

    // Row is updated in DB
    const [row] = await testDb.db
      .select()
      .from(schema.agent_runs)
      .where(eq(schema.agent_runs.id, runId));
    expect(row?.status).toBe("completed");
    expect(row?.outcome).toBe("finished");
    expect(row?.stateVersion).toBe(5);
  });
});
