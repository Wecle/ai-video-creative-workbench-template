import { randomBytes, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@creative/database";
import { MockProvider, ProviderRegistry } from "@creative/providers";
import { createActivities, type Database } from "../src/activities";

if (!process.env.TEST_DATABASE_URL) {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // ignore
  }
}
const baseUrl = process.env.TEST_DATABASE_URL;

describe("orchestrator-worker activities", () => {
  describe("node execution logic", () => {
    it("executes text and image.generate nodes via registered providers", async () => {
      const registry = new ProviderRegistry();
      const mockProvider = new MockProvider();
      registry.register(mockProvider);

      // Using null DB for pure execution test
      const activities = createActivities({
        db: null as unknown as Database,
        registry,
      });

      const textRes = await activities.executeNode({
        runId: randomUUID(),
        nodeId: "n-1",
        nodeType: "text",
        version: 1,
        config: { text: "Hello AI" },
        inputs: {},
      });
      expect(textRes).toEqual({
        status: "succeeded",
        outputs: { text: "Hello AI" },
      });

      const imageRes = await activities.executeNode({
        runId: randomUUID(),
        nodeId: "n-2",
        nodeType: "image.generate",
        version: 1,
        config: { prompt: "", aspectRatio: "16:9" },
        inputs: { prompt: "A glowing sunset" },
        mockMode: "polling",
      });
      expect(imageRes.status).toBe("pending");
      if (imageRes.status === "pending") {
        expect(imageRes.provider).toBe("mock");
        expect(imageRes.mode).toBe("polling");

        const pollRes = await activities.pollJob({
          provider: imageRes.provider,
          externalJobId: imageRes.externalJobId,
        });
        expect(pollRes.status).toBe("succeeded");
        if (pollRes.status === "succeeded") {
          expect(pollRes.outputs.image).toBeDefined();
        }
      }
    });
  });

  describe.skipIf(!baseUrl)("database idempotency", () => {
    let admin: postgres.Sql;
    let client: postgres.Sql;
    let db: Database;
    let dbName: string;

    let workspaceId: string;
    let projectId: string;
    let canvasId: string;
    let runId: string;

    beforeAll(async () => {
      admin = postgres(baseUrl!, { max: 1 });
      dbName = `orch_test_${randomBytes(6).toString("hex")}`;
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);

      const url = new URL(baseUrl!);
      url.pathname = `/${dbName}`;
      client = postgres(url.toString(), { max: 2 });
      db = drizzle(client, { schema });

      await migrate(db, {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/migrations", import.meta.url),
        ),
      });

      // Seed workspace, project, canvas, and run
      const [ws] = await client<{ id: string }[]>`
        INSERT INTO workspaces (name, slug, created_at) VALUES ('WS', 'ws', now()) RETURNING id`;
      workspaceId = ws!.id;

      const [proj] = await client<{ id: string }[]>`
        INSERT INTO projects (workspace_id, name) VALUES (${workspaceId}, 'P1') RETURNING id`;
      projectId = proj!.id;

      const [cv] = await client<{ id: string }[]>`
        INSERT INTO canvases (project_id, workspace_id, name, yjs_state, snapshot, schema_version)
        VALUES (${projectId}, ${workspaceId}, 'C1', ${Buffer.from([1, 2, 3])}, '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb, 1) RETURNING id`;
      canvasId = cv!.id;

      const [rn] = await client<{ id: string }[]>`
        INSERT INTO runs (canvas_id, project_id, workspace_id, status, canvas_version, snapshot, workflow_id)
        VALUES (${canvasId}, ${projectId}, ${workspaceId}, 'queued', 0, '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb, 'wf-1') RETURNING id`;
      runId = rn!.id;
    });

    afterAll(async () => {
      await client?.end({ timeout: 5 }).catch(() => undefined);
      if (admin && dbName) {
        await admin
          .unsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`)
          .catch(() => undefined);
        await admin.end({ timeout: 5 }).catch(() => undefined);
      }
    });

    it("executes recordNodeRunStarted idempotently upon Temporal retries", async () => {
      const activities = createActivities({
        db,
        registry: new ProviderRegistry(),
      });

      // First execution
      await activities.recordNodeRunStarted({
        runId,
        nodeId: "node-1",
        nodeType: "text",
        inputs: { text: "first" },
      });

      // Second execution (Temporal retry) with same runId and nodeId
      await activities.recordNodeRunStarted({
        runId,
        nodeId: "node-1",
        nodeType: "text",
        inputs: { text: "retry" },
      });

      const rows = await client<
        { status: string; inputs: Record<string, unknown> }[]
      >`
        SELECT status, inputs FROM node_runs WHERE run_id = ${runId} AND node_id = 'node-1'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("running");
      expect(rows[0]!.inputs).toEqual({ text: "retry" });
    });

    it("executes recordNodeRunCompleted idempotently upon Temporal retries", async () => {
      const activities = createActivities({
        db,
        registry: new ProviderRegistry(),
      });

      await activities.recordNodeRunCompleted({
        runId,
        nodeId: "node-1",
        status: "succeeded",
        outputs: { text: "done" },
        provider: "mock",
        externalJobId: "job-1",
      });

      // Repeated retry
      await activities.recordNodeRunCompleted({
        runId,
        nodeId: "node-1",
        status: "succeeded",
        outputs: { text: "done" },
        provider: "mock",
        externalJobId: "job-1",
      });

      const rows = await client<
        { status: string; outputs: Record<string, unknown> }[]
      >`
        SELECT status, outputs FROM node_runs WHERE run_id = ${runId} AND node_id = 'node-1'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("succeeded");
      expect(rows[0]!.outputs).toEqual({ text: "done" });
    });

    it("loads graph and updates run status", async () => {
      const activities = createActivities({
        db,
        registry: new ProviderRegistry(),
      });

      const graph = await activities.loadRunGraph(runId);
      expect(graph.runId).toBe(runId);
      expect(graph.canvasId).toBe(canvasId);

      await activities.updateRunStatus({ runId, status: "running" });
      const [r1] = await client<{ status: string }[]>`
        SELECT status FROM runs WHERE id = ${runId}`;
      expect(r1!.status).toBe("running");

      await activities.updateRunStatus({ runId, status: "succeeded" });
      const [r2] = await client<{ status: string }[]>`
        SELECT status FROM runs WHERE id = ${runId}`;
      expect(r2!.status).toBe("succeeded");
    });

    it("loads ready asset and rejects non-ready or missing asset", async () => {
      const activities = createActivities({
        db,
        registry: new ProviderRegistry(),
      });

      const [pendingAsset] = await client<{ id: string }[]>`
        INSERT INTO assets (workspace_id, key, content_type, size_bytes, status)
        VALUES (${workspaceId}, 'workspaces/w/assets/pending-1', 'image/png', 100, 'pending')
        RETURNING id`;

      const [readyAsset] = await client<{ id: string }[]>`
        INSERT INTO assets (workspace_id, key, content_type, size_bytes, status)
        VALUES (${workspaceId}, 'workspaces/w/assets/ready-1', 'image/jpeg', 200, 'ready')
        RETURNING id`;

      await expect(
        activities.loadAsset({ assetId: randomUUID() }),
      ).rejects.toThrow(/Asset not found/);

      await expect(
        activities.loadAsset({ assetId: pendingAsset!.id }),
      ).rejects.toThrow(/Asset not ready/);

      const loaded = await activities.loadAsset({ assetId: readyAsset!.id });
      expect(loaded).toEqual({
        assetKey: "workspaces/w/assets/ready-1",
        contentType: "image/jpeg",
        sizeBytes: 200,
      });
    });

    it("saves asset metadata idempotently", async () => {
      const activities = createActivities({
        db,
        registry: new ProviderRegistry(),
      });

      const [asset] = await client<{ id: string }[]>`
        INSERT INTO assets (workspace_id, key, content_type, size_bytes, status)
        VALUES (${workspaceId}, 'workspaces/w/assets/meta-1', 'image/png', 300, 'ready')
        RETURNING id`;

      const metadata = {
        assetKey: "workspaces/w/assets/meta-1",
        kind: "image",
        contentType: "image/png",
        sizeBytes: 300,
        probedBy: "media-worker-python" as const,
        pythonVersion: "3.12.0",
      };

      await activities.saveAssetMetadata({
        assetId: asset!.id,
        metadata,
      });

      const [row] = await client<{ metadata: Record<string, unknown> }[]>`
        SELECT metadata FROM assets WHERE id = ${asset!.id}`;
      expect(row!.metadata).toEqual(metadata);
    });
  });
});
