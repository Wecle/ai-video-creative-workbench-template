import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@creative/database";
import { MockProvider, ProviderRegistry } from "@creative/providers";
import type { ProviderCallbackPayload } from "@creative/workflows/activities";
import type { CanvasRunService } from "../src/temporal/canvas-runs";
import {
  createTestApp,
  createUserWithWorkspace,
  signedHeaders,
  testDatabaseUrl,
} from "./helpers";

const databaseUrl = testDatabaseUrl();

describe.skipIf(!databaseUrl)("webhooks (Postgres)", () => {
  const signaledWorkflows: Array<{
    workflowId: string;
    payload: ProviderCallbackPayload;
  }> = [];

  const mockCanvasRuns: CanvasRunService = {
    start: async () => {},
    sendCallbackSignal: async (workflowId, payload) => {
      signaledWorkflows.push({ workflowId, payload });
    },
  };

  const mockProvider = new MockProvider();
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(mockProvider);

  const ctx = createTestApp(databaseUrl, {
    canvasRuns: mockCanvasRuns,
    providerRegistry,
  });
  const { app, db } = ctx;

  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  const callWebhook = (
    provider: string,
    payload: Buffer | string,
    headers: Record<string, string>,
  ) => {
    const url = `/api/webhooks/providers/${provider}`;
    return app.inject({
      method: "POST",
      url,
      headers: {
        ...signedHeaders("POST", url, { authType: "anonymous" }),
        ...headers,
      },
      payload,
    });
  };

  async function setupCanvasWithRun(label: string) {
    const user = await createUserWithWorkspace(db, label);
    workspaceIds.push(user.workspaceId);
    userIds.push(user.userId);

    const [project] = await db
      .insert(schema.projects)
      .values({
        workspaceId: user.workspaceId,
        name: `${label}-project`,
      })
      .returning();

    const [canvas] = await db
      .insert(schema.canvases)
      .values({
        workspaceId: user.workspaceId,
        projectId: project.id,
        name: `${label}-canvas`,
        version: 1,
        schemaVersion: 1,
        yjsState: Buffer.from([]),
        snapshot: { schemaVersion: 1, nodes: [], edges: [] },
      })
      .returning();

    const runId = randomUUID();
    const workflowId = `canvas-run:${canvas.id}:${runId}`;
    const [run] = await db
      .insert(schema.runs)
      .values({
        id: runId,
        canvasId: canvas.id,
        projectId: project.id,
        workspaceId: user.workspaceId,
        createdBy: user.userId,
        status: "running",
        canvasVersion: 1,
        snapshot: { schemaVersion: 1, nodes: [], edges: [] },
        workflowId,
      })
      .returning();

    const externalJobId = `mock-${randomUUID()}`;
    const [nodeRun] = await db
      .insert(schema.node_runs)
      .values({
        runId: run.id,
        nodeId: "image-gen-node",
        nodeType: "image.generate",
        provider: "mock",
        externalJobId,
        status: "running",
      })
      .returning();

    return {
      user,
      project,
      canvas,
      run,
      nodeRun,
      externalJobId,
      workflowId,
    };
  }

  beforeAll(async () => {
    await app.ready();
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
  });

  it("returns 404 for unknown provider", async () => {
    const res = await callWebhook("nonexistent", Buffer.from("{}"), {
      "content-type": "application/json",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 401 when signature is forged / invalid", async () => {
    const externalId = `mock-${randomUUID()}`;
    const { rawBody, headers } = mockProvider.createWebhookPayload(externalId);

    const forgedHeaders = {
      ...headers,
      "x-mock-signature":
        "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    };

    const res = await callWebhook("mock", rawBody, forgedHeaders);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when timestamp is expired (> 300 seconds)", async () => {
    const externalId = `mock-${randomUUID()}`;
    const expiredTimestamp = Date.now() - 301_000;
    const { rawBody, headers } = mockProvider.createWebhookPayload(
      externalId,
      {},
      expiredTimestamp,
    );

    const res = await callWebhook("mock", rawBody, headers);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when payload body is tampered", async () => {
    const externalId = `mock-${randomUUID()}`;
    const { rawBody, headers } = mockProvider.createWebhookPayload(externalId);

    // Tamper the payload body after headers/signature were computed
    const tamperedBody = Buffer.from(
      rawBody.toString("utf8").replace(externalId, `${externalId}-tampered`),
    );

    const res = await callWebhook("mock", tamperedBody, headers);
    expect(res.statusCode).toBe(401);
  });

  it("dispatches signal to temporal workflow on valid webhook and returns 200", async () => {
    const { externalJobId, workflowId } =
      await setupCanvasWithRun("valid-webhook");
    const { rawBody, headers } = mockProvider.createWebhookPayload(
      externalJobId,
      {
        status: "succeeded",
        output: {
          image: { url: "https://test.png", width: 1024, height: 1024 },
        },
      },
    );

    const res = await callWebhook("mock", rawBody, headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    expect(signaledWorkflows).toContainEqual({
      workflowId,
      payload: {
        provider: "mock",
        externalJobId,
        status: "succeeded",
        output: {
          image: { url: "https://test.png", width: 1024, height: 1024 },
        },
        error: undefined,
      },
    });
  });

  it("ignores duplicate webhook if node_run is already terminal in database", async () => {
    const { externalJobId, nodeRun } =
      await setupCanvasWithRun("duplicate-webhook");

    // Mark node_run as already succeeded
    await db
      .update(schema.node_runs)
      .set({ status: "succeeded" })
      .where(inArray(schema.node_runs.id, [nodeRun.id]));

    const signalCountBefore = signaledWorkflows.length;

    const { rawBody, headers } = mockProvider.createWebhookPayload(
      externalJobId,
      {
        status: "succeeded",
      },
    );

    const res = await callWebhook("mock", rawBody, headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: "already processed" });

    // Should NOT have sent another signal
    expect(signaledWorkflows.length).toBe(signalCountBefore);
  });
});
