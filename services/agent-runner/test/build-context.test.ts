import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentLoopActivities } from "../src/agent-loop-activities";
import { createModelResolver } from "@creative/agent-core/runtime";
import { createTestDatabase, type TestDb } from "./db-helper";

const skillsDir = resolve(
  fileURLToPath(new URL("../../../capabilities/skills", import.meta.url)),
);

describe("buildContext activity", () => {
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

  it("reads snapshot frozen in agent_runs row, ignoring subsequent changes to canvases", async () => {
    const runId = randomUUID();
    const initialSnapshot = {
      nodes: [{ id: "frozen-node", type: "text", title: "Original" }],
      edges: [],
    };

    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, canvas_version, canvas_snapshot, status, state, workflow_id)
      VALUES (${runId}, ${workspaceId}, ${projectId}, ${canvasId}, 'creative-assistant', 'Create shot list /shot-list', 1, ${JSON.stringify(initialSnapshot)}::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, 'wf-1')`;

    // Mutate the canvas in canvases table
    await testDb.client`
      UPDATE canvases SET snapshot = '{"nodes":[{"id":"mutated-node","type":"video"}],"edges":[]}'::jsonb
      WHERE id = ${canvasId}`;

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    const ctx = await activities.buildContext({ runId });

    // Context system prompt contains the frozen node, NOT the mutated node
    expect(ctx.system).toContain("frozen-node");
    expect(ctx.system).not.toContain("mutated-node");
    expect(ctx.system).toContain("shot-list");
  });

  it("fails with non-retryable error if run does not exist", async () => {
    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    await expect(
      activities.buildContext({ runId: randomUUID() }),
    ).rejects.toThrow(/Agent run not found/);
  });

  it("filters non-existent node IDs in routeHints", async () => {
    const runId = randomUUID();
    const snapshot = {
      nodes: [{ id: "valid-node", type: "text" }],
      edges: [],
    };
    const hints = {
      selectedNodeIds: ["valid-node", "ghost-node-404"],
    };

    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, route_hints, canvas_version, canvas_snapshot, status, state, workflow_id)
      VALUES (${runId}, ${workspaceId}, ${projectId}, ${canvasId}, 'creative-assistant', 'Edit this', ${JSON.stringify(hints)}::jsonb, 1, ${JSON.stringify(snapshot)}::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, 'wf-1')`;

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    const ctx = await activities.buildContext({ runId });
    expect(ctx.system).toContain("valid-node");
    expect(ctx.system).not.toContain("ghost-node-404");
  });

  it("does not leak SKILL.md body into system prompt (M6 progressive disclosure)", async () => {
    const fs = await import("node:fs/promises");
    const skillPath = resolve(skillsDir, "shot-list/SKILL.md");
    const content = await fs.readFile(skillPath, "utf-8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const runId = randomUUID();
    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, canvas_version, canvas_snapshot, status, state, workflow_id)
      VALUES (${runId}, ${workspaceId}, ${projectId}, ${canvasId}, 'creative-assistant', 'Create shot list /shot-list', 1, '{"nodes":[],"edges":[]}'::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, 'wf-1')`;

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir,
      modelResolver: createModelResolver(),
    });

    const ctx = await activities.buildContext({ runId });

    const bodyLines = lines.filter(
      (l) =>
        !l.startsWith("#") &&
        !l.includes("Turn a short story beat into a numbered shot list"),
    );

    expect(bodyLines.length).toBeGreaterThan(0);
    for (const line of bodyLines) {
      expect(ctx.system).not.toContain(line);
    }
  });

  it("propagates loadSkills exception rather than swallowing it (S10)", async () => {
    const runId = randomUUID();
    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, canvas_version, canvas_snapshot, status, state, workflow_id)
      VALUES (${runId}, ${workspaceId}, ${projectId}, ${canvasId}, 'creative-assistant', 'Test error', 1, '{"nodes":[],"edges":[]}'::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, 'wf-1')`;

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher: dummyPublisher,
      skillsDir: "/non/existent/skills/path",
      modelResolver: createModelResolver(),
    });

    await expect(activities.buildContext({ runId })).rejects.toThrow();
  });
});
