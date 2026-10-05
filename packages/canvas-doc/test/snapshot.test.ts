import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { canvasSnapshotSchema } from "@creative/contracts";
import { registry } from "@creative/node-registry";
import {
  InvalidStateError,
  ORIGIN,
  SCHEMA_VERSION,
  UnsupportedSchemaError,
  addNode,
  connect,
  createCanvasDoc,
  edgesOf,
  encodeState,
  fromBase64,
  inspectState,
  isPersistableOrigin,
  loadCanvasDoc,
  metaOf,
  nodesOf,
  readSnapshot,
  toBase64,
  transact,
  validateSnapshot,
} from "../src";
import { buildDemoDoc, demoSnapshot } from "../src/fixtures";
import { at, testRegistry } from "./helpers";

const codes = (snapshot: unknown, reg = registry) =>
  validateSnapshot(snapshot, reg).map((issue) => issue.code);
const clone = () => structuredClone(demoSnapshot);

describe("snapshot", () => {
  it("is stable, sorted and free of runtime or viewport state", () => {
    const doc = createCanvasDoc();
    addNode(doc, "user", { id: "z", type: "text", position: at() });
    addNode(doc, "user", { id: "a", type: "text", position: at() });
    const snapshot = readSnapshot(doc);
    expect(snapshot.nodes.map((n) => n.id)).toEqual(["a", "z"]);
    expect(JSON.stringify(readSnapshot(doc))).toBe(JSON.stringify(snapshot));
    const json = JSON.stringify(readSnapshot(buildDemoDoc()));
    expect(json).not.toContain('"status"');
    expect(json).not.toContain('"viewport"');
    expect(readSnapshot(buildDemoDoc())).toEqual(demoSnapshot);
  });

  it("the strict schema rejects status, viewport and unknown keys", () => {
    expect(canvasSnapshotSchema.safeParse(demoSnapshot).success).toBe(true);
    const withStatus = clone();
    (withStatus.nodes[0] as Record<string, unknown>).status = "ready";
    expect(canvasSnapshotSchema.safeParse(withStatus).success).toBe(false);
    expect(
      canvasSnapshotSchema.safeParse({
        ...demoSnapshot,
        viewport: { x: 0, y: 0, zoom: 1 },
      }).success,
    ).toBe(false);
    expect(
      canvasSnapshotSchema.safeParse({ ...demoSnapshot, canvasId: "c" })
        .success,
    ).toBe(false);
    expect(codes(withStatus)).toEqual(["invalid-shape"]);
  });

  it("round-trips through encode and load", () => {
    const doc = buildDemoDoc();
    const loaded = loadCanvasDoc(encodeState(doc));
    expect(readSnapshot(loaded)).toEqual(readSnapshot(doc));
    expect(metaOf(loaded).get("schemaVersion")).toBe(SCHEMA_VERSION);
  });

  it("base64 round-trips large payloads", () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64(new Uint8Array())).toBe("");
  });
});

describe("validateSnapshot", () => {
  it("accepts the demo and an empty canvas", () => {
    expect(codes(demoSnapshot)).toEqual([]);
    expect(codes(readSnapshot(createCanvasDoc()))).toEqual([]);
  });

  it("flags unknown node types and versions", () => {
    const a = clone();
    a.nodes[0]!.type = "video.generate";
    expect(codes(a)).toContain("unknown-node-type");
    const b = clone();
    b.nodes[0]!.version = 7;
    expect(codes(b)).toContain("unknown-node-type");
  });

  it("flags invalid config without echoing it", () => {
    const secret = "TOP-SECRET-PROMPT";
    const s = clone();
    s.nodes[1]!.config = { prompt: secret, aspectRatio: "4:3" };
    const issues = validateSnapshot(s, registry);
    expect(issues).toEqual([
      { code: "invalid-config", path: ["nodes", 1, "config"] },
    ]);
    expect(JSON.stringify(issues)).not.toContain(secret);
    const extra = clone();
    extra.nodes[0]!.config = { text: "", surprise: true };
    expect(codes(extra)).toEqual(["invalid-config"]);
  });

  it("flags bad edges", () => {
    const dangling = clone();
    dangling.edges[0]!.target = "ghost";
    dangling.edges[0]!.id = "text-1:text->ghost:prompt";
    expect(codes(dangling)).toEqual(["unknown-node"]);

    const port = clone();
    port.edges[0]!.targetHandle = "nope";
    port.edges[0]!.id = "text-1:text->image-1:nope";
    expect(codes(port)).toEqual(["unknown-port"]);

    const mismatch = clone();
    mismatch.edges[0] = {
      id: "image-1:image->text-1:text",
      source: "image-1",
      sourceHandle: "image",
      target: "text-1",
      targetHandle: "text",
    };
    expect(codes(mismatch)).toEqual(["unknown-port"]);

    const wrongId = clone();
    wrongId.edges[0]!.id = "something-else";
    expect(codes(wrongId)).toEqual(["edge-id"]);

    const dup = clone();
    dup.edges.push({ ...dup.edges[0]! });
    expect(codes(dup)).toEqual(["duplicate-edge"]);

    const dupNode = clone();
    dupNode.nodes.push({ ...dupNode.nodes[0]! });
    expect(codes(dupNode)).toContain("duplicate-node");
  });

  it("flags self-loops and cycles", () => {
    const doc = createCanvasDoc();
    for (const id of ["a", "b"])
      addNode(
        doc,
        "agent",
        { id, type: "text.transform", position: at() },
        testRegistry,
      );
    const snapshot = readSnapshot(doc);
    const edge = (s: string, t: string) => ({
      id: `${s}:out->${t}:in`,
      source: s,
      sourceHandle: "out",
      target: t,
      targetHandle: "in",
    });
    expect(
      codes({ ...snapshot, edges: [edge("a", "a")] }, testRegistry),
    ).toEqual(["self-loop"]);
    expect(
      codes(
        { ...snapshot, edges: [edge("a", "b"), edge("b", "a")] },
        testRegistry,
      ),
    ).toEqual(["cycle"]);
    // the same snapshot against the shipped registry: the node type is unknown there
    expect(codes({ ...snapshot, edges: [] })).toContain("unknown-node-type");
  });

  it("rejects non-objects without throwing", () => {
    for (const input of [null, 1, "x", [], {}])
      expect(codes(input)).toEqual(expect.arrayContaining(["invalid-shape"]));
  });
});

describe("loading untrusted state", () => {
  it("rejects a newer schema version", () => {
    const doc = createCanvasDoc();
    transact(doc, ORIGIN.load, () =>
      metaOf(doc).set("schemaVersion", SCHEMA_VERSION + 1),
    );
    expect(() => loadCanvasDoc(encodeState(doc))).toThrow(
      UnsupportedSchemaError,
    );
    expect(inspectState(encodeState(doc), registry)).toEqual({
      ok: false,
      issues: [{ code: "unsupported-schema", path: [] }],
    });
  });

  it("rejects garbage, empty state and missing or invalid schema version", () => {
    expect(() => loadCanvasDoc(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(
      InvalidStateError,
    );
    expect(() => loadCanvasDoc(new Uint8Array())).toThrow(InvalidStateError);
    const noMeta = new Y.Doc();
    noMeta.getMap("nodes");
    expect(() => loadCanvasDoc(Y.encodeStateAsUpdate(noMeta))).toThrow(
      InvalidStateError,
    );
    const bad = createCanvasDoc();
    transact(bad, ORIGIN.load, () => metaOf(bad).set("schemaVersion", "1"));
    expect(() => loadCanvasDoc(encodeState(bad))).toThrow(InvalidStateError);
  });

  it("rejects root keys of the wrong type", () => {
    const doc = new Y.Doc();
    doc.getMap("meta").set("schemaVersion", 1);
    doc.getArray("nodes").push([1]);
    expect(inspectState(Y.encodeStateAsUpdate(doc), registry).ok).toBe(false);
    const stray = createCanvasDoc();
    stray.getMap("hidden").set("k", "v");
    expect(inspectState(Y.encodeStateAsUpdate(stray), registry).ok).toBe(false);
  });

  it("inspectState flags structurally invalid content", () => {
    const doc = buildDemoDoc();
    transact(doc, ORIGIN.load, () => {
      nodesOf(doc).set("loose", "not a map" as never);
      edgesOf(doc).set("junk", 5 as never);
    });
    const result = inspectState(encodeState(doc), registry);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.every((i) => i.code === "invalid-shape")).toBe(true);
  });

  it("inspectState accepts a valid document and returns its snapshot", () => {
    const result = inspectState(encodeState(buildDemoDoc()), registry);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot).toEqual(demoSnapshot);
  });
});

describe("origins", () => {
  it("treats everything but load and remote as worth saving", () => {
    expect(isPersistableOrigin(ORIGIN.user)).toBe(true);
    expect(isPersistableOrigin(ORIGIN.agent)).toBe(true);
    expect(isPersistableOrigin(ORIGIN.repair)).toBe(true);
    expect(
      isPersistableOrigin(new Y.UndoManager(new Y.Doc().getMap("x"))),
    ).toBe(true);
    expect(isPersistableOrigin(ORIGIN.load)).toBe(false);
    expect(isPersistableOrigin(ORIGIN.remote)).toBe(false);
  });
  it("connect writes edges that survive a state round trip", () => {
    const doc = createCanvasDoc();
    addNode(doc, "user", { id: "t", type: "text", position: at() });
    addNode(doc, "user", { id: "i", type: "image.generate", position: at() });
    connect(doc, "user", {
      source: "t",
      sourceHandle: "text",
      target: "i",
      targetHandle: "prompt",
    });
    expect(readSnapshot(loadCanvasDoc(encodeState(doc))).edges).toHaveLength(1);
  });
});
