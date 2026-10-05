import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  createProjectResponseSchema,
  getCanvasResponseSchema,
  projectListResponseSchema,
} from "@creative/contracts";
import { schema } from "@creative/database";
import {
  fromBase64,
  loadCanvasDoc,
  readSnapshot,
  validateSnapshot,
} from "@creative/canvas-doc";
import { registry } from "@creative/node-registry";
import {
  createTestApp,
  createUserWithWorkspace,
  createWorkspace,
  signedHeaders,
  testDatabaseUrl,
} from "./helpers";

const databaseUrl = testDatabaseUrl();
type Identity = Parameters<typeof signedHeaders>[2];

describe.skipIf(!databaseUrl)("projects (Postgres)", () => {
  const ctx = createTestApp(databaseUrl);
  const { app, db } = ctx;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const identity = (userId: string): Identity => ({ authType: "jwt", userId });

  const call = (
    method: "GET" | "POST",
    url: string,
    who?: Identity,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...signedHeaders(method, url, who),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });

  async function newUser(label: string) {
    const created = await createUserWithWorkspace(db, label);
    workspaceIds.push(created.workspaceId);
    userIds.push(created.userId);
    return created;
  }

  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    // Workspaces cascade to members, projects and canvases.
    if (workspaceIds.length)
      await db
        .delete(schema.workspaces)
        .where(inArray(schema.workspaces.id, workspaceIds));
    if (userIds.length)
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await ctx.close();
  });

  it("requires a user", async () => {
    expect((await call("GET", "/api/v1/projects")).statusCode).toBe(401);
    expect(
      (await call("POST", "/api/v1/projects", undefined, { name: "x" }))
        .statusCode,
    ).toBe(401);
  });

  it("creates a project with one empty, valid canvas in the caller's workspace", async () => {
    const a = await newUser("a");
    const response = await call(
      "POST",
      "/api/v1/projects",
      identity(a.userId),
      { name: "  First film " },
    );
    expect(response.statusCode).toBe(201);
    const { project } = createProjectResponseSchema.parse(response.json());
    expect(project).toMatchObject({
      name: "First film",
      workspaceId: a.workspaceId,
    });
    expect(project.canvases).toHaveLength(1);

    const url = `/api/v1/projects/${project.id}/canvases/${project.canvases[0]!.id}`;
    const canvas = await call("GET", url, identity(a.userId));
    expect(canvas.statusCode).toBe(200);
    const body = getCanvasResponseSchema.parse(canvas.json());
    expect(body.canvas).toMatchObject({ projectId: project.id, version: 0 });
    const doc = loadCanvasDoc(fromBase64(body.state));
    const snapshot = readSnapshot(doc);
    expect(snapshot).toEqual({ schemaVersion: 1, nodes: [], edges: [] });
    expect(validateSnapshot(snapshot, registry)).toEqual([]);
    // The row records who created it.
    const [row] = await db
      .select({ createdBy: schema.projects.createdBy })
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));
    expect(row!.createdBy).toBe(a.userId);
  });

  it("lists only projects of the caller's workspaces", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const mine = (
      await call("POST", "/api/v1/projects", identity(a.userId), {
        name: "Mine",
      })
    ).json().project;
    const theirs = (
      await call("POST", "/api/v1/projects", identity(b.userId), {
        name: "Theirs",
      })
    ).json().project;
    const list = projectListResponseSchema.parse(
      (await call("GET", "/api/v1/projects", identity(a.userId))).json(),
    );
    const ids = list.projects.map((p) => p.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(list.projects.find((p) => p.id === mine.id)!.canvases).toHaveLength(
      1,
    );
    expect(
      projectListResponseSchema
        .parse(
          (await call("GET", "/api/v1/projects", identity(b.userId))).json(),
        )
        .projects.map((p) => p.id),
    ).not.toContain(mine.id);
  });

  it("defaults to the oldest workspace and accepts an explicit member workspace", async () => {
    const a = await newUser("a");
    const later = await createWorkspace(
      db,
      a.userId,
      "later",
      new Date(Date.now() + 60_000),
    );
    workspaceIds.push(later);
    const first = (
      await call("POST", "/api/v1/projects", identity(a.userId), { name: "P1" })
    ).json().project;
    expect(first.workspaceId).toBe(a.workspaceId);
    const explicit = await call(
      "POST",
      "/api/v1/projects",
      identity(a.userId),
      {
        name: "P2",
        workspaceId: later,
      },
    );
    expect(explicit.statusCode).toBe(201);
    expect(explicit.json().project.workspaceId).toBe(later);
  });

  it("answers 404 for a workspace the caller is not a member of", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const response = await call(
      "POST",
      "/api/v1/projects",
      identity(a.userId),
      {
        name: "Sneaky",
        workspaceId: b.workspaceId,
      },
    );
    expect(response.statusCode).toBe(404);
    const rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.workspaceId, b.workspaceId));
    expect(rows).toEqual([]);
    // a workspace that does not exist looks the same
    expect(
      (
        await call("POST", "/api/v1/projects", identity(a.userId), {
          name: "x",
          workspaceId: "00000000-0000-4000-8000-000000000000",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("validates the body", async () => {
    const a = await newUser("a");
    for (const body of [
      {},
      { name: "   " },
      { name: "x".repeat(121) },
      { name: "x", workspaceId: "not-a-uuid" },
    ])
      expect(
        (await call("POST", "/api/v1/projects", identity(a.userId), body))
          .statusCode,
        JSON.stringify(body),
      ).toBe(400);
  });
});
