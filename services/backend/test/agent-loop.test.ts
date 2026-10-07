import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { schema } from "@creative/database";
import type { AgentLoopService } from "../src/temporal/agent-loops";
import {
  createTestApp,
  createUserWithWorkspace,
  signedHeaders,
  testDatabaseUrl,
} from "./helpers";

const { projects, canvases, agent_runs } = schema;

async function setupCanvas(
  db: ReturnType<typeof createTestApp>["db"],
  userId: string,
  workspaceId: string,
) {
  const [proj] = await db
    .insert(projects)
    .values({
      name: "Test Proj",
      workspaceId,
      createdBy: userId,
    })
    .returning();

  const [canvas] = await db
    .insert(canvases)
    .values({
      name: "Test Canvas",
      projectId: proj!.id,
      workspaceId,
      yjsState: Buffer.from([]),
      snapshot: { schemaVersion: 1, nodes: [], edges: [] },
      version: 1,
      schemaVersion: 1,
      updatedBy: userId,
    })
    .returning();

  return {
    projectId: proj!.id,
    canvasId: canvas!.id,
    version: canvas!.version,
  };
}

describe("backend agent loop REST endpoints", () => {
  const dbUrl = testDatabaseUrl()!;

  it("GET /api/v1/agent/profiles returns profile summaries", async () => {
    const { app, close } = createTestApp(dbUrl);
    try {
      const url = "/api/v1/agent/profiles";
      const headers = signedHeaders("GET", url, {
        authType: "jwt",
        userId: "user-1",
      });
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data.profiles)).toBe(true);
      expect(data.profiles.length).toBeGreaterThanOrEqual(1);
      const assistant = data.profiles.find(
        (p: { id: string }) => p.id === "creative-assistant",
      );
      expect(assistant).toBeDefined();
      expect(assistant.starters.length).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });

  it("POST /api/v1/agent/runs enforces authorization, optimistic concurrency, and starts workflow", async () => {
    const startSpy = vi.fn().mockResolvedValue({ workflowId: "wf-123" });
    const mockAgentLoops: AgentLoopService = {
      start: startSpy,
      signalApproval: vi.fn(),
      describe: vi.fn(),
      ping: vi.fn(),
    };

    const { app, db, close } = createTestApp(dbUrl, {
      agentLoops: mockAgentLoops,
    });
    try {
      const user = await createUserWithWorkspace(db, "owner");
      const otherUser = await createUserWithWorkspace(db, "other");
      const { projectId, canvasId, version } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const url = "/api/v1/agent/runs";

      // 1. Inaccessible canvas -> 404
      const otherHeaders = signedHeaders("POST", url, {
        authType: "jwt",
        userId: otherUser.userId,
      });
      const res404 = await app.inject({
        method: "POST",
        url,
        headers: otherHeaders,
        payload: {
          projectId,
          canvasId,
          canvasVersion: version,
          prompt: "Hello",
        },
      });
      expect(res404.statusCode).toBe(404);

      // 2. Version mismatch -> 409
      const userHeaders = signedHeaders("POST", url, {
        authType: "jwt",
        userId: user.userId,
      });
      const res409 = await app.inject({
        method: "POST",
        url,
        headers: userHeaders,
        payload: {
          projectId,
          canvasId,
          canvasVersion: version + 10,
          prompt: "Hello",
        },
      });
      expect(res409.statusCode).toBe(409);
      expect(res409.json().currentVersion).toBe(version);

      // 3. Valid request -> 202 Accepted
      const res202 = await app.inject({
        method: "POST",
        url,
        headers: userHeaders,
        payload: {
          projectId,
          canvasId,
          canvasVersion: version,
          prompt: "Add note /shot-list",
          profileId: "creative-assistant",
          selectedSkills: ["shot-list"],
        },
      });
      expect(res202.statusCode).toBe(202);
      const data = res202.json();
      expect(data.run.id).toBeDefined();
      expect(data.run.status).toBe("running");
      expect(data.run.profileId).toBe("creative-assistant");
      expect(startSpy).toHaveBeenCalledWith(user.userId, data.run.id);

      // 4. GET /api/v1/agent/runs/:runId
      const getUrl = `/api/v1/agent/runs/${data.run.id}`;
      const getHeaders = signedHeaders("GET", getUrl, {
        authType: "jwt",
        userId: user.userId,
      });
      const getRes = await app.inject({
        method: "GET",
        url: getUrl,
        headers: getHeaders,
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().run.id).toBe(data.run.id);

      // 5. Another user cannot GET run -> 404
      const otherGetHeaders = signedHeaders("GET", getUrl, {
        authType: "jwt",
        userId: otherUser.userId,
      });
      const otherGetRes = await app.inject({
        method: "GET",
        url: getUrl,
        headers: otherGetHeaders,
      });
      expect(otherGetRes.statusCode).toBe(404);
    } finally {
      await close();
    }
  });

  it("POST /api/v1/agent/runs/:runId/approval validates state and forwards approval signal", async () => {
    const signalSpy = vi.fn().mockResolvedValue(undefined);
    const mockAgentLoops: AgentLoopService = {
      start: vi.fn(),
      signalApproval: signalSpy,
      describe: vi.fn(),
      ping: vi.fn(),
    };

    const { app, db, close } = createTestApp(dbUrl, {
      agentLoops: mockAgentLoops,
    });
    try {
      const user = await createUserWithWorkspace(db, "owner");
      const otherUser = await createUserWithWorkspace(db, "other");
      const { projectId, canvasId, version } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const runId = randomUUID();
      await db.insert(agent_runs).values({
        id: runId,
        workspaceId: user.workspaceId,
        projectId,
        canvasId,
        createdBy: user.userId,
        profileId: "creative-assistant",
        prompt: "Approval test",
        canvasVersion: version,
        canvasSnapshot: {},
        status: "waiting_approval",
        workflowId: "wf-approval-test",
      });

      const approvalUrl = `/api/v1/agent/runs/${runId}/approval`;
      const userHeaders = signedHeaders("POST", approvalUrl, {
        authType: "jwt",
        userId: user.userId,
      });

      // 1. Other user -> 404
      const otherHeaders = signedHeaders("POST", approvalUrl, {
        authType: "jwt",
        userId: otherUser.userId,
      });
      const otherRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: otherHeaders,
        payload: { toolCallId: "call-1", decision: "approve" },
      });
      expect(otherRes.statusCode).toBe(404);

      // 2. User approves -> 202
      const okRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-1", decision: "approve" },
      });
      expect(okRes.statusCode).toBe(202);
      expect(okRes.json()).toEqual({ ok: true });
      expect(signalSpy).toHaveBeenCalledWith(user.userId, runId, {
        toolCallId: "call-1",
        decision: "approve",
      });

      // 3. Terminal run -> 409
      await db
        .update(agent_runs)
        .set({ status: "completed" })
        .where(eq(schema.agent_runs.id, runId));
      const terminalRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-1", decision: "reject" },
      });
      expect(terminalRes.statusCode).toBe(409);
    } finally {
      await close();
    }
  });
});
