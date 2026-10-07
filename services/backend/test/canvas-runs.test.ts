import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@creative/database";
import type { CanvasRunService } from "../src/temporal/canvas-runs";
import {
  createTestApp,
  createUserWithWorkspace,
  signedHeaders,
  testDatabaseUrl,
} from "./helpers";

const databaseUrl = testDatabaseUrl();
type Identity = Parameters<typeof signedHeaders>[2];

describe.skipIf(!databaseUrl)("canvas runs (Postgres)", () => {
  const startedWorkflows: Array<{
    canvasId: string;
    runId: string;
    mockMode?: "polling" | "callback";
  }> = [];

  let shouldFailTemporalStart = false;

  const mockCanvasRuns: CanvasRunService = {
    start: async (input) => {
      if (shouldFailTemporalStart) {
        throw new Error("Simulated Temporal connection failure");
      }
      startedWorkflows.push(input);
    },
    sendCallbackSignal: async () => {},
  };

  const ctx = createTestApp(databaseUrl, {
    canvasRuns: mockCanvasRuns,
    production: false,
  });
  const { app, db } = ctx;

  const prodCtx = createTestApp(databaseUrl, {
    canvasRuns: mockCanvasRuns,
    production: true,
  });

  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const who = (userId: string): Identity => ({ authType: "jwt", userId });

  const call = (
    instance: typeof app,
    method: "GET" | "POST",
    url: string,
    identity?: Identity,
    body?: unknown,
  ) =>
    instance.inject({
      method,
      url,
      headers: {
        ...signedHeaders(method, url, identity),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });

  async function setup(label: string) {
    const user = await createUserWithWorkspace(db, label);
    workspaceIds.push(user.workspaceId);
    userIds.push(user.userId);
    const created = (
      await call(app, "POST", "/api/v1/projects", who(user.userId), {
        name: label,
      })
    ).json().project as { id: string; canvases: { id: string }[] };
    const base = `/api/v1/projects/${created.id}/canvases/${created.canvases[0]!.id}`;
    return {
      ...user,
      projectId: created.id,
      canvasId: created.canvases[0]!.id,
      base,
    };
  }

  beforeAll(async () => {
    await app.ready();
    await prodCtx.app.ready();
  });

  afterAll(async () => {
    if (workspaceIds.length) {
      await db
        .delete(schema.workspaces)
        .where(inArray(schema.workspaces.id, workspaceIds));
    }
    if (userIds.length) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await ctx.close();
    await prodCtx.close();
  });

  it("requires valid authenticated user", async () => {
    const a = await setup("auth-test");
    const res = await call(
      app,
      "POST",
      `${a.base}/runs`,
      { authType: "anonymous" },
      {},
    );
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for canvases belonging to other users", async () => {
    const a = await setup("user-a");
    const b = await setup("user-b");

    const res = await call(app, "POST", `${a.base}/runs`, who(b.userId), {});
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 in production mode if mockMode is supplied", async () => {
    const user = await createUserWithWorkspace(db, "prod-user");
    workspaceIds.push(user.workspaceId);
    userIds.push(user.userId);
    const created = (
      await call(prodCtx.app, "POST", "/api/v1/projects", who(user.userId), {
        name: "prod-proj",
      })
    ).json().project as { id: string; canvases: { id: string }[] };
    const base = `/api/v1/projects/${created.id}/canvases/${created.canvases[0]!.id}`;

    const res = await call(
      prodCtx.app,
      "POST",
      `${base}/runs`,
      who(user.userId),
      { mockMode: "polling" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("mockMode is not allowed in production");
  });

  it("starts a canvas run, creates DB record with queued status, and returns 202", async () => {
    const a = await setup("run-success");
    const res = await call(app, "POST", `${a.base}/runs`, who(a.userId), {
      mockMode: "polling",
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.run).toBeDefined();
    expect(body.run.status).toBe("queued");
    expect(body.run.canvasId).toBe(a.canvasId);
    expect(body.run.projectId).toBe(a.projectId);
    expect(body.run.createdBy).toBe(a.userId);

    const [dbRow] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, body.run.id));
    expect(dbRow).toBeDefined();
    expect(dbRow.status).toBe("queued");
    expect(dbRow.createdBy).toBe(a.userId);

    expect(startedWorkflows).toContainEqual({
      canvasId: a.canvasId,
      runId: body.run.id,
      mockMode: "polling",
    });

    // Query GET run
    const getRes = await call(
      app,
      "GET",
      `${a.base}/runs/${body.run.id}`,
      who(a.userId),
    );
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().run.id).toBe(body.run.id);
    expect(getRes.json().run.status).toBe("queued");
  });

  it("updates run to failed and returns 503 if starting workflow fails", async () => {
    const a = await setup("run-failure");
    shouldFailTemporalStart = true;

    try {
      const res = await call(app, "POST", `${a.base}/runs`, who(a.userId), {});
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("Execution engine unavailable");

      // Verify DB row status was updated to failed
      const [failedRun] = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.canvasId, a.canvasId));
      expect(failedRun).toBeDefined();
      expect(failedRun.status).toBe("failed");
      expect(failedRun.error).toBe("Execution engine unavailable");
    } finally {
      shouldFailTemporalStart = false;
    }
  });

  it("returns 404 when querying another user's run", async () => {
    const a = await setup("run-user-a");
    const b = await setup("run-user-b");

    const startRes = await call(
      app,
      "POST",
      `${a.base}/runs`,
      who(a.userId),
      {},
    );
    const runId = startRes.json().run.id;

    // User B attempts to access User A's run on User A's canvas
    const getRes1 = await call(
      app,
      "GET",
      `${a.base}/runs/${runId}`,
      who(b.userId),
    );
    expect(getRes1.statusCode).toBe(404);

    // User B attempts to access User A's run on User B's canvas
    const getRes2 = await call(
      app,
      "GET",
      `${b.base}/runs/${runId}`,
      who(b.userId),
    );
    expect(getRes2.statusCode).toBe(404);
  });
});
