import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import { z } from "zod";
import { schema } from "@creative/database";
import {
  ORIGIN,
  addNode,
  connect,
  createCanvasDoc,
  edgesOf,
  encodeState,
  fromBase64,
  loadCanvasDoc,
  metaOf,
  nodesOf,
  readSnapshot,
  toBase64,
  transact,
} from "@creative/canvas-doc";
import { buildDemoDoc, demoSnapshot } from "@creative/canvas-doc/fixtures";
import {
  createRegistry,
  defineNode,
  nodeDefinitions,
} from "@creative/node-registry";
import {
  createTestApp,
  createUserWithWorkspace,
  signedHeaders,
  testDatabaseUrl,
} from "./helpers";

const databaseUrl = testDatabaseUrl();
type Identity = Parameters<typeof signedHeaders>[2];

/** text in, text out: the shipped example nodes cannot form a cycle, this one can. */
const transformNode = defineNode({
  type: "text.transform",
  version: 1,
  inputs: [{ id: "in", type: "text" }],
  outputs: [{ id: "out", type: "text" }],
  config: z.strictObject({}),
});
const registry = createRegistry([...nodeDefinitions, transformNode]);

const stateOf = (doc: Y.Doc) => toBase64(encodeState(doc));
const SECRET = "SECRET-PROMPT-DO-NOT-ECHO";

describe.skipIf(!databaseUrl)("canvases (Postgres)", () => {
  const ctx = createTestApp(databaseUrl, { registry });
  const { app, db } = ctx;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const who = (userId: string): Identity => ({ authType: "jwt", userId });

  const call = (
    method: "GET" | "POST" | "PUT",
    url: string,
    identity?: Identity,
    body?: unknown,
    raw?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...signedHeaders(method, url, identity),
        ...(body !== undefined || raw !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      payload: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });

  async function setup(label: string) {
    const user = await createUserWithWorkspace(db, label);
    workspaceIds.push(user.workspaceId);
    userIds.push(user.userId);
    const created = (
      await call("POST", "/api/v1/projects", who(user.userId), { name: label })
    ).json().project as { id: string; canvases: { id: string }[] };
    const base = `/api/v1/projects/${created.id}/canvases/${created.canvases[0]!.id}`;
    return {
      ...user,
      projectId: created.id,
      canvasId: created.canvases[0]!.id,
      base,
    };
  }
  const row = async (canvasId: string) =>
    (
      await db
        .select()
        .from(schema.canvases)
        .where(eq(schema.canvases.id, canvasId))
    )[0]!;

  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    if (workspaceIds.length)
      await db
        .delete(schema.workspaces)
        .where(inArray(schema.workspaces.id, workspaceIds));
    if (userIds.length)
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await ctx.close();
  });

  it("saves a valid state: version + 1, snapshot derived by the server, state round-trips", async () => {
    const a = await setup("a");
    const response = await call("PUT", `${a.base}/state`, who(a.userId), {
      baseVersion: 0,
      state: stateOf(buildDemoDoc()),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(1);

    const got = (await call("GET", a.base, who(a.userId))).json();
    expect(got.canvas.version).toBe(1);
    expect(readSnapshot(loadCanvasDoc(fromBase64(got.state)))).toEqual(
      demoSnapshot,
    );

    const snap = await call("GET", `${a.base}/snapshot`, who(a.userId));
    expect(snap.statusCode).toBe(200);
    expect(snap.json()).toEqual({ version: 1, snapshot: demoSnapshot });
    // Neither run-time status nor viewport is persisted anywhere.
    const stored = await row(a.canvasId);
    expect(JSON.stringify(stored.snapshot)).not.toMatch(/"status"|"viewport"/);
    expect(stored.updatedBy).toBe(a.userId);
    expect(stored.schemaVersion).toBe(1);
  });

  it("ignores a client-supplied snapshot: only the state is stored", async () => {
    const a = await setup("a");
    const response = await call("PUT", `${a.base}/state`, who(a.userId), {
      baseVersion: 0,
      state: stateOf(buildDemoDoc()),
      snapshot: { schemaVersion: 1, nodes: [], edges: [], status: "hacked" },
    });
    expect(response.statusCode).toBe(200);
    expect((await row(a.canvasId)).snapshot).toEqual(demoSnapshot);
  });

  describe("authorization: other workspaces see 404", () => {
    it("GET, PUT and snapshot answer 404 to a user who is not a member", async () => {
      const a = await setup("a");
      const b = await setup("b");
      const before = await row(a.canvasId);
      expect((await call("GET", a.base, who(b.userId))).statusCode).toBe(404);
      expect(
        (await call("GET", `${a.base}/snapshot`, who(b.userId))).statusCode,
      ).toBe(404);
      const put = await call("PUT", `${a.base}/state`, who(b.userId), {
        baseVersion: 0,
        state: stateOf(buildDemoDoc()),
      });
      expect(put.statusCode).toBe(404);
      // 404 even for an invalid state: nothing about the payload is looked at first.
      expect(
        (
          await call("PUT", `${a.base}/state`, who(b.userId), {
            baseVersion: 0,
            state: "AAAA",
          })
        ).statusCode,
      ).toBe(404);
      const after = await row(a.canvasId);
      expect(after.version).toBe(before.version);
      expect(
        Buffer.from(after.yjsState).equals(Buffer.from(before.yjsState)),
      ).toBe(true);
    });

    it("answers 404 when project and canvas do not belong together", async () => {
      const a = await setup("a");
      const other = (
        await call("POST", "/api/v1/projects", who(a.userId), {
          name: "second",
        })
      ).json().project;
      const crossed = `/api/v1/projects/${other.id}/canvases/${a.canvasId}`;
      expect((await call("GET", crossed, who(a.userId))).statusCode).toBe(404);
      expect(
        (
          await call("PUT", `${crossed}/state`, who(a.userId), {
            baseVersion: 0,
            state: stateOf(createCanvasDoc()),
          })
        ).statusCode,
      ).toBe(404);
      const missing = `/api/v1/projects/${a.projectId}/canvases/${randomUUID()}`;
      expect((await call("GET", missing, who(a.userId))).statusCode).toBe(404);
    });

    it("lets any workspace member in, and shuts them out again when removed", async () => {
      const a = await setup("a");
      const b = await createUserWithWorkspace(db, "b");
      workspaceIds.push(b.workspaceId);
      userIds.push(b.userId);
      expect((await call("GET", a.base, who(b.userId))).statusCode).toBe(404);
      await db.insert(schema.workspace_members).values({
        workspace_id: a.workspaceId,
        userId: b.userId,
        role: "member",
        createdAt: new Date(),
      });
      expect((await call("GET", a.base, who(b.userId))).statusCode).toBe(200);
      expect(
        (
          await call("PUT", `${a.base}/state`, who(b.userId), {
            baseVersion: 0,
            state: stateOf(buildDemoDoc()),
          })
        ).statusCode,
      ).toBe(200);
      await db
        .delete(schema.workspace_members)
        .where(
          and(
            eq(schema.workspace_members.workspace_id, a.workspaceId),
            eq(schema.workspace_members.userId, b.userId),
          ),
        );
      expect((await call("GET", a.base, who(b.userId))).statusCode).toBe(404);
      expect(
        (
          await call("PUT", `${a.base}/state`, who(b.userId), {
            baseVersion: 1,
            state: stateOf(buildDemoDoc()),
          })
        ).statusCode,
      ).toBe(404);
    });

    it("rejects ids that are not uuids and anonymous callers", async () => {
      const a = await setup("a");
      const bad = "/api/v1/projects/x/canvases/y";
      expect((await call("GET", bad, who(a.userId))).statusCode).toBe(400);
      expect((await call("GET", a.base)).statusCode).toBe(401);
      expect((await call("GET", `${a.base}/snapshot`)).statusCode).toBe(401);
    });
  });

  describe("optimistic locking", () => {
    it("answers 409 with the current version for a stale baseVersion", async () => {
      const a = await setup("a");
      const save = (baseVersion: number) =>
        call("PUT", `${a.base}/state`, who(a.userId), {
          baseVersion,
          state: stateOf(buildDemoDoc()),
        });
      expect((await save(0)).statusCode).toBe(200);
      const stale = await save(0);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ currentVersion: 1 });
      const ahead = await save(5);
      expect(ahead.statusCode).toBe(409);
      expect((await save(1)).json().version).toBe(2);
      expect((await row(a.canvasId)).version).toBe(2);
    });

    it("lets exactly one of two concurrent saves from the same base version win", async () => {
      const a = await setup("a");
      const doc1 = buildDemoDoc();
      const doc2 = buildDemoDoc();
      addNode(doc2, "user", {
        id: "extra",
        type: "text",
        position: { x: 1, y: 1 },
      });
      const results = await Promise.all(
        [doc1, doc2].map((doc) =>
          call("PUT", `${a.base}/state`, who(a.userId), {
            baseVersion: 0,
            state: stateOf(doc),
          }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect((await row(a.canvasId)).version).toBe(1);
    });
  });

  describe("rejects invalid Yjs state with 422 and changes nothing", () => {
    async function expectRejected(
      a: Awaited<ReturnType<typeof setup>>,
      doc: Y.Doc | Uint8Array,
      code?: string,
    ) {
      const before = await row(a.canvasId);
      const response = await call("PUT", `${a.base}/state`, who(a.userId), {
        baseVersion: 0,
        state: doc instanceof Uint8Array ? toBase64(doc) : stateOf(doc),
      });
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.error).toBe("Invalid canvas state");
      if (code)
        expect(body.issues.map((i: { code: string }) => i.code)).toContain(
          code,
        );
      // Codes and paths only: never the user's content.
      expect(response.body).not.toContain(SECRET);
      const after = await row(a.canvasId);
      expect(after.version).toBe(0);
      expect(
        Buffer.from(after.yjsState).equals(Buffer.from(before.yjsState)),
      ).toBe(true);
      expect(after.snapshot).toEqual(before.snapshot);
    }

    it("edge with a missing endpoint", async () => {
      const a = await setup("a");
      const doc = buildDemoDoc();
      transact(doc, ORIGIN.load, () =>
        edgesOf(doc).set("text-1:text->ghost:prompt", {
          source: "text-1",
          sourceHandle: "text",
          target: "ghost",
          targetHandle: "prompt",
        }),
      );
      await expectRejected(a, doc, "unknown-node");
    });

    it("cycle", async () => {
      const a = await setup("a");
      const doc = createCanvasDoc();
      for (const id of ["n1", "n2"])
        addNode(
          doc,
          "agent",
          { id, type: "text.transform", position: { x: 0, y: 0 } },
          registry,
        );
      connect(
        doc,
        "agent",
        { source: "n1", sourceHandle: "out", target: "n2", targetHandle: "in" },
        registry,
      );
      transact(doc, ORIGIN.load, () =>
        edgesOf(doc).set("n2:out->n1:in", {
          source: "n2",
          sourceHandle: "out",
          target: "n1",
          targetHandle: "in",
        }),
      );
      await expectRejected(a, doc, "cycle");
    });

    it("unknown node type and version", async () => {
      const a = await setup("a");
      const doc = buildDemoDoc();
      transact(doc, ORIGIN.load, () => {
        const node = new Y.Map<unknown>();
        node.set("type", "video.generate");
        node.set("version", 1);
        node.set("title", "Video");
        node.set("position", { x: 0, y: 0 });
        node.set("config", new Y.Map());
        nodesOf(doc).set("video-1", node);
      });
      await expectRejected(a, doc, "unknown-node-type");
    });

    it("invalid config, without echoing it", async () => {
      const a = await setup("a");
      const doc = buildDemoDoc();
      transact(doc, ORIGIN.load, () =>
        (nodesOf(doc).get("image-1")!.get("config") as Y.Map<unknown>).set(
          "prompt",
          SECRET + "x".repeat(5000),
        ),
      );
      await expectRejected(a, doc, "invalid-config");
    });

    it("port type mismatch", async () => {
      const a = await setup("a");
      const doc = createCanvasDoc();
      addNode(
        doc,
        "agent",
        { id: "i", type: "image.generate", position: { x: 0, y: 0 } },
        registry,
      );
      addNode(
        doc,
        "agent",
        { id: "t", type: "text.transform", position: { x: 0, y: 0 } },
        registry,
      );
      transact(doc, ORIGIN.load, () =>
        edgesOf(doc).set("i:image->t:in", {
          source: "i",
          sourceHandle: "image",
          target: "t",
          targetHandle: "in",
        }),
      );
      await expectRejected(a, doc, "port-type-mismatch");
    });

    it("a newer schema version, garbage bytes and structurally wrong documents", async () => {
      const a = await setup("a");
      const future = buildDemoDoc();
      transact(future, ORIGIN.load, () =>
        metaOf(future).set("schemaVersion", 2),
      );
      await expectRejected(a, future, "unsupported-schema");
      await expectRejected(
        a,
        new Uint8Array([1, 2, 3, 4, 5, 6]),
        "invalid-state",
      );
      await expectRejected(a, new Uint8Array(), "invalid-state");
      const wrongRoot = new Y.Doc();
      wrongRoot.getMap("meta").set("schemaVersion", 1);
      wrongRoot.getArray("nodes").push(["x"]);
      await expectRejected(a, Y.encodeStateAsUpdate(wrongRoot));
    });
  });

  it("answers 400 for malformed base64 and bodies", async () => {
    const a = await setup("a");
    for (const body of [
      { baseVersion: 0, state: "not base64!" },
      { baseVersion: 0 },
      { state: "AAAA" },
      { baseVersion: -1, state: "AAAA" },
      { baseVersion: 0, state: "A".repeat(1_000_004) },
    ])
      expect(
        (await call("PUT", `${a.base}/state`, who(a.userId), body)).statusCode,
        JSON.stringify(body).slice(0, 60),
      ).toBe(400);
    expect(
      (await call("PUT", `${a.base}/state`, who(a.userId), undefined, "{nope"))
        .statusCode,
    ).toBe(400);
  });

  it("answers 413 beyond the body limit", async () => {
    const a = await setup("a");
    const response = await call("PUT", `${a.base}/state`, who(a.userId), {
      baseVersion: 0,
      state: "A".repeat(1_100_000),
    });
    expect(response.statusCode).toBe(413);
    expect((await row(a.canvasId)).version).toBe(0);
  });
});
