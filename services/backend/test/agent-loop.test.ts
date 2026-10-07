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

  it("POST /api/v1/agent/runs rejects unknown profile with 400", async () => {
    const { app, db, close } = createTestApp(dbUrl);
    try {
      const user = await createUserWithWorkspace(db, "owner");
      const { projectId, canvasId, version } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const url = "/api/v1/agent/runs";
      const userHeaders = signedHeaders("POST", url, {
        authType: "jwt",
        userId: user.userId,
      });

      const res = await app.inject({
        method: "POST",
        url,
        headers: userHeaders,
        payload: {
          projectId,
          canvasId,
          canvasVersion: version,
          prompt: "Hello",
          profileId: "unknown-profile-999",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain(
        "Unknown profile 'unknown-profile-999'",
      );
    } finally {
      await close();
    }
  });

  it("POST /api/v1/agent/runs handles start failure with 503, outcome null, and readable failed state", async () => {
    const startSpy = vi.fn().mockRejectedValue(new Error("Temporal down"));
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
      const { projectId, canvasId, version } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const url = "/api/v1/agent/runs";
      const userHeaders = signedHeaders("POST", url, {
        authType: "jwt",
        userId: user.userId,
      });

      const startRes = await app.inject({
        method: "POST",
        url,
        headers: userHeaders,
        payload: {
          projectId,
          canvasId,
          canvasVersion: version,
          prompt: "Test start failure",
        },
      });

      expect(startRes.statusCode).toBe(503);
      expect(startRes.json()).toEqual({
        error: "Execution engine unavailable",
      });

      // Find the created run row in DB
      const [failedRun] = await db
        .select()
        .from(agent_runs)
        .where(eq(schema.agent_runs.createdBy, user.userId));
      expect(failedRun).toBeDefined();
      expect(failedRun!.status).toBe("failed");
      expect(failedRun!.outcome).toBeNull();
      expect(failedRun!.error).toBe("Execution engine unavailable");

      // GET the run -> 200, status=failed, outcome=null
      const getUrl = `/api/v1/agent/runs/${failedRun!.id}`;
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
      expect(getRes.json().run.status).toBe("failed");
      expect(getRes.json().run.outcome).toBeNull();
      expect(getRes.json().run.error).toBe("Execution engine unavailable");
    } finally {
      await close();
    }
  });

  it("POST /api/v1/agent/runs/:runId/approvals validates state, idempotency, and forwards approval signal", async () => {
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
        state: {
          steps: [],
          proposals: [
            {
              toolCallId: "call-pending",
              toolName: "canvas_applyPatch",
              input: {},
              summary: "Pending patch",
              risk: "write",
              status: "pending",
            },
            {
              toolCallId: "call-approved",
              toolName: "canvas_applyPatch",
              input: {},
              summary: "Approved patch",
              risk: "write",
              status: "approved",
            },
          ],
        },
        workflowId: "wf-approval-test",
      });

      const approvalUrl = `/api/v1/agent/runs/${runId}/approvals`;
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
        payload: { toolCallId: "call-pending", decision: "approve" },
      });
      expect(otherRes.statusCode).toBe(404);

      // 2. Non-existent toolCallId -> 409
      const missingCallRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-unknown", decision: "approve" },
      });
      expect(missingCallRes.statusCode).toBe(409);
      expect(missingCallRes.json().error).toContain("Proposal not found");

      // 3. Non-pending proposal with conflicting decision -> 409
      const conflictRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-approved", decision: "reject" },
      });
      expect(conflictRes.statusCode).toBe(409);
      expect(conflictRes.json().error).toContain("Proposal is not pending");

      // 4. Non-pending proposal with same decision -> 409
      const duplicateRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-approved", decision: "approve" },
      });
      expect(duplicateRes.statusCode).toBe(409);
      expect(duplicateRes.json().error).toContain("Proposal is not pending");

      // 5. Valid pending proposal approval -> 202
      const okRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-pending", decision: "approve" },
      });
      expect(okRes.statusCode).toBe(202);
      expect(okRes.json()).toEqual({ accepted: true });
      expect(signalSpy).toHaveBeenCalledWith(user.userId, runId, {
        toolCallId: "call-pending",
        decision: "approve",
      });

      // 6. Temporal WorkflowNotFoundError -> 409
      const { WorkflowNotFoundError } = await import("@temporalio/client");
      signalSpy.mockRejectedValueOnce(
        new WorkflowNotFoundError(
          "Workflow not found",
          "wf-approval-test",
          undefined,
        ),
      );
      const wfNotFoundRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-pending", decision: "approve" },
      });
      expect(wfNotFoundRes.statusCode).toBe(409);
      expect(wfNotFoundRes.json().error).toBe("Workflow not found");

      // 7. Temporal unavailable (other error) -> 503
      signalSpy.mockRejectedValueOnce(new Error("Temporal connection lost"));
      const temporalErrRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-pending", decision: "approve" },
      });
      expect(temporalErrRes.statusCode).toBe(503);
      expect(temporalErrRes.json().error).toBe("Execution engine unavailable");

      // 8. Run not waiting_approval -> 409
      await db
        .update(agent_runs)
        .set({ status: "running" })
        .where(eq(schema.agent_runs.id, runId));
      const notWaitingRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-pending", decision: "approve" },
      });
      expect(notWaitingRes.statusCode).toBe(409);
      expect(notWaitingRes.json().error).toContain(
        "Run is not waiting approval",
      );

      // 9. Run already completed -> 409
      await db
        .update(agent_runs)
        .set({ status: "completed" })
        .where(eq(schema.agent_runs.id, runId));
      const completedRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: userHeaders,
        payload: { toolCallId: "call-pending", decision: "approve" },
      });
      expect(completedRes.statusCode).toBe(409);
      expect(completedRes.json().error).toContain(
        "Run is not waiting approval",
      );
    } finally {
      await close();
    }
  });

  it("enforces created_by isolation within the same workspace and after member removal", async () => {
    const { app, db, close } = createTestApp(dbUrl);
    try {
      const owner = await createUserWithWorkspace(db, "owner-s2");
      const otherUser = await createUserWithWorkspace(db, "other-s2");
      const { projectId, canvasId, version } = await setupCanvas(
        db,
        owner.userId,
        owner.workspaceId,
      );

      // Add a peer member to the same workspace
      const peer = await createUserWithWorkspace(db, "peer-s2");
      await db.insert(schema.workspace_members).values({
        workspace_id: owner.workspaceId,
        userId: peer.userId,
        role: "member",
        createdAt: new Date(),
      });

      const runId = randomUUID();
      await db.insert(agent_runs).values({
        id: runId,
        workspaceId: owner.workspaceId,
        projectId,
        canvasId,
        createdBy: owner.userId,
        profileId: "creative-assistant",
        prompt: "Isolation test",
        canvasVersion: version,
        canvasSnapshot: {},
        status: "waiting_approval",
        state: {
          steps: [],
          proposals: [
            {
              toolCallId: "call-iso",
              toolName: "canvas_applyPatch",
              input: {},
              summary: "Iso patch",
              risk: "write",
              status: "pending",
            },
          ],
        },
        workflowId: "wf-iso-test",
      });

      const getUrl = `/api/v1/agent/runs/${runId}`;
      const approvalUrl = `/api/v1/agent/runs/${runId}/approvals`;

      // Peer in same workspace attempts GET -> 404
      const peerGetRes = await app.inject({
        method: "GET",
        url: getUrl,
        headers: signedHeaders("GET", getUrl, {
          authType: "jwt",
          userId: peer.userId,
        }),
      });
      expect(peerGetRes.statusCode).toBe(404);

      // User in another workspace attempts GET -> 404
      const otherGetRes = await app.inject({
        method: "GET",
        url: getUrl,
        headers: signedHeaders("GET", getUrl, {
          authType: "jwt",
          userId: otherUser.userId,
        }),
      });
      expect(otherGetRes.statusCode).toBe(404);

      // Strict equality of 404 payloads
      expect(peerGetRes.json()).toEqual(otherGetRes.json());
      expect(peerGetRes.json()).toEqual({ error: "Run not found" });

      // Peer in same workspace attempts approvals -> 404
      const peerApprovalRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: signedHeaders("POST", approvalUrl, {
          authType: "jwt",
          userId: peer.userId,
        }),
        payload: { toolCallId: "call-iso", decision: "approve" },
      });
      expect(peerApprovalRes.statusCode).toBe(404);

      const otherApprovalRes = await app.inject({
        method: "POST",
        url: approvalUrl,
        headers: signedHeaders("POST", approvalUrl, {
          authType: "jwt",
          userId: otherUser.userId,
        }),
        payload: { toolCallId: "call-iso", decision: "approve" },
      });
      expect(otherApprovalRes.statusCode).toBe(404);
      expect(peerApprovalRes.json()).toEqual(otherApprovalRes.json());

      // Creator removed from workspace -> 404
      await db
        .delete(schema.workspace_members)
        .where(eq(schema.workspace_members.userId, owner.userId));

      const removedCreatorRes = await app.inject({
        method: "GET",
        url: getUrl,
        headers: signedHeaders("GET", getUrl, {
          authType: "jwt",
          userId: owner.userId,
        }),
      });
      expect(removedCreatorRes.statusCode).toBe(404);
      expect(removedCreatorRes.json()).toEqual({ error: "Run not found" });
    } finally {
      await close();
    }
  });
});
