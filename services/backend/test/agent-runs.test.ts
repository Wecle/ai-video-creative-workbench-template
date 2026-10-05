import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  ApplicationFailure,
  Client,
  Connection,
  ServiceError,
} from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { agentRunResponseSchema } from "@creative/contracts";
import { AGENT_TASK_QUEUE } from "@creative/workflows/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemporalAgentRuns } from "../src/temporal/agent-runs";
import type { AgentRunService } from "../src/temporal/agent-runs";
import { createTemporalTestEnv, createTestApp, signedHeaders } from "./helpers";

const alice = { authType: "jwt", userId: randomUUID() } as const;
const bob = { authType: "jwt", userId: randomUUID() } as const;
const RUNS = "/api/v1/agent-runs";

type Ctx = ReturnType<typeof createTestApp>;
type Identity = Parameters<typeof signedHeaders>[2];

function api({ app }: Ctx) {
  return {
    post: (body: unknown, identity?: Identity, signed = true) =>
      app.inject({
        method: "POST",
        url: RUNS,
        payload: body as object,
        headers: signed ? signedHeaders("POST", RUNS, identity) : {},
      }),
    get: (runId: string, identity?: Identity) => {
      const url = `${RUNS}/${runId}`;
      return app.inject({
        method: "GET",
        url,
        headers: signedHeaders("GET", url, identity),
      });
    },
  };
}

describe("agent-run routes (fake service)", () => {
  const calls: { userId: string; input: unknown }[] = [];
  let behavior: "ok" | "unavailable" | "missing" = "ok";
  const fake: AgentRunService = {
    start: async (userId, input) => {
      if (behavior === "unavailable") throw new ServiceError("down");
      calls.push({ userId, input });
      return {
        id: randomUUID(),
        status: "running",
        createdAt: new Date().toISOString(),
      };
    },
    get: async (_userId, runId) => {
      if (behavior === "unavailable") throw new ServiceError("down");
      return behavior === "missing"
        ? null
        : { id: runId, status: "running", createdAt: "2026-10-05T00:00:00Z" };
    },
    ping: async () => {},
  };
  const ctx = createTestApp(undefined, { agentRuns: fake });
  const { post, get } = api(ctx);
  beforeAll(async () => {
    await ctx.app.ready();
  });
  afterAll(async () => ctx.close());

  it("rejects unsigned requests with 403 and anonymous ones with 401", async () => {
    expect((await post({ prompt: "Hi" }, alice, false)).statusCode).toBe(403);
    expect((await post({ prompt: "Hi" })).statusCode).toBe(401);
    expect((await get(randomUUID())).statusCode).toBe(401);
  });

  it("validates the body", async () => {
    expect((await post({}, alice)).statusCode).toBe(400);
    expect((await post({ prompt: "   " }, alice)).statusCode).toBe(400);
  });

  it("answers 202 and takes the owner from the identity, not the body", async () => {
    calls.length = 0;
    const response = await post(
      { prompt: "Hello", projectId: "p1", canvasId: "c1", userId: "evil" },
      alice,
    );
    expect(response.statusCode).toBe(202);
    expect(agentRunResponseSchema.parse(response.json()).run.status).toBe(
      "running",
    );
    expect(calls).toEqual([
      {
        userId: alice.userId,
        input: { prompt: "Hello", projectId: "p1", canvasId: "c1" },
      },
    ]);
  });

  it("answers 400 for a non-uuid run id and 404 for an unknown run", async () => {
    expect((await get("not-a-uuid", alice)).statusCode).toBe(400);
    behavior = "missing";
    expect((await get(randomUUID(), alice)).statusCode).toBe(404);
    behavior = "ok";
    expect((await get(randomUUID(), alice)).statusCode).toBe(200);
  });

  it("maps a Temporal ServiceError to 503", async () => {
    behavior = "unavailable";
    for (const response of [
      await post({ prompt: "Hi" }, alice),
      await get(randomUUID(), alice),
    ]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "Execution engine unavailable",
      });
    }
    behavior = "ok";
  });

  it("documents both routes in OpenAPI", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/docs/json",
      headers: signedHeaders("GET", "/docs/json"),
    });
    const paths = Object.keys(response.json().paths);
    expect(paths).toContain(RUNS);
    expect(paths).toContain(`${RUNS}/{runId}`);
  });
});

describe("agent runs through a real Temporal server", () => {
  let env: TestWorkflowEnvironment;
  let ctx: Ctx;
  let behavior: "ok" | "fail" = "ok";
  beforeAll(async () => {
    env = await createTemporalTestEnv();
    ctx = createTestApp(undefined, {
      agentRuns: createTemporalAgentRuns({
        client: env.client,
        connection: env.connection,
      }),
    });
    await ctx.app.ready();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
    await env?.teardown();
  });

  /** Runs `fn` while a worker with a stub activity serves the agent queue. */
  async function withWorker<T>(fn: () => Promise<T>) {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: AGENT_TASK_QUEUE,
      workflowsPath: createRequire(import.meta.url).resolve(
        "@creative/workflows",
      ),
      activities: {
        runEcho: async (input: { prompt: string }) => {
          if (behavior === "fail")
            throw ApplicationFailure.nonRetryable("secret internal detail");
          return { message: `Template Agent received: ${input.prompt}` };
        },
      },
    });
    return worker.runUntil(fn());
  }

  async function poll(runId: string, identity: Identity, until: string) {
    const { get } = api(ctx);
    for (let i = 0; i < 100; i++) {
      const response = await get(runId, identity);
      const { run } = agentRunResponseSchema.parse(response.json());
      if (run.status === until) return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`run never reached ${until}`);
  }

  it("starts an echo run, completes it and hides it from other users", async () => {
    behavior = "ok";
    await withWorker(async () => {
      const { post, get } = api(ctx);
      const created = await post({ prompt: "Hello" }, alice);
      expect(created.statusCode).toBe(202);
      const { run } = agentRunResponseSchema.parse(created.json());
      expect(run.status).toBe("running");

      const done = await poll(run.id, alice, "completed");
      expect(done.result).toEqual({
        message: "Template Agent received: Hello",
      });

      // Bob asks for Alice's run id: the id Temporal would need is under Bob's name.
      const stolen = await get(run.id, bob);
      expect(stolen.statusCode).toBe(404);
      expect(stolen.json()).toEqual({ error: "Run not found" });
    });
  }, 30_000);

  it("records the owner as the workflow id and memo", async () => {
    behavior = "ok";
    await withWorker(async () => {
      const created = await api(ctx).post({ prompt: "Hi" }, alice);
      const { run } = agentRunResponseSchema.parse(created.json());
      await poll(run.id, alice, "completed");
      const description = await env.client.workflow
        .getHandle(`agent-run:${alice.userId}:${run.id}`)
        .describe();
      expect(description.memo).toEqual({ userId: alice.userId });
      expect(description.taskQueue).toBe(AGENT_TASK_QUEUE);
    });
  }, 30_000);

  it("maps a failed workflow to status failed with a fixed message", async () => {
    behavior = "fail";
    await withWorker(async () => {
      const created = await api(ctx).post({ prompt: "Hi" }, alice);
      const { run } = agentRunResponseSchema.parse(created.json());
      const failed = await poll(run.id, alice, "failed");
      expect(failed.error).toEqual({ message: "Run failed" });
      expect(JSON.stringify(failed)).not.toContain("secret internal detail");
    });
    behavior = "ok";
  }, 30_000);

  it("reports ready when Temporal answers", async () => {
    const response = await ctx.app.inject("/ready");
    expect(response.json().dependencies.temporal).toBe("ready");
  });
});

describe("agent runs while Temporal is unreachable", () => {
  const connection = Connection.lazy({ address: "127.0.0.1:1" });
  const ctx = createTestApp(undefined, {
    agentRuns: createTemporalAgentRuns({
      client: new Client({ connection }),
      connection,
    }),
  });
  beforeAll(async () => {
    await ctx.app.ready();
  });
  afterAll(async () => {
    await ctx.close();
    await connection.close();
  });

  it("answers 503 for POST and GET within the deadline, not after ~20 s", async () => {
    const { post, get } = api(ctx);
    for (const send of [
      () => post({ prompt: "Hi" }, alice),
      () => get(randomUUID(), alice),
    ]) {
      const startedAt = Date.now();
      const response = await send();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "Execution engine unavailable",
      });
      expect(Date.now() - startedAt).toBeLessThan(6000);
    }
  }, 30_000);

  it("reports /ready as not ready", async () => {
    const response = await ctx.app.inject("/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json().dependencies.temporal).toBe("unavailable");
  });
});
