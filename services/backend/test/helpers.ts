import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultLogger, Runtime } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { TEMPORAL_DEV_CLI_VERSION } from "@creative/workflows/constants";
import {
  signInternalIdentity,
  type InternalIdentity,
} from "@creative/contracts/internal-auth";
import { createDatabase, schema } from "@creative/database";
import type { Registry } from "@creative/node-registry";
import { buildApp } from "../src/app";
import { createAuth } from "../src/auth/auth";
import type { AgentRunService } from "../src/temporal/agent-runs";

export const INTERNAL_SECRET = "test-internal-secret-0123456789abcdef";
export const BETTER_AUTH_SECRET = "test-better-auth-secret-0123456789abcd";
export const WEB_ORIGIN = "http://localhost:3000";

/** Integration tests need Postgres; in CI a missing variable is a failure, not a skip. */
export function testDatabaseUrl() {
  if (!process.env.TEST_DATABASE_URL) {
    try {
      process.loadEnvFile(new URL("../../../.env", import.meta.url));
    } catch {
      // ignore
    }
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url && process.env.CI)
    throw new Error("TEST_DATABASE_URL is required in CI");
  return url;
}

/** What the gateway would add for a request: a signed identity. */
export function signedHeaders(
  method: string,
  path: string,
  identity: InternalIdentity = { authType: "anonymous" },
  extra: { nowSeconds?: number; secret?: string } = {},
) {
  return signInternalIdentity({
    secret: extra.secret ?? INTERNAL_SECRET,
    method,
    pathname: path.split("?")[0]!,
    identity,
    nowSeconds: extra.nowSeconds,
  });
}

/**
 * Default for tests that are not about agent runs: reaching Temporal is a bug there, so
 * start/get throw. ping resolves so that /ready only reflects the database.
 */
import type { CanvasRunService } from "../src/temporal/canvas-runs";
import type { AssetProbeService } from "../src/temporal/asset-probes";
import type { ProviderRegistry } from "@creative/providers";

export const unusedAgentRuns: AgentRunService = {
  start: async () => {
    throw new Error("agentRuns.start must not be called in this test");
  },
  get: async () => {
    throw new Error("agentRuns.get must not be called in this test");
  },
  ping: async () => {},
};

export const unusedCanvasRuns: CanvasRunService = {
  start: async () => {
    throw new Error("canvasRuns.start must not be called in this test");
  },
  sendCallbackSignal: async () => {
    throw new Error(
      "canvasRuns.sendCallbackSignal must not be called in this test",
    );
  },
};

export const unusedAssetProbes: AssetProbeService = {
  start: async () => {
    throw new Error("assetProbes.start must not be called in this test");
  },
};

/**
 * Local Temporal server from the Temporal CLI, pinned to TEMPORAL_DEV_CLI_VERSION.
 * Same helper as packages/workflows/test/helpers.ts; see that file for the rationale.
 * First run downloads the CLI from https://temporal.download; TEMPORAL_CLI_PATH skips it.
 */
export async function createTemporalTestEnv() {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  const path = process.env.TEMPORAL_CLI_PATH;
  const downloadDir = join(
    tmpdir(),
    `creative-temporal-cli-${TEMPORAL_DEV_CLI_VERSION}`,
  );
  if (!path) mkdirSync(downloadDir, { recursive: true });
  return TestWorkflowEnvironment.createLocal({
    server: {
      executable: path
        ? { type: "existing-path", path }
        : {
            type: "cached-download",
            version: TEMPORAL_DEV_CLI_VERSION,
            downloadDir,
          },
    },
  });
}

import type { Redis } from "ioredis";
import type { RunEventBus } from "../src/realtime/run-event-bus";

export function redisUrl() {
  if (!process.env.REDIS_URL) {
    try {
      process.loadEnvFile(new URL("../../../.env", import.meta.url));
    } catch {
      // ignore
    }
  }
  const url = process.env.REDIS_URL;
  if (!url && process.env.CI) throw new Error("REDIS_URL is required in CI");
  return url ?? "redis://localhost:6379";
}

/**
 * Backend wired to a real Better Auth instance. postgres-js connects lazily, so
 * without TEST_DATABASE_URL this still works for tests that never touch the database.
 */
export function createTestApp(
  databaseUrl = testDatabaseUrl() ??
    "postgresql://nobody:nobody@127.0.0.1:1/none",
  {
    agentRuns = unusedAgentRuns,
    canvasRuns = unusedCanvasRuns,
    assetProbes = unusedAssetProbes,
    providerRegistry,
    registry,
    production,
    bus,
    redis,
    pingIntervalMs,
    storage,
  }: {
    agentRuns?: AgentRunService;
    canvasRuns?: CanvasRunService;
    assetProbes?: AssetProbeService;
    providerRegistry?: ProviderRegistry;
    registry?: Registry;
    production?: boolean;
    bus?: RunEventBus;
    redis?: Redis;
    pingIntervalMs?: number;
    storage?: import("@creative/storage").ObjectStorage;
  } = {},
) {
  const database = createDatabase(databaseUrl);
  const auth = createAuth({
    db: database.db,
    schema,
    config: { webOrigin: WEB_ORIGIN, betterAuthSecret: BETTER_AUTH_SECRET },
  });
  const app = buildApp({
    logger: false,
    auth,
    db: database.db,
    internalSecret: INTERNAL_SECRET,
    webOrigin: WEB_ORIGIN,
    agentRuns,
    canvasRuns,
    assetProbes,
    providerRegistry,
    registry,
    production,
    bus,
    redis,
    pingIntervalMs,
    storage,
  });
  return {
    app,
    auth,
    db: database.db,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

/** A user with a personal workspace, inserted directly (no sign-up round trip). */
export async function createUserWithWorkspace(
  db: ReturnType<typeof createDatabase>["db"],
  label = "user",
) {
  const key = randomUUID();
  const [user] = await db
    .insert(schema.users)
    .values({ name: label, email: `p1-${key}@example.test` })
    .returning({ id: schema.users.id });
  const workspace = await createWorkspace(db, user!.id, `${label}'s workspace`);
  return { userId: user!.id, workspaceId: workspace };
}

export async function createWorkspace(
  db: ReturnType<typeof createDatabase>["db"],
  userId: string,
  name: string,
  createdAt = new Date(),
) {
  const [workspace] = await db
    .insert(schema.workspaces)
    .values({ name, slug: `ws-${randomUUID()}`, createdAt })
    .returning({ id: schema.workspaces.id });
  await db.insert(schema.workspace_members).values({
    workspace_id: workspace!.id,
    userId,
    role: "owner",
    createdAt,
  });
  return workspace!.id;
}
