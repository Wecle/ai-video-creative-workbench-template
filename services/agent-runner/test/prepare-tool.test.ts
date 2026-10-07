import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@creative/database";
import { createAgentLoopActivities } from "../src/agent-loop-activities";
import { createModelResolver } from "@creative/agent-core/runtime";
import { createTestDatabase, type TestDb } from "./db-helper";

const skillsDir = resolve(
  fileURLToPath(new URL("../../../capabilities/skills", import.meta.url)),
);

describe("prepareTool and executeTool activities", () => {
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

  const dummyPublisher = {
    async publish() {
      return 1;
    },
  };

  async function createRun(
    snapshot = { schemaVersion: 1, nodes: [], edges: [] },
  ) {
    const id = randomUUID();
    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, canvas_version, canvas_snapshot, status, state, workflow_id)
      VALUES (${id}, ${workspaceId}, ${projectId}, ${canvasId}, 'creative-assistant', 'Patch', 1, ${JSON.stringify(snapshot)}::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, 'wf-1')`;
    return id;
  }

  it("prepareTool returns ok:true for valid patch and ok:false with code for invalid patch without mutating tables", async () => {
    const runId = await createRun({
      schemaVersion: 1,
      nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }],
      edges: [],
    });

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    // Valid patch: add node n2
    const validPatch = {
      summary: "Add note node",
      ops: [
        {
          op: "addNode",
          id: "n2",
          type: "text",
          position: { x: 100, y: 100 },
        },
      ],
    };

    const validRes = await activities.prepareTool({
      runId,
      toolCall: {
        toolCallId: "c1",
        toolName: "canvas.applyPatch",
        input: validPatch,
      },
    });
    expect(validRes.ok).toBe(true);

    // Invalid patch: duplicate id n1
    const invalidPatch = {
      summary: "Duplicate node",
      ops: [
        {
          op: "addNode",
          id: "n1",
          type: "text",
          position: { x: 0, y: 0 },
        },
      ],
    };

    const invalidRes = await activities.prepareTool({
      runId,
      toolCall: {
        toolCallId: "c2",
        toolName: "canvas.applyPatch",
        input: invalidPatch,
      },
    });
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.code).toBe("duplicate-node");

    // Neither prepareTool call mutated agent_runs.canvas_snapshot
    const [row] = await testDb.db
      .select()
      .from(schema.agent_runs)
      .where(eq(schema.agent_runs.id, runId));
    expect((row?.canvasSnapshot as { nodes: unknown[] }).nodes).toHaveLength(1);
  });

  it("executeTool returns patch without writing to database", async () => {
    const runId = await createRun();
    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    const patch = {
      summary: "Add node",
      ops: [
        { op: "addNode", id: "n-exec", type: "text", position: { x: 0, y: 0 } },
      ],
    };

    const execRes = await activities.executeTool({
      runId,
      toolCall: {
        toolCallId: "c-exec",
        toolName: "canvas.applyPatch",
        input: patch,
      },
    });

    expect(execRes.ok).toBe(true);
    expect(execRes.patch).toEqual(patch);

    // Canvases table is untouched
    const [canvas] = await testDb.db
      .select()
      .from(schema.canvases)
      .where(eq(schema.canvases.id, canvasId));
    expect((canvas?.snapshot as { nodes: unknown[] }).nodes).toHaveLength(0);
  });

  it("executeTool loads skill content and truncates if overly long", async () => {
    const runId = await createRun();
    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    const skillRes = await activities.executeTool({
      runId,
      toolCall: {
        toolCallId: "c-skill",
        toolName: "skill.load",
        input: { name: "shot-list" },
      },
    });

    expect(skillRes.ok).toBe(true);
    expect(skillRes.summary).toContain("Shot List");
  });

  it("prepareTool returns ok:false with invalid_input for malformed patch input without throwing (B4)", async () => {
    const runId = await createRun();
    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    // 1. Missing ops
    const res1 = await activities.prepareTool({
      runId,
      toolCall: {
        toolCallId: "c-bad1",
        toolName: "canvas.applyPatch",
        input: { summary: "x" },
      },
    });
    expect(res1.ok).toBe(false);
    expect(res1.code).toBe("invalid_input");

    // 2. Unknown op
    const res2 = await activities.prepareTool({
      runId,
      toolCall: {
        toolCallId: "c-bad2",
        toolName: "canvas.applyPatch",
        input: { summary: "x", ops: [{ op: "unknownOp" }] },
      },
    });
    expect(res2.ok).toBe(false);
    expect(res2.code).toBe("invalid_input");

    // 3. addNode missing position
    const res3 = await activities.prepareTool({
      runId,
      toolCall: {
        toolCallId: "c-bad3",
        toolName: "canvas.applyPatch",
        input: {
          summary: "x",
          ops: [{ op: "addNode", id: "n-bad", type: "text" }],
        },
      },
    });
    expect(res3.ok).toBe(false);
    expect(res3.code).toBe("invalid_input");
  });

  it("executeTool rejects skill not allowed for profile (S4)", async () => {
    const runId = randomUUID();
    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, canvas_version, canvas_snapshot, status, state, workflow_id)
      VALUES (${runId}, ${workspaceId}, ${projectId}, ${canvasId}, 'creative-assistant', 'Test', 1, '{"nodes":[],"edges":[]}'::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, 'wf-1')`;

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    const res = await activities.executeTool({
      runId,
      toolCall: {
        toolCallId: "c-disallowed",
        toolName: "skill.load",
        input: { name: "disallowed-skill" },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("not allowed for profile");
  });
});
